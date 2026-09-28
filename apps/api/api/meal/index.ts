// api/meal.ts
import { Hono } from 'hono'
import { auth } from '@/middleware/auth'
import { groupAuth } from '@/middleware/groupAuth'
import { type Recipe } from '@/utils/types'
import { addRecipeToList } from '@/utils/mealPlan'

const route = new Hono()

route.use('*', auth)

/**
 * Creates a new Meal on a List from a Recipe. See `addRecipeToList` for how
 * the ingredients are scaled, written and filed into aisles — the Claude
 * connector (apps/api/mcp) adds meals through the same function.
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

    try {
        const result = await addRecipeToList(groupId, listId, recipe)

        if (result.status === 'missing') {
            return c.json({ error: 'List not found' }, 404)
        }

        // Respond with 201 Created and the new meal object
        return c.json(result.meal, 201)

    } catch (error: any) {
        console.error('Error in create meal process:', error)
        return c.json({ error: 'An internal error occurred', details: error.message }, 500)
    }
})

export default route
