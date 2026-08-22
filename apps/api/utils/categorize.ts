import { LexoRank } from 'lexorank';
import { v4 as uuid } from 'uuid';
import { adminRtdb } from './firebase';
import { completeJson, models } from './claude';
import {
  buildCategoryIndex,
  cacheKeysFor,
  canonicalKey,
  findCategory,
  normalizeItemText,
  type CategoryIndex,
} from './itemMatch';
import {
  compareSections,
  isBlankItem,
  isRealItem,
  placeItems,
  type PlaceableItem,
} from './sections';
import { FALLBACK_SECTION, overrideSection, SECTIONS } from './aisles';

// The aisle list and the items filed into them by hand live in ./aisles, which
// keeps them free of Firebase and of the model client. Re-exported so this
// stays the one place a caller has to know about.
export { FALLBACK_SECTION, SECTIONS };
export { isBlankItem, isRealItem, normalizeItemText };

// An invented section name would fall through to the "Other" bucket below; as
// an enum the schema simply won't allow one.
const categorizationSchema = {
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: [...SECTIONS] },
          items: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'items'],
        additionalProperties: false,
      },
    },
  },
  required: ['sections'],
  additionalProperties: false,
} as const;

const categorizeSystemPrompt = `
You sort grocery items into supermarket sections.
Sort by the aisle a supermarket shelves the item in, not by what it is made of
or what it gets eaten with: fresh dips and spreads are refrigerated by the deli,
flatbreads are with the bread, and Snacks & Candy is packaged snacking food only.
Copy each item's text through to the output exactly as given — do not rename,
correct, pluralise, or tidy it. Every item must appear in exactly one section.
Only include sections that end up with at least one item.
`;

const CACHE_PATH = 'itemCategoryCache';

/**
 * Categorization now runs on every add rather than only when the user taps
 * Sort, and each run used to download the whole cache node first. Holding the
 * snapshot briefly turns a burst of adds into one read.
 *
 * Going stale is harmless by construction: the worst a miss can do is send an
 * item to the model that another instance had already resolved, and writes
 * merge into the held copy so this process always sees its own results.
 */
const CACHE_TTL_MS = 60_000;
let cachedIndex: { index: CategoryIndex; cache: Record<string, string>; at: number } | null = null;

async function loadCategoryIndex(): Promise<CategoryIndex> {
  const now = Date.now();
  if (cachedIndex && now - cachedIndex.at < CACHE_TTL_MS) return cachedIndex.index;

  const snap = await adminRtdb.ref(CACHE_PATH).once('value');
  const cache: Record<string, string> = snap.val() || {};
  const index = buildCategoryIndex(cache);
  cachedIndex = { index, cache, at: now };
  return index;
}

/**
 * Persists resolved categories and folds them into the in-process snapshot.
 *
 * Best-effort: by the time this runs the answer is already in hand, and failing
 * to write the cache only costs the next caller a model call. Letting it throw
 * would throw that answer away too.
 */
async function rememberCategories(updates: Record<string, string>): Promise<void> {
  if (Object.keys(updates).length === 0) return;
  if (cachedIndex) {
    Object.assign(cachedIndex.cache, updates);
    cachedIndex.index = buildCategoryIndex(cachedIndex.cache);
  }
  try {
    await adminRtdb.ref(CACHE_PATH).update(updates);
  } catch (error) {
    console.error('Could not write the item category cache:', error);
  }
}

/** Drops the held cache snapshot; the next resolve re-reads it. */
export function resetCategoryCache(): void {
  cachedIndex = null;
}

/**
 * The section for every distinct text in `texts`.
 *
 * The hand-filed items in ./aisles answer first, then the cache — the literal
 * wording, then its canonical form, then a near-miss spelling — and only what is
 * left over is sent to the model, in a single call. Anything the model declines
 * to place is absent from the result; callers decide what that means.
 *
 * Throws only if the model call itself fails.
 */
