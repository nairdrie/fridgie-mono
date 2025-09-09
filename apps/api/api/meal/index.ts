// api/meal.ts
import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { LexoRank } from 'lexorank'
import { adminRtdb } from '@/utils/firebase'
import { auth } from '@/middleware/auth'
import { groupAuth } from '@/middleware/groupAuth'
import { type Item, type List, type Meal, type Recipe } from '@/utils/types'

const route = new Hono()

route.use('*', auth, groupAuth)

/**
 * Creates a new Meal on a List from a Recipe using a manual read-then-write operation.
 */
route.post('/', async (c) => {
    const { groupId, listId, recipe } = await c.req.json<{
        groupId: string;
        listId: string;
        recipe: Recipe;
    }>()

    if (!groupId || !listId || !recipe || !recipe.id) {
        return c.json({ error: 'Missing required fields' }, 400)
    }

    const listRef = adminRtdb.ref(`lists/${groupId}/${listId}`)

    try {
        // Step 1: Read the current list using .once('value') which we know works.
        const snapshot = await listRef.once('value');
        const currentList = snapshot.val() as List | null;

        if (currentList === null) {
            return c.json({ error: 'List not found' }, 404);
        }

        // Step 2: Modify the data in memory.
        const currentMeals: Meal[] = Array.isArray(currentList.meals)
            ? currentList.meals
            : (currentList.meals ? Object.values(currentList.meals) : []);

        const currentItems: Item[] = Array.isArray(currentList.items)
            ? currentList.items
            : (currentList.items ? Object.values(currentList.items) : []);

        const newMeal: Meal = {
            id: uuidv4(),
            listId: listId,
            name: recipe.name,
            recipeId: recipe.id,
        }

        const lastOrder = currentItems?.[currentItems.length - 1]?.listOrder;
        let lastRank = lastOrder ? LexoRank.parse(lastOrder) : LexoRank.middle();

        const newItems: Item[] = (recipe.ingredients || []).map((ingredient) => {
            lastRank = lastRank.genNext()
            return {
                id: uuidv4(),
                mealId: newMeal.id,
                text: ingredient.name,
                quantity: ingredient.quantity || undefined,
                checked: false,
                isSection: false,
                listOrder: lastRank.toString(),
            }
        })

        // Construct the full, updated list object
        const updatedList: List = {
            ...currentList,
            meals: [...currentMeals, newMeal],
            items: [...currentItems, ...newItems],
        };
        
        // Step 3: Write the entire updated object back to the database using .set()
        await listRef.set(updatedList);
        
        // Respond with 201 Created and the new meal object
        return c.json(newMeal, 201)

    } catch (error: any) {
        console.error('Error in create meal process:', error)
        return c.json({ error: 'An internal error occurred', details: error.message }, 500)
    }
})

export default route