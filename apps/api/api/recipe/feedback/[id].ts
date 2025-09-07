import { Hono } from 'hono'
import { FieldValue } from 'firebase-admin/firestore'
import { fs } from '@/utils/firebase'
import { auth } from '@/middleware/auth'

const route = new Hono()

// All feedback routes require authentication
route.use('*', auth)

/**
 * POST /api/recipe/feedback/:id
 * Submits 'liked' or 'disliked' feedback for a recipe.
 */
route.post('/', async (c) => {
  const recipeId = c.req.param('id')
  const { rating } = await c.req.json<{ rating: 'liked' | 'disliked' }>()
  if(!recipeId) {
    return c.json({ error: 'Missing recipeId' }, 400)
  }

  if (!rating || !['liked', 'disliked'].includes(rating)) {
    return c.json({ error: 'Invalid rating provided' }, 400)
  }
  
  const recipeRef = fs.collection('recipes').doc(recipeId)
  
  // Find the root recipe to ensure popularity is tracked on the original
  const recipeDoc = await recipeRef.get()
  if (!recipeDoc.exists) {
    return c.json({ error: 'Recipe not found' }, 404)
  }

  const rootRecipeId = recipeDoc.data()?.forkedFromId || recipeId
  const rootRecipeRef = fs.collection('recipes').doc(rootRecipeId)

  try {
    // Use a transaction to safely increment the popularity counter
    await fs.runTransaction(async (transaction) => {
      const rootDoc = await transaction.get(rootRecipeRef)
      if (!rootDoc.exists) {
        throw new Error('Root recipe not found')
      }

      // Determine which field to increment
      const incrementField = rating === 'liked' ? 'popularity.likes' : 'popularity.dislikes'
      
      transaction.update(rootRecipeRef, {
        [incrementField]: FieldValue.increment(1)
      })
    })

    return c.json({ message: 'Feedback submitted successfully' })
  } catch (error: any) {
    console.error('Error submitting feedback:', error)
    return c.json({ error: 'Could not submit feedback', details: error.message }, 500)
  }
})

export default route