export async function resolveCategories(texts: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const distinct = [...new Set(texts.map((t) => String(t ?? '')).filter((t) => t.trim() !== ''))];
  if (distinct.length === 0) return resolved;

  const index = await loadCategoryIndex();
  const unknown: string[] = [];
  const backfill: Record<string, string> = {};

  for (const text of distinct) {
    // Ahead of the cache, deliberately. Every item on that list is one the model
    // has been seen to get wrong, so an entry sitting in the cache for it is far
    // more likely to be that wrong answer than a correction of it.
    const override = overrideSection(text);
    if (override) {
      resolved.set(text, override);
      // Rewrite a cached answer that disagrees, rather than leaving it there for
      // some near-miss spelling to fuzzy-match onto later. An item the cache has
      // never seen is left alone: the override answers it for free anyway.
      for (const key of cacheKeysFor(text)) {
        if (index.byKey.has(key) && index.byKey.get(key) !== override) {
          backfill[key] = override;
        }
      }
      continue;
    }

    const match = findCategory(text, index);
    if (!match) {
      unknown.push(text);
      continue;
    }
    resolved.set(text, match.section);
    // A hit on the legacy whitespace-stripped key teaches us nothing about the
    // next phrasing of the same item; writing the canonical key back migrates
    // the entry the first time it is used.
    if (match.source === 'exact' && !index.byKey.has(canonicalKey(text))) {
      for (const key of cacheKeysFor(text)) backfill[key] = match.section;
    }
  }

  if (unknown.length > 0) {
    const parsed: { sections: { name: string; items: string[] }[] } = await completeJson({
      model: models.categorize,
      system: categorizeSystemPrompt,
      user: `Sort these items:\n${JSON.stringify(unknown)}`,
      schema: categorizationSchema,
      effort: 'low',
    });

    // The model is told to copy text through verbatim; when it tidies one
    // anyway, match it back to what we asked about by canonical form so the
    // answer is not thrown away.
    const byCanonical = new Map(unknown.map((text) => [canonicalKey(text), text]));

    for (const section of parsed.sections ?? []) {
      if (!section?.name || !Array.isArray(section.items)) continue;
      for (const returned of section.items) {
        const text = byCanonical.get(canonicalKey(String(returned ?? ''))) ?? String(returned ?? '');
        if (!text.trim()) continue;
        resolved.set(text, section.name);
        for (const key of cacheKeysFor(text)) backfill[key] = section.name;
      }
    }
  }

  await rememberCategories(backfill);
  return resolved;
}

/**
 * Files `itemIds` into their aisles without disturbing the rest of the list.
 *
 * This is the path every add takes — typing a row, saving a recipe, generating
 * a meal plan — so it must stay cheap and must not re-decide, re-rank or
 * re-heading anything the user is not touching.
 *
 * Throws if the model call fails — callers decide whether that is fatal.
 */
export async function categorizeNewItems(
  items: PlaceableItem[],
  itemIds: string[],
): Promise<PlaceableItem[]> {
  const wanted = new Set(itemIds);
  const targets = items.filter((i) => wanted.has(i.id) && isRealItem(i));
  if (targets.length === 0) return items.map((i) => ({ ...i }));

  const resolved = await resolveCategories(targets.map((i) => String(i.text ?? '')));

  const placements = new Map<string, string>();
  for (const item of targets) {
    // An item the model refused to place still has to leave the "not yet
    // sorted" pile, or the client asks about it again on every render.
    placements.set(item.id, resolved.get(String(item.text ?? '')) ?? FALLBACK_SECTION);
  }

  return placeItems(items, placements);
}

/**
 * Sorts `sourceItems` into supermarket sections and returns a fresh, fully
 * ranked items array: a section header row followed by its members, sections
 * alphabetical, anything the model dropped under a trailing "Other", and the
 * blank placeholders last so they stay outside every section.
 *
 * This is the "Sort by Category" button — it re-decides the whole list. Adding
 * an item goes through `categorizeNewItems` instead.
 *
 * Existing item objects are carried through untouched apart from `listOrder`
 * and `section`, so quantities, `mealId` and override fields all survive.
 *
 * Throws if the model call fails — callers decide whether that is fatal.
 */
export async function categorizeItems(
  sourceItems: PlaceableItem[],
  blankItems: PlaceableItem[] = [],
): Promise<PlaceableItem[]> {
  if (sourceItems.length === 0) return blankItems.map((i) => ({ ...i }));

  const resolved = await resolveCategories(sourceItems.map((i) => String(i.text ?? '')));

  // A list can legitimately hold the same text twice (two meals both needing
  // onions), so group by section rather than by text and keep every object.
  const bySection = new Map<string, PlaceableItem[]>();
  for (const item of sourceItems) {
    const section = resolved.get(String(item.text ?? '')) ?? FALLBACK_SECTION;
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section)!.push(item);
  }

  let rank = LexoRank.middle();
  const nextRank = () => {
    const value = rank.toString();
    rank = rank.genNext();
    return value;
  };

  // "Other" is not an aisle; it is where the unplaceable ends up, so it goes
  // last rather than alphabetically between Meat and Pantry.
  const names = [...bySection.keys()]
    .filter((name) => name !== FALLBACK_SECTION)
    .sort(compareSections);
  if (bySection.has(FALLBACK_SECTION)) names.push(FALLBACK_SECTION);

  const newItems: PlaceableItem[] = [];
  for (const name of names) {
    newItems.push({
      id: uuid(),
      text: name,
      checked: false,
      isSection: true,
      listOrder: nextRank(),
    });
    for (const item of bySection.get(name)!) {
      newItems.push({ ...item, listOrder: nextRank(), section: name });
    }
  }

  // Blank placeholder rows go back on the end, outside any section.
  for (const item of blankItems) {
    const { section, ...rest } = item;
    newItems.push({ ...rest, listOrder: nextRank() });
  }

  return newItems;
}
