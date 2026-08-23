// In-memory search over the recipe corpus and the user list.
//
// This replaces Algolia, which was only ever used by the Explore tab's search
// bar. At ~143 recipes the whole corpus fits comfortably in memory, so an
// external search service was buying index infrastructure we don't need and
// charging a staleness cost we were paying in full: nothing indexed at
// runtime, so a recipe was unsearchable until someone remembered to run a
// backfill script by hand.
//
// Searching locally means results are never stale, there is no second system
// to keep in sync, and a search misconfiguration can no longer take down the
// entire API at boot.

import MiniSearch from 'minisearch';
import { adminAuth, fs } from './firebase';

export interface RecipeHit {
  id: string;
  name: string;
  description: string;
  photoURL?: string | null;
  tags: string[];
}

export interface UserHit {
  /** Named objectID for the client's UserSearchResult, inherited from Algolia. */
  objectID: string;
  displayName: string;
  photoURL: string | null;
  email: string;
}

/**
 * How long a built index is served before a rebuild. Long enough that a burst
 * of searches costs one read of the corpus, short enough that a newly saved
 * recipe shows up without anyone doing anything. Recipe writes also bust it
 * explicitly, so this is the backstop rather than the mechanism.
 */
const TTL_MS = 5 * 60_000;

/**
 * Edit budget as a fraction of term length. Below five characters there is no
 * budget at all — at that size almost any word is within one edit of another,
 * and the result is noise rather than tolerance.
 */
const FUZZ = (term: string) => (term.length <= 4 ? 0 : term.length <= 6 ? 0.2 : 0.3);

interface Built {
  at: number;
  recipeIndex: MiniSearch<RecipeHit & { ingredients: string }>;
  userIndex: MiniSearch<UserHit>;
  recipesById: Map<string, RecipeHit>;
  usersById: Map<string, UserHit>;
}

let built: Built | null = null;
/** Single-flight: a burst of searches on a cold instance builds once, not N times. */
let building: Promise<Built> | null = null;

async function loadRecipes() {
  // instructions are deliberately not fetched — they are the bulk of a recipe
  // document and nobody searches for a numbered step.
  const snap = await fs.collection('recipes')
    .select('name', 'description', 'tags', 'photoURL', 'ingredients', 'visibility')
    .get();

  return snap.docs.filter((d) => {
    // Search shows other people's recipes, so it answers to the same rule
    // Explore does. Absent means public: everything written before the field
    // existed was already findable here.
    return (d.data() ?? {}).visibility !== 'private';
  }).map((d) => {
    const data = d.data() ?? {};
    const ingredients = Array.isArray(data.ingredients)
      ? data.ingredients.map((i: any) => String(i?.name ?? '')).filter(Boolean).join(' ')
      : '';
    return {
      id: d.id,
      name: String(data.name ?? ''),
      description: String(data.description ?? ''),
      photoURL: data.photoURL ?? null,
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      // Indexed but never returned: it makes "chicken" or "chickpeas" find the
      // dishes that use them, which Algolia never did because the backfill
      // script only sent name/description/tags.
      ingredients,
    };
  });
}

