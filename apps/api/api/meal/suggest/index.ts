import { Hono } from 'hono';
import { FieldPath } from 'firebase-admin/firestore';
import { auth } from '@/middleware/auth';
import { requireAccount } from '@/middleware/requireAccount';
import { fs } from '@/utils/firebase';
import { normalizeIngredients } from '@/utils/quantity';
import { normalizeRecipeServings } from '@/utils/servings';
import { completeJson, models } from '@/utils/claude';
import {
  quantityFormatRules,
  servingsRules,
  recipeSchema,
  recipeWritingRules,
  tagVocabulary,
} from '@/utils/recipePrompts';

// --- Types ---
export interface Ingredient {
  name: string;
  quantity: string;
}

export interface Recipe {
  id: string;
  photoURL?: string;
  name: string;
  description: string;
  ingredients: Ingredient[];
  instructions: string[];
}

interface MealPreferences {
  dietaryNeeds?: string[];
  dislikedIngredients?: string[] | string;
  // Legacy fields, still on older user documents. Deliberately NOT read as
  // constraints any more — see the note on hints below.
  cookingStyles?: string[];
  cuisines?: string[];
  query?: string;
}

interface SuggestionTurn {
  role: 'user' | 'assistant';
  text: string;
}

interface SuggestionRequestBody {
  vetoedTitles?: string[];
  /** Present field replaces the stored one, for this request only. */
  overrides?: {
    dietaryNeeds?: string[];
    dislikedIngredients?: string;
  };
  hints?: string[];
  query?: string;
  conversation?: SuggestionTurn[];
}

const route = new Hono();

// ---------------------------------------------------------------------------
// Variety
//
// Temperature was never the constraint here (it defaults to 1.0 and the old
// code never touched it). The constraint was that every request sent a prompt
// with no distinguishing features, so the model landed in the same
// neighbourhood of dish-space every time. Sampling a few axes server-side and
// stating them in one line moves the starting point without growing the prompt.
// ---------------------------------------------------------------------------

const COOKING_METHODS = [
  'sheet-pan roasting', 'a single skillet', 'braising', 'grilling or broiling',
  'stir-frying', 'a soup or stew pot', 'the slow cooker', 'baking',
  'poaching or steaming', 'no cooking at all (assembly only)', 'pan-searing then finishing in the oven',
];

const EFFORT_LEVELS = [
  'a 30-minute weeknight, minimal prep',
  'about an hour, some chopping',
  'mostly hands-off — the oven or pot does the work',
  'a weekend cook worth taking time over',
];

const CUISINE_POOL = [
  'italian', 'mexican', 'american', 'mediterranean', 'indian', 'thai',
  'japanese', 'chinese', 'korean', 'middle eastern', 'french', 'greek',
  'spanish', 'vietnamese', 'caribbean', 'north african',
];

/**
 * Protein slots, one per suggested recipe.
 *
 * The model left to itself skews vegetarian well past what this app's own
 * corpus looks like (37 of 143 recipes are tagged vegetarian; 117 are comfort
 * food). Naming the slot for each recipe fixes the mix instead of hoping for
 * it — and keeps the plant-forward option present rather than absent.
 *
 * A slot is either a plain list, where every option is equally likely, or a
 * map of option to relative weight. Weights only ever compare WITHIN their own
 * slot, so the omnivore slots can be tuned without disturbing the others: an
 * even split served a whole roast chicken or a turkey half the time the
 * poultry slot came up, where this audience nearly always wants the thighs or
 * the breast.
 */
type ProteinSlot = readonly string[] | Readonly<Record<string, number>>;

const PROTEIN_SLOTS: Record<string, ProteinSlot[]> = {
  omnivore: [
    { 'chicken thighs': 3, 'chicken breast': 3, 'a whole roast chicken': 1, 'turkey': 1 },
    { 'ground beef': 3, 'a beef steak or roast': 2, 'pork chops': 2, 'pork shoulder': 2, 'sausage': 2 },
    ['white fish', 'salmon', 'shrimp', 'beans or lentils', 'eggs', 'tofu or paneer'],
  ],
  pescatarian: [
    ['white fish', 'salmon', 'tuna'],
    ['shrimp', 'mussels or clams', 'squid', 'crab'],
    ['beans or lentils', 'eggs', 'tofu or paneer', 'a vegetable as the centrepiece'],
  ],
  vegetarian: [
    ['beans, lentils or chickpeas', 'eggs', 'paneer or halloumi'],
    ['tofu or tempeh', 'mushrooms as the centrepiece', 'a hearty grain'],
    ['a roasted vegetable as the centrepiece', 'cheese-forward', 'nuts or seeds for substance'],
  ],
  vegan: [
    ['beans, lentils or chickpeas', 'tofu or tempeh'],
    ['mushrooms as the centrepiece', 'a hearty grain', 'nuts or seeds for substance'],
    ['a roasted vegetable as the centrepiece', 'squash or root vegetables', 'cauliflower or aubergine'],
  ],
};

