import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { requireAccount } from '@/middleware/requireAccount';
import { fs } from '@/utils/firebase';
import { normalizeIngredients } from '@/utils/quantity';
import { normalizeRecipeServings } from '@/utils/servings';
import { completeJson, models } from '@/utils/claude';
import { generatedRecipeSchema, recipeGenerationSystemPrompt } from '@/utils/recipePrompts';

// POST /api/recipe/generate
// Body: { title: "Chicken Katsu Curry" }
//
// Writes a recipe from nothing but its name and returns the same Recipe shape
// as the two importers, so the client hands the result to the identical
// review-and-edit screen. Someone who has typed a meal into their plan has
// already said what they want to eat; this saves them hunting for a link to a
// dish they can already name.

const route = new Hono();

/**
 * A dish name, not an essay. This string goes straight into the prompt, and
 * the field it comes from is a meal title — anything longer is either a paste
 * or someone using the box as a free-text channel into the model.
 */
const MAX_TITLE_CHARS = 200;

interface MealPreferences {
  dietaryNeeds?: string[];
  dislikedIngredients?: string[] | string;
}

/**
 * Diet and dislikes only. The rest of the preferences steer /meal/suggest
 * towards a dish to cook, and that question is already answered here — the
 * user named the dish. All that is left to honour is what they can't eat.
 */
async function dietaryContext(uid: string): Promise<string[]> {
  const snap = await fs.collection('users').doc(uid).get();
  const preferences = snap.data()?.preferences as MealPreferences | undefined;
  if (!preferences) return [];

  const lines: string[] = [];
  if (preferences.dietaryNeeds?.length) {
    lines.push(
      `Dietary needs (hard constraints): ${preferences.dietaryNeeds.join(', ')}.`,
      'Adapt the dish to meet them rather than refusing it, and say so in the description.',
    );
  }
  const disliked = Array.isArray(preferences.dislikedIngredients)
    ? preferences.dislikedIngredients.join(', ')
    : preferences.dislikedIngredients;
  if (disliked) lines.push(`Must NOT contain: ${disliked}.`);
  return lines;
}

route.use('*', auth, requireAccount);

route.post('/', async (c) => {
  const uid = c.get('uid') as string;

  let body: { title?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!title) {
    return c.json({ error: 'title is required' }, 400);
  }
  if (title.length > MAX_TITLE_CHARS) {
    return c.json({ error: 'That title is too long to write a recipe from.' }, 400);
  }

  // Best-effort: a preferences read that fails costs a less personal recipe,
  // which is not worth failing the request over. Unlike /meal/suggest, this
  // route works perfectly well for someone who never set any.
  const constraints = await dietaryContext(uid).catch((e) => {
    console.error('Could not read preferences for recipe generation:', e);
    return [] as string[];
  });

  const userTurn = [
    `Write a complete recipe for: ${title}`,
    ...(constraints.length ? ['', ...constraints] : []),
  ].join('\n');

  try {
    // Higher effort than the importers get. There is no source document to fall
    // back on, so getting the quantities to balance is the model's own work.
    const { found, recipe } = await completeJson<{ found: boolean; recipe: any }>({
      model: models.recipeGenerate,
      system: recipeGenerationSystemPrompt,
      user: userTurn,
      schema: generatedRecipeSchema,
      effort: 'medium',
    });

    if (!found || !recipe) {
      return c.json({ error: 'RECIPE_NOT_FOUND' }, 422);
    }

    // An invented dish has never been photographed. Say so explicitly rather
    // than leaving the field absent — the client treats a missing photoURL and
    // a null one differently when it decides whether to offer the picker.
    recipe.photoURL = null;
    recipe.ingredients = normalizeIngredients(recipe.ingredients);
    // The prompt tells this path never to answer null — it chose the amounts,
    // so it knows who they feed — but a dropped field must still degrade to
    // "unscaled" rather than to a guess. See normalizeRecipeServings.
    normalizeRecipeServings(recipe);
    return c.json(recipe);
  } catch (error) {
    console.error('Recipe generation failed:', error);
    return c.json({ error: 'Failed to write a recipe for that.' }, 500);
  }
});

export default route;
