import { Hono } from 'hono'
import { FieldValue } from 'firebase-admin/firestore'
import { fs } from '@/utils/firebase'
import { auth } from '@/middleware/auth'

const route = new Hono()

// All feedback routes require authentication
route.use('*', auth)

/** Written feedback is stored, not analysed; cap it so one paste can't bloat a doc. */
const MAX_FEEDBACK_CHARS = 2000

/**
 * POST /api/recipe/feedback/:id
 * Submits 'liked' or 'disliked' feedback for a recipe.
 *
 * Two records come out of one call:
 *  - the global popularity counter on the ROOT recipe, which orders /api/explore
 *  - a per-user document, which is the only place "this person liked this dish"
 *    is written down. Without it the suggester can only infer taste from how
 *    often something gets replanned.
 *
 * Counters are per-user-per-recipe, not per-rating. Cooking a favourite ten
 * times used to add ten likes, so a single enthusiastic user could outrank
 * everything else in Explore; and changing your mind used to increment
 * dislikes while leaving the old like in place.
 */
route.post('/', async (c) => {
  const uid = c.get('uid') as string
  const recipeId = c.req.param('id')
  if (!recipeId) {
    return c.json({ error: 'Missing recipeId' }, 400)
  }

  const body = await c.req.json<{
    rating: 'liked' | 'disliked'
    feedback?: string
    mealId?: string
  }>().catch(() => null)

  const rating = body?.rating
  if (!rating || !['liked', 'disliked'].includes(rating)) {
    return c.json({ error: 'Invalid rating provided' }, 400)
  }

  // The client has always sent this on a dislike; it used to be dropped on the
  // floor here, so every reason anyone typed was discarded.
  const feedback = typeof body?.feedback === 'string'
    ? body.feedback.trim().slice(0, MAX_FEEDBACK_CHARS)
    : ''
  const mealId = typeof body?.mealId === 'string' ? body.mealId : null

  const recipeRef = fs.collection('recipes').doc(recipeId)
  const recipeDoc = await recipeRef.get()
  if (!recipeDoc.exists) {
    return c.json({ error: 'Recipe not found' }, 404)
  }

  // Popularity and taste both track the ROOT recipe, so a fork and its original
  // are one dish rather than two.
  const rootRecipeId = recipeDoc.data()?.forkedFromId || recipeId
  const rootRecipeRef = fs.collection('recipes').doc(rootRecipeId)
  const userFeedbackRef = fs
    .collection('users').doc(uid)
    .collection('recipeFeedback').doc(rootRecipeId)

  try {
    await fs.runTransaction(async (transaction) => {
      // Firestore requires every read before any write.
      const [rootDoc, priorDoc] = await Promise.all([
        transaction.get(rootRecipeRef),
        transaction.get(userFeedbackRef),
      ])
      if (!rootDoc.exists) {
        throw new Error('Root recipe not found')
      }

      const prior = priorDoc.exists ? priorDoc.data() : null
      const priorRating = prior?.rating as 'liked' | 'disliked' | undefined

      // Only move the counters when this user's verdict actually changes.
      if (priorRating !== rating) {
        const counters: Record<string, FirebaseFirestore.FieldValue> = {
          [rating === 'liked' ? 'popularity.likes' : 'popularity.dislikes']:
            FieldValue.increment(1),
        }
        if (priorRating) {
          counters[priorRating === 'liked' ? 'popularity.likes' : 'popularity.dislikes'] =
            FieldValue.increment(-1)
        }
        transaction.update(rootRecipeRef, counters)
      }

      transaction.set(
        userFeedbackRef,
        {
          rating,
          // Keep the last reason given rather than blanking it on a later
          // wordless rating of the same dish.
          ...(feedback ? { feedback } : {}),
          ratedRecipeId: recipeId,
          ...(mealId ? { mealId } : {}),
          // How often they have rated it — repeat ratings are the strongest
          // taste signal available, and the counter above deliberately ignores them.
          timesRated: FieldValue.increment(1),
          ratedAt: FieldValue.serverTimestamp(),
          ...(prior ? {} : { firstRatedAt: FieldValue.serverTimestamp() }),
        },
        { merge: true },
      )
    })

    return c.json({ message: 'Feedback submitted successfully' })
  } catch (error: any) {
    console.error('Error submitting feedback:', error)
    return c.json({ error: 'Could not submit feedback', details: error.message }, 500)
  }
})

export default route
