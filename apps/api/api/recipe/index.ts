// api/recipe/index.ts
import { Hono } from 'hono'
import { fs } from '@/utils/firebase' // Use Firestore admin
import { auth } from '@/middleware/auth'

const route = new Hono()

route.use('*', auth)

route.post('/', async (c) => {
  const uid = c.get('uid')
  const { id, ...recipeDetails } = await c.req.json()

  const recipeData = {
    ...recipeDetails,
    createdBy: uid,
    createdAt: new Date(),
  }

  const docRef = await fs.collection('recipes').add(recipeData)
  
  return c.json({ id: docRef.id, ...recipeData })
})

export default route