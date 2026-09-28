import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { RECIPE_CATEGORIES } from '@fridgie/shared/recipeCategory'
import type { DayOfWeek, Item, Meal, Recipe } from '@/utils/types'
import type { FridgieBackend, Household } from './backend'
import { DEFAULT_TIMEZONE, resolveWeek } from './weeks'

/** Who is calling, from their verified access token. */
export interface ToolContext {
  uid: string
  /** The household that was open in the app when the connection was made. */
  groupId?: string
  timezone?: string
  now?: () => Date
}

const DAYS: [DayOfWeek, ...DayOfWeek[]] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const SERVER_INSTRUCTIONS = `Fridgie is the user's weekly meal planner and shared grocery list app.

Use these tools whenever the user asks you to come up with meals, plan their week, or build a grocery/shopping list, and they want it in Fridgie (or have said to always use it).

Workflow:
1. Call get_meal_preferences first when suggesting meals, and never suggest something that breaks a dietary need or uses a disliked ingredient.
2. Call get_week_plan to see what's already planned and already on the list, so you don't duplicate it.
3. For each meal the user wants: call add_meal_to_plan with the full recipe. Its ingredients go on the grocery list automatically, scaled to the household and sorted into aisles — do NOT also add them with add_grocery_items.
4. For extra groceries that aren't part of a meal (snacks, household items, "add milk"), call add_grocery_items.
5. To reuse something the user already has saved, call search_cookbook and pass the recipe_id to add_meal_to_plan.

Formatting rules for ingredients and grocery items:
- name is what you'd see on a shelf, singular or plural as natural, without the amount: "yellow onion", "chicken thighs", "olive oil".
- quantity is the amount with a unit: "2", "1 cup", "500 g", "2 tbsp", "1 can". Omit it for "to taste" or pantry staples where the amount doesn't matter.
- Don't put preparation in the name ("diced", "minced") — that belongs in the instructions.

Weeks start on Sunday. "week" accepts "this", "next", or any date inside the target week (YYYY-MM-DD). Most users have one household; only pass household_id if the user has several and says which.

After adding things, tell the user briefly what was added and that it's in the Fridgie app now.`

const ingredientSchema = z.object({
  name: z.string().trim().min(1).max(120).describe('What to buy, without the amount — e.g. "yellow onion"'),
  quantity: z.string().trim().max(40).optional().describe('Amount and unit — e.g. "2", "1 cup", "500 g". Omit if not meaningful.'),
})

const recipeSchema = z.object({
  name: z.string().trim().min(1).max(120).describe('Dish name, e.g. "Sheet-pan lemon chicken"'),
  description: z.string().trim().max(500).optional().describe('One or two appetizing sentences'),
  servings: z.number().int().min(1).max(50).optional().describe('How many people the quantities feed'),
  ingredients: z.array(ingredientSchema).min(1).max(60),
  instructions: z.array(z.string().trim().min(1).max(1000)).max(40).optional().describe('Steps, one per entry, without numbering'),
  total_minutes: z.number().int().min(1).max(24 * 60).optional().describe('Total time including prep'),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional().describe('e.g. "vegetarian", "italian", "quick"'),
  category: z.enum(RECIPE_CATEGORIES).optional(),
})

type RecipeArg = z.infer<typeof recipeSchema>

const weekArg = z.string().trim().max(20).optional()
  .describe('"this" (default), "next", or any date YYYY-MM-DD inside the target week')
const householdArg = z.string().trim().max(128).optional()
  .describe('Household id from get_households. Omit to use the default household.')

class ToolError extends Error {}

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
})

const failure = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
})

/** Wraps a handler so an expected problem reads as a tool error, not a protocol failure. */
function guarded<A>(handler: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return json(await handler(args))
    } catch (error) {
      if (error instanceof ToolError) return failure(error.message)
      console.error('MCP tool failed:', error)
      return failure('Fridgie hit an unexpected error. Please try again in a moment.')
    }
  }
}

/** The rows a person would recognise as their grocery list: no headings, no blank rows. */
function groceryRows(items: Item[], meals: Meal[]) {
  const mealNames = new Map(meals.map((m) => [m.id, m.name]))
  return items
    .filter((i) => !i.isSection && String(i.text ?? '').trim())
    .sort((a, b) => (a.listOrder < b.listOrder ? -1 : a.listOrder > b.listOrder ? 1 : 0))
    .map((i) => ({
      name: i.text,
      ...(i.overrideQuantity || i.quantity ? { quantity: i.overrideQuantity || i.quantity } : {}),
      ...(i.checked ? { checked: true } : {}),
      ...(i.section ? { aisle: i.section } : {}),
      ...(i.mealId && mealNames.has(i.mealId) ? { for_meal: mealNames.get(i.mealId) } : {}),
    }))
}

const recipeSummary = (r: Recipe) => ({
  id: r.id,
  name: r.name,
  ...(r.category ? { category: r.category } : {}),
  ...(r.servings ? { servings: r.servings } : {}),
  ...(r.totalMinutes ? { total_minutes: r.totalMinutes } : {}),
  ...(r.tags?.length ? { tags: r.tags } : {}),
})

