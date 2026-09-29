import { v4 as uuidv4 } from 'uuid'
import { LexoRank } from 'lexorank'
import type { DayOfWeek, Item, Meal, Recipe } from './types'
import { adminRtdb } from './firebase'
import { mutateList } from './listStore'
import { maxRank, sanitizeItems } from './rank'
import { normalizeQuantity } from './quantity'
import { scaleIngredients, servingsScale } from './servings'
import { categorizeNewItems } from './categorize'
import { keepUnanswered } from './sections'

/** One grocery row to put on a list: what to buy and, optionally, how much. */
export interface NewListRow {
  text: string
  quantity?: string
}

export type AppendResult =
  | { status: 'ok'; items: Item[] }
  | { status: 'missing' }

/**
 * Appends `rows` to the end of a list — and, when `meal` is given, the meal
 * itself, with every row tied to it — then files the new rows into their
 * aisles.
 *
 * The write goes through the shared list mutator (an RTDB transaction), so
 * concurrent client saves are not clobbered and the doc's rev is bumped — the
 * websocket broadcast for this change happens automatically via the RTDB
 * listener.
 */
export async function appendToList(
  groupId: string,
  listId: string,
  rows: NewListRow[],
  meal?: Meal,
): Promise<AppendResult> {
  // Filled in by the transaction below: the rows this add put on the list,
  // and the only ones the categorization step is allowed to move.
  const addedItemIds: string[] = []
  let addedItems: Item[] = []

  const result = await mutateList(groupId, listId, (current) => {
    const currentMeals: Meal[] = Array.isArray(current.meals)
      ? current.meals
      : (current.meals ? Object.values(current.meals) : [])

    // Repairs legacy/bad ranks (e.g. 'NEEDS-RANK') so rank generation
    // below can't crash, and keeps unknown item fields intact.
    const { items: currentItems } = sanitizeItems(current.items)

    // Rank off the MAXIMUM existing rank, not the last array element —
    // the stored array isn't necessarily in rank order, and taking the
    // tail scattered new ingredients into the middle of the user's list.
    let listRank = maxRank(currentItems, 'listOrder') ?? LexoRank.middle()
    let mealRank = LexoRank.middle()

    // A transaction body can run more than once; each attempt starts
    // from the ids of that attempt, never an accumulation of all of them.
    addedItemIds.length = 0

    const newItems: Item[] = rows.map((row) => {
      listRank = listRank.genNext()
      const item: Item = {
        id: uuidv4(),
        text: row.text ?? '',
        checked: false,
        isSection: false,
        listOrder: listRank.toString(),
      }
      if (meal) {
        item.mealId = meal.id
        item.mealOrder = mealRank.toString()
        mealRank = mealRank.genNext()
      }
      // RTDB rejects undefined values, so only set quantity when present
      const quantity = normalizeQuantity(row.quantity)
      if (quantity) item.quantity = quantity
      addedItemIds.push(item.id)
      return item
    })
    addedItems = newItems

    return {
      ...current,
      ...(meal ? { meals: [...currentMeals, meal] } : {}),
      items: [...currentItems, ...newItems],
    }
  })

  if (result.status !== 'ok') return { status: 'missing' }

  // New rows land on the end of the list, which on a department-sorted list
  // means they sit below the last aisle instead of in it. File them here rather
  // than on the client: the client only learns about this add from the
  // broadcast, so it would have to categorize against a snapshot it may not
  // have received yet and would write the new rows straight back out of
  // existence.
  //
  // Only the rows just added are filed — the rest of the list keeps the aisles
  // and the order it already had.
  //
  // Best-effort — a model outage must not fail an otherwise-good add, it just
  // leaves the list unsorted until the next sort.
  //
  // An absent `sort` means the list has never been given one, not that it was
  // set to something else — a list is created without the key and the client
  // reads it as 'category' (its default). Requiring the key to be present meant
  // a meal added to a brand new list, the one case where the whole list is the
  // recipe's ingredients, was the one case left unsorted.
  if (addedItemIds.length > 0 && (result.list?.sort ?? 'category') === 'category') {
    try {
      const committed: Item[] = Array.isArray(result.list.items) ? result.list.items : []
      const sorted = await categorizeNewItems(committed, addedItemIds)
      await mutateList(groupId, listId, (current) => ({
        ...current,
        // Anything saved while the model was thinking is not in `sorted`;
        // without this the write would delete it.
        items: keepUnanswered(sorted, sanitizeItems(current.items).items),
      }))
    } catch (error) {
      console.error('Post-add categorization failed; list left unsorted:', error)
    }
  }

  return { status: 'ok', items: addedItems }
}

export type AddRecipeResult =
  | { status: 'ok'; meal: Meal; items: Item[] }
  | { status: 'missing' }

/**
 * Creates a new Meal on a List from a Recipe, putting the recipe's ingredients
 * on the grocery list scaled to the household.
 */
export async function addRecipeToList(
  groupId: string,
  listId: string,
  recipe: Pick<Recipe, 'id' | 'name' | 'ingredients' | 'servings'>,
  options: { dayOfWeek?: DayOfWeek; includeIngredients?: boolean } = {},
): Promise<AddRecipeResult> {
  // What this household actually cooks for. Absent means don't scale — see
  // `Group.householdSize` for why that must not fall back to a member count.
  // Best-effort: a failed read costs correct amounts, not the whole add.
  const householdSize = await adminRtdb
    .ref(`groups/${groupId}/householdSize`)
    .once('value')
    .then((snap) => snap.val() as number | null)
    .catch((e) => {
      console.error('Could not read household size; adding unscaled:', e)
      return null
    })

  // Computed once, outside the transaction body — that body can run several
  // times, and the meal must not end up stamped with a different factor from
  // the one its own ingredients were scaled by.
  const includeIngredients = options.includeIngredients ?? true
  const scale = includeIngredients ? servingsScale(recipe.servings, householdSize) : 1
  const ingredients = includeIngredients ? scaleIngredients(recipe.ingredients || [], scale) : []

  const meal: Meal = {
    id: uuidv4(),
    listId,
    name: recipe.name,
    recipeId: recipe.id,
  }
  if (options.dayOfWeek) meal.dayOfWeek = options.dayOfWeek
  // Only when it did something. RTDB rejects undefined, and a stored 1 would
  // claim the meal was scaled when it was copied verbatim.
  if (scale !== 1) meal.scale = scale

  const rows = ingredients.map((ingredient) => ({
    text: ingredient.name ?? '',
    quantity: ingredient.quantity,
  }))

  const result = await appendToList(groupId, listId, rows, meal)
  if (result.status !== 'ok') return result
  return { status: 'ok', meal, items: result.items }
}