async function loadUsers(): Promise<UserHit[]> {
  const users: UserHit[] = [];
  let pageToken: string | undefined;
  do {
    const page = await adminAuth.listUsers(1000, pageToken);
    for (const u of page.users) {
      // Anonymous accounts have no email and no display name worth searching —
      // the same filter the old backfill script applied.
      if (!u.email) continue;
      users.push({
        objectID: u.uid,
        displayName: u.displayName ?? '',
        photoURL: u.photoURL ?? null,
        email: u.email,
      });
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

async function build(): Promise<Built> {
  const [recipes, users] = await Promise.all([loadRecipes(), loadUsers()]);

  const recipeIndex = new MiniSearch<RecipeHit & { ingredients: string }>({
    fields: ['name', 'tags', 'ingredients', 'description'],
    storeFields: ['id'],
    // Boosts encode what a match in each field is worth: a hit on the title is
    // what you meant, a hit in the description is usually incidental.
    searchOptions: { boost: { name: 4, tags: 3, ingredients: 2, description: 1 } },
  });
  recipeIndex.addAll(recipes);

  const userIndex = new MiniSearch<UserHit>({
    fields: ['displayName', 'email'],
    storeFields: ['objectID'],
    idField: 'objectID',
    searchOptions: { boost: { displayName: 3, email: 1 } },
  });
  userIndex.addAll(users);

  return {
    at: Date.now(),
    recipeIndex,
    userIndex,
    recipesById: new Map(recipes.map((r) => [r.id, { ...r, ingredients: undefined as never }])),
    usersById: new Map(users.map((u) => [u.objectID, u])),
  };
}

async function getIndex(): Promise<Built> {
  if (built && Date.now() - built.at < TTL_MS) return built;
  if (building) return building;
  building = build()
    .then((b) => { built = b; return b; })
    .finally(() => { building = null; });
  return building;
}

/** Called when the corpus changes, so a new recipe is searchable immediately. */
export function invalidateSearchIndex() {
  built = null;
}

/**
 * Widening ladder, strictly most-precise first, stopping as soon as there are
 * enough hits — so a precise query never reaches the loose strategies.
 *
 * `substring` is injected by the caller between the tight and loose rungs.
 * Order matters: a tokeniser cannot match inside a word, so "sagne" only finds
 * Lasagna via the substring scan — but the loose OR+fuzzy rung will happily
 * return something unrelated first if it runs earlier. Precision before reach.
 */
function runSearch<T>(
  index: MiniSearch<T>,
  query: string,
  limit: number,
  substring?: (have: Set<string>) => string[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (results: { id: string }[]) => {
    for (const r of results) {
      if (seen.size >= limit) return;
      const id = String(r.id);
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
  };

  // 1. Every term matches. Prefix handles "lasag" -> "Lasagne".
  push(index.search(query, { prefix: true, combineWith: 'AND' }));
  if (seen.size >= limit) return ids;

  // 2. Exact substring anywhere in the text, for the match a tokeniser cannot
  //    make: "sagne" is really in "Lasagna" and nowhere else. This sits ABOVE
  //    fuzzy deliberately — an exact run of characters is stronger evidence
  //    than an approximate token, and with fuzzy first a short query like
  //    "sagne" matches "Tagine" and buries the answer.
  if (substring) {
    for (const id of substring(seen)) {
      if (seen.size >= limit) break;
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    if (seen.size >= limit) return ids;
  }

  // 3. Tolerate typos, with the edit budget scaled to term length. A flat rate
  //    cannot serve both ends: 0.2 is too mean for a transposition ("chikcen"
  //    needs two edits, and 0.2 of seven characters affords one), while 0.3 on
  //    a five-letter term matched 70 of 143 recipes — "sagne" pulled in
  //    "Tagine" and everything else within two edits. Short terms get no fuzz.
  push(index.search(query, { prefix: true, fuzzy: FUZZ, combineWith: 'AND' }));
  if (seen.size >= limit) return ids;

  // 4. Any term may match, so a multi-word query still returns its best parts.
  push(index.search(query, { prefix: true, fuzzy: FUZZ, combineWith: 'OR' }));
  return ids;
}

export async function searchRecipes(query: string, limit = 10): Promise<RecipeHit[]> {
  const { recipeIndex, recipesById } = await getIndex();
  const q = query.trim();
  if (!q) return [];
  const needle = q.toLowerCase();

  const ids = runSearch(recipeIndex, q, limit, (have) => {
    const out: string[] = [];
    for (const [id, r] of recipesById) {
      if (have.has(id)) continue;
      if (`${r.name} ${r.tags.join(' ')}`.toLowerCase().includes(needle)) out.push(id);
    }
    return out;
  });

  return ids.map((id) => recipesById.get(id)).filter(Boolean).slice(0, limit) as RecipeHit[];
}

export async function searchUsers(query: string, limit = 3): Promise<UserHit[]> {
  const { userIndex, usersById } = await getIndex();
  const q = query.trim();
  if (!q) return [];
  const ids = runSearch(userIndex, q, limit);
  return ids.map((id) => usersById.get(id)).filter(Boolean).slice(0, limit) as UserHit[];
}