const toRecipeInput = (recipe: RecipeArg) => ({
  name: recipe.name,
  description: recipe.description,
  servings: recipe.servings,
  ingredients: recipe.ingredients.map((i) => ({ name: i.name, quantity: i.quantity ?? '' })),
  instructions: recipe.instructions,
  totalMinutes: recipe.total_minutes,
  tags: recipe.tags,
  category: recipe.category,
})

export function createFridgieMcpServer(ctx: ToolContext, backend: FridgieBackend): McpServer {
  const server = new McpServer(
    { name: 'fridgie', title: 'Fridgie', version: '1.0.0', websiteUrl: 'https://fridgie.ca' },
    { instructions: SERVER_INSTRUCTIONS },
  )
  const now = ctx.now ?? (() => new Date())
  const timezone = ctx.timezone || DEFAULT_TIMEZONE

  let households: Promise<Household[]> | null = null
  const myHouseholds = () => (households ??= backend.listHouseholds(ctx.uid))

  /** The household a call acts on: the one asked for, else the one linked from the app. */
  async function household(requested?: string): Promise<Household> {
    const mine = await myHouseholds()
    if (requested) {
      const found = mine.find((h) => h.id === requested)
      if (!found) throw new ToolError(`No household with id "${requested}". Call get_households to see the ones available.`)
      return found
    }
    const fallback = mine.find((h) => h.id === ctx.groupId)
      ?? (mine.length === 1 ? mine[0] : undefined)
      ?? mine.find((h) => h.isOwner)
      ?? mine[0]
    if (!fallback) throw new ToolError('This Fridgie account has no household yet. Open the Fridgie app once to set one up.')
    return fallback
  }

  async function week(groupId: string, requested?: string) {
    const resolved = resolveWeek(requested, timezone, now())
    if (!resolved.ok) throw new ToolError(resolved.error)
    const list = await backend.getWeekList(groupId, resolved.weekStart, resolved.legacyWeekStart)
    return { ...list, label: resolved.label }
  }

  server.registerTool('get_households', {
    title: 'List households',
    description: 'Lists the Fridgie households (shared lists) this user belongs to. Most users have exactly one; the default is marked.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async () => {
    const mine = await myHouseholds()
    const def = mine.length ? (await household()).id : null
    return {
      households: mine.map((h) => ({
        id: h.id,
        name: h.name,
        members: h.memberCount,
        ...(h.householdSize ? { cooks_for: h.householdSize } : {}),
        ...(h.id === def ? { default: true } : {}),
      })),
    }
  }))

  server.registerTool('get_meal_preferences', {
    title: 'Get meal preferences',
    description: 'The user\'s dietary needs and disliked ingredients, and how many people their household cooks for. Check this before suggesting meals.',
    inputSchema: { household_id: householdArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ household_id }: { household_id?: string }) => {
    const [prefs, home] = await Promise.all([backend.getPreferences(ctx.uid), household(household_id)])
    const disliked = prefs?.dislikedIngredients
    return {
      dietary_needs: prefs?.dietaryNeeds ?? [],
      disliked_ingredients: Array.isArray(disliked) ? disliked.join(', ') : (disliked ?? ''),
      household: home.name,
      cooks_for: home.householdSize ?? null,
      note: home.householdSize
        ? `Ingredients are scaled to ${home.householdSize} people automatically when a meal is added, based on the recipe's servings.`
        : 'Household size is not set, so ingredient amounts are added exactly as written.',
    }
  }))

  server.registerTool('get_week_plan', {
    title: 'Get week plan',
    description: 'Shows the meals planned and everything on the grocery list for a week (Sunday to Saturday).',
    inputSchema: { week: weekArg, household_id: householdArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ week: w, household_id }: { week?: string; household_id?: string }) => {
    const home = await household(household_id)
    const list = await week(home.id, w)
    return {
      household: home.name,
      week: list.label,
      week_start: list.weekStart,
      meals: list.meals.map((m) => ({
        name: m.name,
        ...(m.dayOfWeek ? { day: m.dayOfWeek } : {}),
        ...(m.recipeId ? { recipe_id: m.recipeId } : {}),
      })),
      groceries: groceryRows(list.items, list.meals),
    }
  }))

  server.registerTool('search_cookbook', {
    title: 'Search cookbook',
    description: 'Finds recipes the user has saved in their Fridgie cookbook. Use a recipe_id from here with add_meal_to_plan.',
    inputSchema: {
      query: z.string().trim().max(100).optional().describe('Words to match in the name, category or tags. Omit to list the newest.'),
      limit: z.number().int().min(1).max(50).optional().describe('Default 20'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ query, limit }: { query?: string; limit?: number }) => {
    const all = await backend.getCookbook(ctx.uid)
    const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const matches = words.length
      ? all.filter((r) => {
        const hay = [r.name, r.category, r.description, ...(r.tags ?? [])].join(' ').toLowerCase()
        return words.every((w) => hay.includes(w))
      })
      : all
    return { total: matches.length, recipes: matches.slice(0, limit ?? 20).map(recipeSummary) }
  }))

  server.registerTool('get_recipe', {
    title: 'Get recipe',
    description: 'The full ingredients and steps of a Fridgie recipe.',
    inputSchema: { recipe_id: z.string().trim().min(1).max(128) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ recipe_id }: { recipe_id: string }) => {
    const recipe = await backend.getRecipe(recipe_id)
    if (!recipe || (recipe.visibility === 'private' && recipe.createdBy !== ctx.uid)) {
      throw new ToolError(`No recipe with id "${recipe_id}".`)
    }
    return {
      ...recipeSummary(recipe),
      description: recipe.description ?? '',
      ingredients: recipe.ingredients ?? [],
      instructions: recipe.instructions ?? [],
    }
  }))

  server.registerTool('add_meal_to_plan', {
    title: 'Add meal to plan',
    description: 'Adds a meal to the user\'s Fridgie meal plan for a week, optionally on a specific day, and puts its ingredients on that week\'s grocery list (scaled to the household and sorted by aisle). Pass either a full `recipe` you wrote, or the `recipe_id` of one from search_cookbook. New recipes are saved to the user\'s cookbook.',
    inputSchema: {
      recipe: recipeSchema.optional().describe('The recipe to add. Required unless recipe_id is given.'),
      recipe_id: z.string().trim().max(128).optional().describe('An existing Fridgie recipe to add instead'),
      day: z.enum(DAYS).optional().describe('Day of the week to cook it. Omit to leave it unscheduled within the week.'),
      week: weekArg,
      household_id: householdArg,
      add_ingredients_to_list: z.boolean().optional().describe('Default true. False plans the meal without touching the grocery list.'),
      save_to_cookbook: z.boolean().optional().describe('Default true. Whether a new recipe is also saved to the cookbook.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guarded(async (args: {
    recipe?: RecipeArg; recipe_id?: string; day?: DayOfWeek; week?: string; household_id?: string
    add_ingredients_to_list?: boolean; save_to_cookbook?: boolean
  }) => {
    if (!args.recipe && !args.recipe_id) throw new ToolError('Pass either `recipe` or `recipe_id`.')
    if (args.recipe && args.recipe_id) throw new ToolError('Pass `recipe` or `recipe_id`, not both.')

    const home = await household(args.household_id)
    const list = await week(home.id, args.week)

    let recipe: Recipe
    let created = false
    if (args.recipe_id) {
      const existing = await backend.getRecipe(args.recipe_id)
      if (!existing || (existing.visibility === 'private' && existing.createdBy !== ctx.uid)) {
        throw new ToolError(`No recipe with id "${args.recipe_id}". Use search_cookbook to find one.`)
      }
      recipe = existing
    } else {
      recipe = await backend.createRecipe(ctx.uid, toRecipeInput(args.recipe!))
      created = true
    }

    const saved = created && args.save_to_cookbook !== false
      ? await backend.addToCookbook(ctx.uid, recipe.id)
      : false

    const { meal, items } = await backend.addRecipeToList(home.id, list.listId, recipe, {
      ...(args.day ? { dayOfWeek: args.day } : {}),
      includeIngredients: args.add_ingredients_to_list !== false,
    })

    return {
      added: meal.name,
      household: home.name,
      week: list.label,
      week_start: list.weekStart,
      ...(meal.dayOfWeek ? { day: meal.dayOfWeek } : {}),
      recipe_id: recipe.id,
      ...(saved ? { saved_to_cookbook: true } : {}),
      ...(meal.scale && meal.scale !== 1 ? { scaled_by: meal.scale } : {}),
      groceries_added: items.map((i) => (i.quantity ? `${i.quantity} ${i.text}` : i.text)),
    }
  }))

  server.registerTool('save_recipe', {
    title: 'Save recipe',
    description: 'Saves a recipe to the user\'s Fridgie cookbook without planning it for any week.',
    inputSchema: { recipe: recipeSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guarded(async ({ recipe }: { recipe: RecipeArg }) => {
    const created = await backend.createRecipe(ctx.uid, toRecipeInput(recipe))
    await backend.addToCookbook(ctx.uid, created.id)
    return { saved: created.name, recipe_id: created.id, ...(created.category ? { category: created.category } : {}) }
  }))

  server.registerTool('add_grocery_items', {
    title: 'Add grocery items',
    description: 'Adds items to the user\'s Fridgie grocery list for a week. They\'re sorted into store aisles automatically. For a meal\'s ingredients use add_meal_to_plan instead.',
    inputSchema: {
      items: z.array(ingredientSchema).min(1).max(100),
      week: weekArg,
      household_id: householdArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guarded(async ({ items, week: w, household_id }: { items: z.infer<typeof ingredientSchema>[]; week?: string; household_id?: string }) => {
    const home = await household(household_id)
    const list = await week(home.id, w)
    const added = await backend.appendItems(home.id, list.listId, items.map((i) => ({ text: i.name, quantity: i.quantity })))
    return {
      household: home.name,
      week: list.label,
      week_start: list.weekStart,
      added: added.map((i) => (i.quantity ? `${i.quantity} ${i.text}` : i.text)),
    }
  }))

  return server
}