const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

/** A slot's options as [option, weight]; a plain list is every weight at 1. */
const weighted = (slot: ProteinSlot): [string, number][] =>
  Array.isArray(slot)
    ? (slot as readonly string[]).map((name) => [name, 1])
    : Object.entries(slot as Record<string, number>);

function pickProtein(slot: ProteinSlot): string {
  const options = weighted(slot);
  const total = options.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * total;
  for (const [name, weight] of options) {
    roll -= weight;
    if (roll < 0) return name;
  }
  // Only reachable on floating-point crumbs at the very top of the range.
  return options[options.length - 1]![0];
}

/** Fisher-Yates, on a copy — the slot tables are module-level and shared. */
function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** vegan beats vegetarian beats pescatarian — the strictest wins. */
function dietOf(needs: string[] = []): keyof typeof PROTEIN_SLOTS {
  const lower = needs.map((n) => n.toLowerCase());
  if (lower.some((n) => n.includes('vegan'))) return 'vegan';
  if (lower.some((n) => n.includes('vegetarian'))) return 'vegetarian';
  if (lower.some((n) => n.includes('pescatarian'))) return 'pescatarian';
  return 'omnivore';
}

// ---------------------------------------------------------------------------
// Corpus seeding
//
// The app already holds ~140 real recipes people chose to save. That
// distribution is a better description of "what people round here cook" than
// anything a prompt can assert, so a sample of it goes in as register — the
// point is the neighbourhood, explicitly not the dishes themselves.
// ---------------------------------------------------------------------------

const CORPUS_SAMPLE = 8;
const COOKBOOK_SAMPLE = 8;

/** Random-cursor sample over document IDs — same trick /api/explore uses. */
async function sampleCorpusNames(n: number): Promise<string[]> {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let randomKey = '';
  for (let i = 0; i < 20; i++) randomKey += chars.charAt(Math.floor(Math.random() * chars.length));

  const forward = await fs
    .collection('recipes')
    .where(FieldPath.documentId(), '>=', randomKey)
    .select('name')
    .limit(n)
    .get();

  const names = forward.docs.map((d) => d.data()?.name).filter(Boolean) as string[];

  if (names.length < n) {
    const wrap = await fs
      .collection('recipes')
      .where(FieldPath.documentId(), '<', randomKey)
      .select('name')
      .limit(n - names.length)
      .get();
    names.push(...(wrap.docs.map((d) => d.data()?.name).filter(Boolean) as string[]));
  }
  return names;
}

async function cookbookNames(uid: string, n: number): Promise<string[]> {
  const snap = await fs
    .collection('users').doc(uid).collection('cookbook')
    .orderBy('addedAt', 'desc')
    .select('name')
    .limit(n)
    .get();
  return snap.docs.map((d) => d.data()?.name).filter(Boolean) as string[];
}

// ---------------------------------------------------------------------------
// Recently suggested
//
// This list used to live in React state on the modal, which meant it emptied
// every time the sheet closed: a daily user got the same three dinners every
// day and the veto only held for as long as they kept re-rolling. Persisting it
// on the user doc is what makes "don't show me that again" mean anything.
// ---------------------------------------------------------------------------

/** ~15 rounds of history. Long enough to force variety, short enough that a good dish can come back. */
const RECENT_TITLES_CAP = 45;

const suggestionsSchema = {
  type: 'object',
  properties: {
    recipes: { type: 'array', items: recipeSchema },
  },
  required: ['recipes'],
  additionalProperties: false,
} as const;

