// Filing a recipe onto its shelf: Breakfast, Mains, Baked Goods, Desserts…
//
// The same shape as `utils/categorize.ts` does for grocery aisles, and for the
// same reason — a closed vocabulary the model is constrained to by an enum, a
// free local pass in front of it so the obvious cases never cost a call, and a
// persisted answer so nothing is ever decided twice.
//
// It differs in where the answer is CACHED. Grocery items repeat across every
// household, so their categories live in a shared RTDB cache keyed by item
// text. Recipes do not repeat — "Nonna's Sunday Gravy" is asked about once ever
// — so the recipe document is its own cache, and `category` written back onto
// it is what stops the next fetch re-deciding.

import { completeJson, models } from './claude';
import { fs } from './firebase';
import {
  FALLBACK_RECIPE_CATEGORY,
  RECIPE_CATEGORIES,
  guessRecipeCategory,
  normalizeRecipeCategory,
  type RecipeCategory,
} from '@fridgie/shared/recipeCategory';

export {
  FALLBACK_RECIPE_CATEGORY,
  RECIPE_CATEGORIES,
  guessRecipeCategory,
  normalizeRecipeCategory,
  type RecipeCategory,
};

/** What categorizing needs off a recipe. Everything else is noise to this question. */
export interface CategorizableRecipe {
  id: string;
  name?: string;
  description?: string;
  category?: unknown;
}

/**
 * Ceiling on recipes sent to the model in one request.
 *
 * A cookbook is fetched on every profile visit, and the first fetch after this
 * shipped has to file a whole shelf at once. The cap bounds that one call;
 * anything past it keeps its turn for the next fetch, because each run persists
 * what it resolved and so strictly shrinks the backlog.
 */
const MAX_PER_REQUEST = 100;

/** Descriptions run long and add nothing after the first line or two. */
const MAX_DESCRIPTION_CHARS = 240;

const categorySchema = {
  type: 'object',
  properties: {
    recipes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Copied through exactly as given.' },
          category: { type: 'string', enum: [...RECIPE_CATEGORIES] },
        },
        required: ['id', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['recipes'],
  additionalProperties: false,
} as const;

const systemPrompt = `
You file recipes into the one section of a cookbook each belongs in.

Judge what the dish IS and when it is eaten, not what is in it: a chicken salad
is a salad and a chicken pie is a main.
Sweet things served to finish a meal are Desserts. Breads, rolls, muffins,
scones, biscuits and pastries are Baked Goods even when they are sweet.
Anything served alongside a main rather than as one is a side.

Return exactly one entry for every id you are given, using that id verbatim, and
no ids you were not given. Use "Other" only for a recipe that genuinely belongs
to none of the other sections.
`;

/**
 * The category for every recipe in `recipes` that does not already have a valid
 * one, keyed by id.
 *
 * The title decides it for free wherever it can; only what is left over reaches
 * the model, in a single call. Recipes that already carry a category are absent
 * from the result — there is nothing to say about them — as is anything past
 * the per-request cap.
 *
 * Throws only if the model call itself fails.
 */
export async function resolveRecipeCategories(
  recipes: CategorizableRecipe[],
): Promise<Map<string, RecipeCategory>> {
  const resolved = new Map<string, RecipeCategory>();
  const unknown: CategorizableRecipe[] = [];

  for (const recipe of recipes) {
    if (!recipe?.id) continue;
    if (normalizeRecipeCategory(recipe.category)) continue;

    const guess = guessRecipeCategory(recipe);
    if (guess) resolved.set(recipe.id, guess);
    else unknown.push(recipe);
  }

  if (unknown.length === 0) return resolved;

  const batch = unknown.slice(0, MAX_PER_REQUEST);
  if (batch.length < unknown.length) {
    console.warn(
      `Recipe categorization capped: ${batch.length} of ${unknown.length} this request.`,
    );
  }

  const parsed: { recipes: { id: string; category: string }[] } = await completeJson({
    model: models.recipeCategorize,
    system: systemPrompt,
    user: `File these recipes:\n${JSON.stringify(
      batch.map((r) => ({
        id: r.id,
        name: String(r.name ?? ''),
        description: String(r.description ?? '').slice(0, MAX_DESCRIPTION_CHARS),
      })),
    )}`,
    schema: categorySchema,
    effort: 'low',
  });

  const asked = new Set(batch.map((r) => r.id));
  for (const answer of parsed.recipes ?? []) {
    // An id we never asked about is the model inventing work; the enum already
    // guarantees the category itself is one of ours.
    if (!answer?.id || !asked.has(answer.id)) continue;
    resolved.set(answer.id, normalizeRecipeCategory(answer.category) ?? FALLBACK_RECIPE_CATEGORY);
  }

  // A recipe the model skipped still has to stop being asked about, or every
  // future fetch pays for it again and it stays invisible to every filter.
  for (const recipe of batch) {
    if (!resolved.has(recipe.id)) resolved.set(recipe.id, FALLBACK_RECIPE_CATEGORY);
  }

  return resolved;
}

/**
 * Writes resolved categories back onto the recipe documents.
 *
 * Best-effort and per-document: the answers are already in the caller's hand,
 * so a failed write costs the next fetch a model call and nothing else. One
 * deleted recipe must not take the rest of the batch down with it, which is
 * exactly what a single `WriteBatch` would do.
 */
async function persistRecipeCategories(categories: Map<string, RecipeCategory>): Promise<void> {
  if (categories.size === 0) return;

  const writes = [...categories].map(([id, category]) =>
    fs.collection('recipes').doc(id).update({ category }),
  );
  const results = await Promise.allSettled(writes);

  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    console.warn(`Could not store ${failed} of ${categories.size} recipe categories.`);
  }
}

/**
 * Files every recipe that isn't filed yet, stores the answers, and hands them
 * back so the caller can serve them in this same response.
 *
 * NEVER throws. This runs inside a cookbook fetch, and a cookbook that fails to
 * load because a model was busy is a far worse outcome than one whose newest
 * recipes have no category chip for another minute.
 */
export async function fileRecipes(
  recipes: CategorizableRecipe[],
): Promise<Map<string, RecipeCategory>> {
  try {
    const resolved = await resolveRecipeCategories(recipes);
    await persistRecipeCategories(resolved);
    return resolved;
  } catch (error) {
    console.error('Recipe categorization failed:', error);
    return new Map();
  }
}
