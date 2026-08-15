// api/meal.ts
import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { LexoRank } from 'lexorank'
import { auth } from '@/middleware/auth'
import { groupAuth } from '@/middleware/groupAuth'
import { type Item, type Meal, type Recipe } from '@/utils/types'
import { mutateList } from '@/utils/listStore'
import { maxRank, sanitizeItems } from '@/utils/rank'
import { normalizeQuantity } from '@/utils/quantity'

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

    const newMeal: Meal = {
        id: uuidv4(),
        listId: listId,
        name: recipe.name,
        recipeId: recipe.id,
    }

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

            const newItems: Item[] = (recipe.ingredients || []).map((ingredient) => {
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

        // Respond with 201 Created and the new meal object
        return c.json(newMeal, 201)

    } catch (error: any) {
        console.error('Error in create meal process:', error)
        return c.json({ error: 'An internal error occurred', details: error.message }, 500)
    }
})

export default route