// Stable across every request, so it carries the prompt-cache breakpoint.
// Everything that varies — seeds, slots, corpus sample, vetoes — goes in the
// user turn, where a change costs one turn instead of the whole prefix.
const systemPrompt = `
You are a recipe assistant suggesting exactly 3 recipes someone will actually
cook. Dinners, unless the request asks for something else.

The three must be genuinely distinct from one another — different primary
protein, different cooking method, different flavour profile. Three variations
on a theme is a failed suggestion set.

Aim for food that is appealing and specific rather than clever: a real dish with
a real name, not a fusion invention. Assume an ordinary supermarket and an
ordinary kitchen unless the request says otherwise.

${recipeWritingRules}
${tagVocabulary}
${quantityFormatRules}
${servingsRules}
Like the generation path, you are inventing these dishes rather than reading
them off a source, so "servings" is never null here — write for 4 and say 4.
`;

route.use('*', auth, requireAccount);

route.post('/', async (c) => {
  const uid = c.get('uid') as string;

  // Only the parse is guarded. Anything else inside this try would have its
  // throw swallowed and answer 200 with an unsteered — but fully billed — set.
  let body: SuggestionRequestBody | null = null;
  try {
    body = await c.req.json<SuggestionRequestBody>();
  } catch {
    // Empty or invalid body is fine — there just aren't any vetoes.
  }

  // Session vetoes from the current re-roll; merged with the persisted history.
  // Bounded: this is client-supplied and goes straight into the prompt, so an
  // unbounded list is somebody else's token bill.
  // Everything below is client-supplied and goes straight into the prompt, so
  // each field is bounded — an unbounded list is somebody else's token bill.
  const strings = (v: unknown, max: number, len: number): string[] =>
    Array.isArray(v)
      ? v.filter((t): t is string => typeof t === 'string' && t.length > 0).slice(0, max).map((t) => t.slice(0, len))
      : [];

  const sessionVetoes = strings(body?.vetoedTitles, 60, 200);
  const hints = strings(body?.hints, 12, 60);
  const query = typeof body?.query === 'string' ? body.query.trim().slice(0, 500) : '';

  const conversation: SuggestionTurn[] = Array.isArray(body?.conversation)
    ? body.conversation
        .filter((t): t is SuggestionTurn =>
          !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.length > 0)
        .slice(-8)
        .map((t) => ({ role: t.role, text: t.text.slice(0, 500) }))
    : [];

  const userRef = fs.collection('users').doc(uid);
  const userDoc = await userRef.get();
  const userData = userDoc.data();

  if (!userDoc.exists || !userData?.preferences) {
    return c.json({ error: 'Meal preferences not set.', action: 'redirect_to_preferences' }, 404);
  }

  const stored = userData.preferences as MealPreferences;
  const storedRecent: string[] = Array.isArray(userData?.mealSuggestions?.recentTitles)
    ? userData.mealSuggestions.recentTitles
    : [];

  // A PRESENT override field replaces the stored one for this request only, and
  // is never written back. Present-and-empty is the whole point: it is how "I am
  // vegan, but tonight I'm cooking for my family" reaches the model.
  const overrides = body?.overrides;
  const dietaryNeeds = overrides && 'dietaryNeeds' in overrides
    ? strings(overrides.dietaryNeeds, 12, 60)
    : (stored.dietaryNeeds ?? []);

  const storedDisliked = Array.isArray(stored.dislikedIngredients)
    ? stored.dislikedIngredients.join(', ')
    : stored.dislikedIngredients;
  const disliked = overrides && 'dislikedIngredients' in overrides
    ? String(overrides.dislikedIngredients ?? '').trim().slice(0, 500)
    : storedDisliked;

  // Dedupe case-insensitively; a re-roll and the stored history overlap heavily.
  const avoid = [...storedRecent, ...sessionVetoes].reduce<string[]>((acc, title) => {
    if (!acc.some((t) => t.toLowerCase() === title.toLowerCase())) acc.push(title);
    return acc;
  }, []);

  // Seeds exist to stop every request landing in the same neighbourhood of
  // dish-space. They are a substitute for direction, so when the person has
  // actually given direction — hints or a typed request — every seed drops
  // from instruction to tie-breaker rather than arguing with it. See the
  // steered branch below for why stating that explicitly is what matters.
  const steered = hints.length > 0 || query.length > 0;
  const seeds = {
    cuisine: pick(CUISINE_POOL),
    method: pick(COOKING_METHODS),
    effort: pick(EFFORT_LEVELS),
  };

  // Shuffled, because the slots are a spread and not a running order: a fixed
  // one made every set read poultry, then red meat, then fish or beans, all
  // the way down, and the first suggestion is the one people actually look at.
  const slots = PROTEIN_SLOTS[dietOf(dietaryNeeds)]!;
  const composition = shuffle(slots.map(pickProtein))
    .map((protein, i) => `  ${i + 1}. built around ${protein}`)
    .join('\n');

  const [corpus, cookbook] = await Promise.all([
    sampleCorpusNames(CORPUS_SAMPLE).catch(() => [] as string[]),
    cookbookNames(uid, COOKBOOK_SAMPLE).catch(() => [] as string[]),
  ]);

  // Dinners are the default and stay the default. But the word cannot be
  // asserted in the same turn that tells the model the request outranks the
  // course — two lines that argue, and the opener wins on position alone.
  const parts: string[] = [steered ? 'Suggest 3 recipes.' : 'Suggest 3 dinners.', ''];

  if (steered) {
    // The seeds have to be demoted OUT LOUD, not merely stated before the
    // request. An imperative composition plus a quoted aside loses on a PARTIAL
    // conflict: "an appetizer built around sausage" is plausible enough that
    // both get honoured and the answer comes back a main course. A total
    // conflict — "a birthday cake built around sausage" — throws the
    // composition out on its own, which is why the same prompt handles cake
    // well and the appetizer badly. Naming the composition as outranked is what
    // makes the near-miss resolve the same way the impossible one already does.
    parts.push(
      'Left to itself, and purely for variety, this set would have been composed so:',
      composition,
      `  ...with ${seeds.method} used somewhere in the set.`,
      '',
      'Treat all of that as a tie-breaker, never a requirement. What they ask for',
      'below outranks every part of it, the course included — an appetizer, a side,',
      'a dessert or a bake is what they get if that is what they asked for. Where a',
      'slot does not suit the request, drop the slot; do not bend the request to fit.',
      '',
    );
  } else {
    parts.push(
      'Compose the set like this:',
      composition,
      '',
      `Somewhere in the set, use ${seeds.method}.`,
      `Let one of the three lean ${seeds.cuisine}.`,
      `Pitch the effort at: ${seeds.effort}.`,
      '',
    );
  }

  if (dietaryNeeds.length) parts.push(`Dietary needs (hard constraints): ${dietaryNeeds.join(', ')}.`);
  if (disliked) parts.push(`Must NOT contain: ${disliked}.`);

  // Hints and the typed request are what the person wants TONIGHT, so they are
  // stated last and stated loudest — a stored preference should never outrank
  // the thing they just asked for.
  if (hints.length) parts.push(`They are in the mood for: ${hints.join(', ')}.`);
  if (query) parts.push(`In their words: "${query}"`);

  if (conversation.length) {
    parts.push(
      '',
      'Earlier in this conversation:',
      ...conversation.map((t) => `  ${t.role === 'user' ? 'They said' : 'You suggested'}: ${t.text}`),
      'Treat the latest request as a refinement of that, not a fresh start.',
    );
  }

  if (cookbook.length) {
    parts.push('', `Dishes they have saved to their own cookbook: ${cookbook.join(', ')}.`);
  }
  if (corpus.length) {
    parts.push(
      `Dishes other people on this app save: ${corpus.join(', ')}.`,
      'Those two lists are the register to aim for, not a menu to copy — do not suggest any of them.',
    );
  }

  if (avoid.length) {
    parts.push('', `Recently suggested to this person — do not repeat or closely echo: ${avoid.join(', ')}.`);
  }

  try {
    const result = await completeJson<{ recipes: Omit<Recipe, 'id'>[] }>({
      model: models.mealSuggest,
      system: systemPrompt,
      user: parts.join('\n'),
      schema: suggestionsSchema,
      effort: 'medium',
    });

    const recipes = (result.recipes ?? []).map((r) => normalizeRecipeServings({
      ...r,
      ingredients: normalizeIngredients(r.ingredients),
    }));

    if (recipes.length === 0) throw new Error('Claude returned no recipes.');

    // Roll the history forward. Best-effort: a failed write costs variety on
    // the next call, which is not worth failing a good suggestion over.
    const nextRecent = [...storedRecent, ...recipes.map((r) => r.name)].slice(-RECENT_TITLES_CAP);
    userRef
      .set({ mealSuggestions: { recentTitles: nextRecent } }, { merge: true })
      .catch((e) => console.error('Failed to persist suggestion history:', e));

    return c.json(recipes);
  } catch (error) {
    console.error('AI suggestion failed:', error);
    return c.json({ error: 'Failed to generate a meal suggestion.' }, 500);
  }
});

export default route;
