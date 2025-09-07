import { Hono } from 'hono'
import { FieldValue } from 'firebase-admin/firestore'
import { fs } from '@/utils/firebase'
import { auth } from '@/middleware/auth'

const route = new Hono()

// All cookbook routes require authentication
route.use('*', auth)

/**
 * POST /api/cookbook
 * Adds a recipe to the user's personal cookbook.
 */
route.post('/', async (c) => {
  const uid = c.get('uid')
  const { recipeId } = await c.req.json<{ recipeId: string }>()

  if (!recipeId) {
    return c.json({ error: 'Missing recipeId' }, 400)
  }

  // Find the root recipe to ensure we save a reference to the original
  const recipeDoc = await fs.collection('recipes').doc(recipeId).get()
  if (!recipeDoc.exists) {
    return c.json({ error: 'Recipe not found' }, 404)
  }
  
  const rootRecipeId = recipeDoc.data()?.forkedFromId || recipeId
  const rootRecipeRef = fs.collection('recipes').doc(rootRecipeId)
  const rootRecipeData = (await rootRecipeRef.get()).data()

  // Add a reference to the user's cookbook subcollection
  // We use the recipe ID as the document ID to prevent duplicates
  const cookbookRef = fs.collection('users').doc(uid).collection('cookbook').doc(rootRecipeId)

  try {
    // Run a transaction to perform both writes atomically
    await fs.runTransaction(async (transaction) => {
      // 1. Add to the user's personal cookbook
      transaction.set(cookbookRef, {
        name: rootRecipeData?.name,
        photoURL: rootRecipeData?.photoURL || null,
        addedAt: FieldValue.serverTimestamp(),
      })

      // 2. Increment the popularity counter on the root recipe
      transaction.update(rootRecipeRef, {
        'popularity.cookbooks': FieldValue.increment(1)
      })
    })

    return c.json({ message: 'Recipe added to cookbook' }, 201)
  } catch (error: any) {
    console.error('Error adding to cookbook:', error)
    return c.json({ error: 'Could not add to cookbook', details: error.message }, 500)
  }
})

/**
 * GET /api/cookbook
 * Retrieves all recipes in the user's cookbook.
 */
route.get('/', async (c) => {
  const uid = c.get('uid')
  const cookbookCol = fs.collection('users').doc(uid).collection('cookbook')

  try {
    const cookbookSnapshot = await cookbookCol.orderBy('addedAt', 'desc').get()
    
    if (cookbookSnapshot.empty) {
      return c.json([]) // Return empty array if cookbook is empty
    }

    // Extract all the recipe IDs from the user's cookbook
    const recipeIds = cookbookSnapshot.docs.map(doc => doc.id)

    // Fetch all the full recipe documents from the main 'recipes' collection
    const recipesSnapshot = await fs.collection('recipes').where('__name__', 'in', recipeIds).get()
    
    const recipes = recipesSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }))

    return c.json(recipes)
  } catch (error: any) {
    console.error('Error fetching cookbook:', error)
    return c.json({ error: 'Could not fetch cookbook', details: error.message }, 500)
  }
})

export default route