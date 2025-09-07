import { Hono } from 'hono'
import { FieldValue } from 'firebase-admin/firestore'
import { fs } from '@/utils/firebase'
import { auth } from '@/middleware/auth'

const route = new Hono()

// All cookbook routes require authentication
route.use('*', auth)

route.delete('/', async (c) => {
  const uid = c.get('uid')
  const recipeId = c.req.param('id')

  if (!recipeId) {
    return c.json({ error: 'Missing recipeId' }, 400)
  }

  // Define references for the transaction
  const cookbookRef = fs.collection('users').doc(uid).collection('cookbook').doc(recipeId)
  const rootRecipeRef = fs.collection('recipes').doc(recipeId)

  try {
    // Use a transaction to ensure atomicity
    await fs.runTransaction(async (transaction) => {
      // 1. Delete the recipe from the user's cookbook subcollection
      transaction.delete(cookbookRef)

      // 2. Decrement the popularity counter on the root recipe
      // Using increment(-1) is the correct way to decrement a value
      transaction.update(rootRecipeRef, {
        'popularity.cookbooks': FieldValue.increment(-1)
      })
    })
    
    // Return 204 No Content for a successful deletion
    return c.body(null, 204)
  } catch (error: any) {
    console.error('Error removing from cookbook:', error)
    return c.json({ error: 'Could not remove from cookbook', details: error.message }, 500)
  }
})

export default route