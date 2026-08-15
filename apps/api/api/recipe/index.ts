// api/recipe/index.ts
import { Hono } from 'hono'
import { fs } from '@/utils/firebase' // Use Firestore admin
import { auth } from '@/middleware/auth'

const route = new Hono()

route.use('*', auth)

/**
 * POST /api/recipe — create or update a recipe.
 * - no id → create with a server-generated id
 * - id that doesn't exist yet → create with the client-provided id, so
 *   meal.recipeId references created client-side stay valid
 * - id owned by the caller → in-place update
 * - id owned by someone else → fork: a new recipe is created with
 *   `forkedFromId` pointing at the root recipe, and the response carries the
 *   new id (callers must adopt it, e.g. update meal.recipeId)
 */
route.post('/', async (c) => {
  const uid = c.get('uid')
  // ownership/lineage fields are server-managed — never trust them from the body
  const { id, createdBy: _cb, createdAt: _ca, forkedFromId: _ff, ...recipeDetails } = await c.req.json()

  if (!id) {
    const data = { ...recipeDetails, createdBy: uid, createdAt: new Date() }
    const docRef = await fs.collection('recipes').add(data)
    return c.json({ id: docRef.id, ...data }, 201)
  }

  const docRef = fs.collection('recipes').doc(id)
  const recipeDoc = await docRef.get()

  if (!recipeDoc.exists) {
    const data = { ...recipeDetails, createdBy: uid, createdAt: new Date() }
    await docRef.set(data)
    return c.json({ id, ...data }, 201)
  }

  const existing = recipeDoc.data() ?? {}

  if (existing.createdBy && existing.createdBy !== uid) {
    const rootId = existing.forkedFromId || id
    const forkData = {
      ...existing,
      ...recipeDetails,
      createdBy: uid,
      createdAt: new Date(),
      forkedFromId: rootId,
    }
    const forkRef = await fs.collection('recipes').add(forkData)
    return c.json({ id: forkRef.id, ...forkData }, 201)
  }

  await docRef.update({ ...recipeDetails, updatedAt: new Date() })
  return c.json({ id, ...existing, ...recipeDetails })
})

export default route
