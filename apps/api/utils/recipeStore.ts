import { fs } from './firebase'
import { invalidateSearchIndex } from './searchIndex'
import { normalizeIngredients } from './quantity'
import { parseServings } from '@fridgie/shared/servings'
import { guessRecipeCategory, normalizeRecipeCategory, type RecipeCategory } from './recipeCategory'
import type { Ingredient, Recipe } from './types'

/** What a caller outside the app — the Claude connector — may say about a new recipe. */
export interface NewRecipeInput {
  name: string
  description?: string
  ingredients: Ingredient[]
  instructions?: string[]
  servings?: number
  totalMinutes?: number
  tags?: string[]
  category?: string
}

/**
 * The document stored for a recipe someone asked an assistant to write for
 * them.
 *
 * Private, because it has no public original: the Explore rule is that only a
 * recipe with a `sourceKey` may be shown to strangers, and nothing an assistant
 * wrote for one person has one. The owner can still publish it from the app.
 *
 * Quantities go through the same normalizer as every importer, so the list the
 * ingredients land on can aggregate and convert them.
 */
export function toStoredRecipe(input: NewRecipeInput, uid: string, now = new Date()) {
  const ingredients = normalizeIngredients(
    (input.ingredients ?? [])
      .map((i) => ({ name: String(i?.name ?? '').trim(), quantity: String(i?.quantity ?? '').trim() }))
      .filter((i) => i.name),
  )
  const instructions = (input.instructions ?? []).map((s) => String(s).trim()).filter(Boolean)
  const tags = [...new Set((input.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))]

  const doc: Record<string, unknown> = {
    name: input.name.trim(),
    description: (input.description ?? '').trim(),
    ingredients,
    instructions,
    visibility: 'private',
    createdBy: uid,
    createdAt: now,
  }
  const servings = parseServings(input.servings)
  if (servings) doc.servings = servings
  if (typeof input.totalMinutes === 'number' && input.totalMinutes > 0) {
    doc.totalMinutes = Math.round(input.totalMinutes)
  }
  if (tags.length) doc.tags = tags

  // No model call on this path, like POST /api/recipe: a stated category is
  // kept if it is one of ours, otherwise the title decides where it can, and
  // the cookbook fetch files whatever is still unfiled.
  const category: RecipeCategory | null =
    normalizeRecipeCategory(input.category) ?? guessRecipeCategory({ name: doc.name as string, description: doc.description as string, tags })
  if (category) doc.category = category

  return doc
}

/** Creates the recipe and returns it as the client would see it. */
export async function createRecipe(uid: string, input: NewRecipeInput): Promise<Recipe> {
  const data = toStoredRecipe(input, uid)
  const ref = await fs.collection('recipes').add(data)
  invalidateSearchIndex()
  return { id: ref.id, ...data } as unknown as Recipe
}

/** A recipe by id, or null. Callers decide who may see it. */
export async function getRecipeDoc(recipeId: string): Promise<(Recipe & Record<string, any>) | null> {
  const snap = await fs.collection('recipes').doc(recipeId).get()
  if (!snap.exists) return null
  return { id: snap.id, ...snap.data() } as Recipe & Record<string, any>
}
