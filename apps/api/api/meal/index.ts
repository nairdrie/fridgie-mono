// api/meal.ts
import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { LexoRank } from 'lexorank'
import { auth } from '@/middleware/auth'
import { groupAuth } from '@/middleware/groupAuth'
import { type Item, type Meal, type Recipe } from '@/utils/types'
import { adminRtdb } from '@/utils/firebase'
import { mutateList } from '@/utils/listStore'
import { maxRank, sanitizeItems } from '@/utils/rank'
import { normalizeQuantity } from '@/utils/quantity'
import { scaleIngredients, servingsScale } from '@/utils/servings'
import { categorizeNewItems } from '@/utils/categorize'
import { keepUnanswered } from '@/utils/sections'

const route = new Hono()

route.use('*', auth)

/**
 * Creates a new Meal on a List from a Recipe.
 * The write goes through the shared list mutator (an RTDB transaction), so
 * concurrent client saves are not clobbered and the doc's rev is bumped —
 * the websocket broadcast for this change happens automatically via the
 * RTDB listener.
 */
route.post('/', groupAuth, async (c) => {
    const { groupId, listId, recipe } = await c.req.json<{
        groupId: string;
        listId: string;
        recipe: Recipe;
    }>()

    if (!groupId || !listId || !recipe || !recipe.id) {
        return c.json({ error: 'Missing required fields' }, 400)
    }

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
    const scale = servingsScale(recipe.servings, householdSize)
    const ingredients = scaleIngredients(recipe.ingredients || [], scale)

    const newMeal: Meal = {
        id: uuidv4(),
        listId: listId,
        name: recipe.name,
        recipeId: recipe.id,
    }
    // Only when it did something. RTDB rejects undefined, and a stored 1 would
    // claim the meal was scaled when it was copied verbatim.
    if (scale !== 1) newMeal.scale = scale

    // Filled in by the transaction below: the rows this add put on the list,
    // and the only ones the categorization step is allowed to move.
    const addedItemIds: string[] = []

    try {
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

            const newItems: Item[] = ingredients.map((ingredient) => {
                listRank = listRank.genNext()
                const item: Item = {
                    id: uuidv4(),
                    mealId: newMeal.id,
                    text: ingredient.name ?? '',
                    checked: false,
                    isSection: false,
                    listOrder: listRank.toString(),
                    mealOrder: mealRank.toString(),
                }
                mealRank = mealRank.genNext()
                // RTDB rejects undefined values, so only set quantity when present
                const quantity = normalizeQuantity(ingredient.quantity)
                if (quantity) item.quantity = quantity
                addedItemIds.push(item.id)
                return item
            })

            return {
                ...current,
                meals: [...currentMeals, newMeal],
                items: [...currentItems, ...newItems],
            }
        })

        if (result.status === 'missing') {
            return c.json({ error: 'List not found' }, 404)
        }

        // A recipe's ingredients land on the end of the list, which on a
        // department-sorted list means they sit below the last aisle instead of
        // in it. File them here rather than on the client: the client only
        // learns about this meal from the broadcast, so it would have to
        // categorize against a snapshot it may not have received yet and would
        // write the new ingredients straight back out of existence.
        //
        // Only the ingredients just added are filed — the rest of the list keeps
        // the aisles and the order it already had.
        //
        // Best-effort — a model outage must not fail an otherwise-good add, it
        // just leaves the list unsorted until the next sort.
        //
        // An absent `sort` means the list has never been given one, not that it
        // was set to something else — a list is created without the key and the
        // client reads it as 'category' (its default). Requiring the key to be
        // present meant a meal added to a brand new list, the one case where the
        // whole list is the recipe's ingredients, was the one case left unsorted.
        if ((result.list?.sort ?? 'category') === 'category') {
            try {
                const committed: Item[] = Array.isArray(result.list.items) ? result.list.items : []
                const sorted = await categorizeNewItems(committed, addedItemIds)
                await mutateList(groupId, listId, (current) => ({
                    ...current,
                    // Anything saved while the model was thinking is not in
                    // `sorted`; without this the write would delete it.
                    items: keepUnanswered(sorted, sanitizeItems(current.items).items),
                }))
            } catch (error) {
                console.error('Post-add categorization failed; list left unsorted:', error)
            }
        }

        // Respond with 201 Created and the new meal object
        return c.json(newMeal, 201)

    } catch (error: any) {
        console.error('Error in create meal process:', error)
        return c.json({ error: 'An internal error occurred', details: error.message }, 500)
    }
})

export default route
