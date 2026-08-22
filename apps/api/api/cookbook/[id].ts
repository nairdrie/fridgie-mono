import { Hono } from 'hono'
import { FieldValue } from 'firebase-admin/firestore'
import { fs } from '@/utils/firebase'
import { auth } from '@/middleware/auth'
import { requireAccount } from '@/middleware/requireAccount'
import { getCookbook } from '@/api/cookbook'


const route = new Hono()

// All cookbook routes require authentication
route.use('*', auth)

/**
 * DELETE /api/cookbook/:id
 * Takes a recipe off the CALLER's own shelf — `uid` comes from the verified
 * token, never from the request, so this can only ever act on your own
 * cookbook however it is called.
 *
 * IDEMPOTENT, for the same reason POST /api/cookbook is: `popularity.cookbooks`
 * counts PEOPLE, so it moves only when this user's membership actually
 * changes. Removing a recipe that was never on the caller's shelf takes nothing
 * off the count — without that, anyone looking at somebody else's cookbook
 * could walk a stranger's recipe's popularity down one tap at a time, and a
 * client that merely believed it had the recipe (a screen showing another
 * user's shelf did exactly that) would do it by accident.
 */
route.delete('/', requireAccount, async (c) => {
  const uid = c.get('uid')
  const recipeId = c.req.param('id')

  if (!recipeId) {
    return c.json({ error: 'Missing recipeId' }, 400)
  }

  // Define references for the transaction
  const cookbookRef = fs.collection('users').doc(uid).collection('cookbook').doc(recipeId)
  // A cookbook entry can be a fork of something, and the count it was added to
  // belongs to the original — take it off the same recipe POST put it on.
  const recipeRef = fs.collection('recipes').doc(recipeId)

  try {
    // Use a transaction to ensure atomicity
    await fs.runTransaction(async (transaction) => {
      // Every read before any write, as Firestore requires.
      const onShelf = (await transaction.get(cookbookRef)).exists
      // Nothing of the caller's to remove: leave the count alone and say the
      // same thing a real deletion says, since the end state is the one asked
      // for either way.
      if (!onShelf) return

      const recipeSnap = await transaction.get(recipeRef)
      const rootRecipeRef = recipeSnap.data()?.forkedFromId
        ? fs.collection('recipes').doc(recipeSnap.data()!.forkedFromId)
        : recipeRef
      const rootExists = rootRecipeRef.isEqual(recipeRef)
        ? recipeSnap.exists
        : (await transaction.get(rootRecipeRef)).exists

      // 1. Delete the recipe from the user's cookbook subcollection
      transaction.delete(cookbookRef)

      // 2. Decrement the popularity counter on the root recipe. A recipe that
      // has since been deleted must not block taking it off the shelf.
      if (rootExists) {
        transaction.update(rootRecipeRef, {
          'popularity.cookbooks': FieldValue.increment(-1)
        })
      }
    })

    // Return 204 No Content for a successful deletion
    return c.body(null, 204)
  } catch (error: any) {
    console.error('Error removing from cookbook:', error)
    return c.json({ error: 'Could not remove from cookbook', details: error.message }, 500)
  }
})

route.get('/', async (c) => {
  const uid = c.req.param('id');
  try {
    if(!uid) {
      throw Error('No uid');
    }
    const res = await getCookbook(uid);
    return c.json(res);
  } catch(error: any) {
    console.error('Error fetching cookbook:', error)
    return c.json({ error: 'Could not fetch cookbook', details: error.message }, 500)
  }
});

export default route