import { Hono } from 'hono';
import { FieldPath } from 'firebase-admin/firestore';
import { auth } from '@/middleware/auth';
import { fs } from '@/utils/firebase';
import { normalizeIngredients } from '@/utils/quantity';
import { completeJson, models } from '@/utils/claude';
import {
  quantityFormatRules,
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
  cookingStyles?: string[];
  cuisines?: string[];
  dislikedIngredients?: string[] | string;
  query?: string;
}

interface SuggestionRequestBody {
  vetoedTitles?: string[];
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
 */
const PROTEIN_SLOTS: Record<string, string[][]> = {
  omnivore: [
    ['chicken thighs', 'chicken breast', 'a whole roast chicken', 'turkey'],
    ['ground beef', 'a beef steak or roast', 'pork chops', 'pork shoulder', 'sausage'],
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
You are a recipe assistant suggesting exactly 3 dinners someone will actually cook.

The three must be genuinely distinct from one another — different primary
protein, different cooking method, different flavour profile. Three variations
on a theme is a failed suggestion set.

Aim for food that is appealing and specific rather than clever: a real dish with
a real name, not a fusion invention. Assume an ordinary supermarket and an
ordinary kitchen unless the request says otherwise.

${recipeWritingRules}
${tagVocabulary}
${quantityFormatRules}
`;

route.use('*', auth);

route.post('/', async (c) => {
  const uid = c.get('uid') as string;

  // Session vetoes from the current re-roll; merged with the persisted history.
  let sessionVetoes: string[] = [];
  try {
    const body = await c.req.json<SuggestionRequestBody>();
    if (Array.isArray(body?.vetoedTitles)) sessionVetoes = body.vetoedTitles.filter(Boolean);
  } catch {
    // Empty or invalid body is fine — there just aren't any vetoes.
  }

  const userRef = fs.collection('users').doc(uid);
  const userDoc = await userRef.get();
  const userData = userDoc.data();

  if (!userDoc.exists || !userData?.preferences) {
    return c.json({ error: 'Meal preferences not set.', action: 'redirect_to_preferences' }, 404);
  }

  const preferences = userData.preferences as MealPreferences;
  const storedRecent: string[] = Array.isArray(userData?.mealSuggestions?.recentTitles)
    ? userData.mealSuggestions.recentTitles
    : [];

  // Dedupe case-insensitively; a re-roll and the stored history overlap heavily.
  const avoid = [...storedRecent, ...sessionVetoes].reduce<string[]>((acc, title) => {
    if (!acc.some((t) => t.toLowerCase() === title.toLowerCase())) acc.push(title);
    return acc;
  }, []);

  // Seeds. Cuisine leans on the user's stated preferences when they have any,
  // and otherwise roams — a fixed pool of three preferred cuisines is its own
  // kind of rut.
  const cuisinePool = preferences.cuisines?.length ? preferences.cuisines : CUISINE_POOL;
  const seeds = {
    cuisine: pick(cuisinePool),
    method: pick(COOKING_METHODS),
    effort: pick(EFFORT_LEVELS),
  };

  const slots = PROTEIN_SLOTS[dietOf(preferences.dietaryNeeds)]!;
  const composition = slots.map((slot, i) => `  ${i + 1}. built around ${pick(slot)}`).join('\n');

  const [corpus, cookbook] = await Promise.all([
    sampleCorpusNames(CORPUS_SAMPLE).catch(() => [] as string[]),
    cookbookNames(uid, COOKBOOK_SAMPLE).catch(() => [] as string[]),
  ]);

  const parts: string[] = ['Suggest 3 dinners.', ''];

  parts.push('Compose the set like this:', composition, '');
  parts.push(
    `Let one of the three lean ${seeds.cuisine}. Somewhere in the set, use ${seeds.method}.`,
    `Pitch the effort at: ${seeds.effort}.`,
    '',
  );

  if (preferences.dietaryNeeds?.length) parts.push(`Dietary needs (hard constraints): ${preferences.dietaryNeeds.join(', ')}.`);
  if (preferences.cookingStyles?.length) parts.push(`Preferred cooking styles: ${preferences.cookingStyles.join(', ')}.`);
  if (preferences.cuisines?.length) parts.push(`Cuisines they like: ${preferences.cuisines.join(', ')}.`);

  const disliked = Array.isArray(preferences.dislikedIngredients)
    ? preferences.dislikedIngredients.join(', ')
    : preferences.dislikedIngredients;
  if (disliked) parts.push(`Must NOT contain: ${disliked}.`);

  // Free text from the preferences screen. The old prompt builder declared this
  // field and then never read it, so anything typed here was silently dropped.
  if (preferences.query) parts.push(`In their words: ${preferences.query}`);

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

    const recipes = (result.recipes ?? []).map((r) => ({
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
