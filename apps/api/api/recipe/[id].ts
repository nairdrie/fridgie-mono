// api/recipe/index.ts
import { Hono } from 'hono'
import { fs } from '@/utils/firebase' // Use Firestore admin
import { auth } from '@/middleware/auth'

const route = new Hono()

route.use('*', auth)

// GET a single recipe by its document ID
route.get('/', async (c) => {
  const id  = c.req.param('id')

  if (!id) {
    return c.json({ error: 'Missing recipe ID' }, 400)
  }

  const recipeDoc = await fs.collection('recipes').doc(id).get()

  if (!recipeDoc.exists) {
    return c.json({ error: `Recipe ${id} not found` }, 404)
  }

  const recipeData = recipeDoc.data()
  return c.json({ id: recipeDoc.id, ...recipeData })
})

export default route