import type { DayOfWeek, Item, Meal, MealPreferences, Recipe } from '@/utils/types'
import type { NewListRow } from '@/utils/mealPlan'
import type { NewRecipeInput } from '@/utils/recipeStore'

export interface Household {
  id: string
  name: string
  isOwner: boolean
  memberCount: number
  /** People the household cooks for; absent means recipes are not scaled. */
  householdSize?: number
}

export interface WeekList {
  listId: string
  weekStart: string
  sort: string
  meals: Meal[]
  items: Item[]
}

/**
 * Everything the connector's tools do to Fridgie, as one seam.
 *
 * The tools never touch Firebase directly: `firebaseBackend.ts` implements this
 * over the same utilities the app's own routes use — adding a meal through
 * Claude and adding one in the app are the same function call — and the tests
 * implement it in memory.
 */
export interface FridgieBackend {
  listHouseholds(uid: string): Promise<Household[]>
  /** The household's list for the week starting `weekStart`, created if it doesn't exist yet. */
  getWeekList(groupId: string, weekStart: string, legacyWeekStart?: string): Promise<WeekList>
  appendItems(groupId: string, listId: string, rows: NewListRow[]): Promise<Item[]>
  addRecipeToList(
    groupId: string,
    listId: string,
    recipe: Recipe,
    options: { dayOfWeek?: DayOfWeek; includeIngredients?: boolean },
  ): Promise<{ meal: Meal; items: Item[] }>
  createRecipe(uid: string, input: NewRecipeInput): Promise<Recipe>
  addToCookbook(uid: string, recipeId: string): Promise<boolean>
  getRecipe(recipeId: string): Promise<Recipe | null>
  getCookbook(uid: string): Promise<Recipe[]>
  getPreferences(uid: string): Promise<MealPreferences | null>
}
