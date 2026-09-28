import { FieldValue } from 'firebase-admin/firestore'
import { fs } from './firebase'

/**
 * Shelves `recipeId` in `uid`'s cookbook. Returns false when the recipe does
 * not exist.
 *
 * The cookbook holds the version the user actually chose, so the entry is filed
 * under `recipeId` itself. Filing it under the root instead used to mean that
 * editing someone else's recipe — which forks it — put the original straight
 * back on the shelf and the user's own copy nowhere at all.
 *
 * Popularity still accrues to the root: a fork is one more person cooking the
 * original, not a rival recipe starting from zero.
 *
 * IDEMPOTENT. The count is a count of PEOPLE, so it moves only when this user's
 * membership actually changes — adding a recipe already on the shelf is a
 * no-op, not a second cook. It has to be: a caller can be wrong about whether
 * it is already there (a screen showing somebody else's cookbook was, a retried
 * request is, a double tap is), and a counter that moves on every call reads
 * back the popularity of whoever tapped hardest.
 */
export async function addToCookbook(uid: string, recipeId: string): Promise<boolean> {
  const recipeDoc = await fs.collection('recipes').doc(recipeId).get()
  if (!recipeDoc.exists) return false
  const recipeData = recipeDoc.data()

  const rootRecipeRef = fs.collection('recipes').doc(recipeData?.forkedFromId || recipeId)

  // The recipe ID is the document ID, which is what prevents duplicates.
  const cookbookRef = fs.collection('users').doc(uid).collection('cookbook').doc(recipeId)

  // Run a transaction to perform both writes atomically
  await fs.runTransaction(async (transaction) => {
    // A root that has since been deleted is no reason to refuse the shelf
    // space — read it first (Firestore wants every read before any write).
    const rootExists = (await transaction.get(rootRecipeRef)).exists
    const existing = await transaction.get(cookbookRef)

    // 1. Add to the user's personal cookbook. `addedAt` is what the cookbook
    // is ordered by, so a re-add keeps the one it already has rather than
    // jumping the recipe to the top of a shelf it never left.
    transaction.set(cookbookRef, {
      name: recipeData?.name,
      photoURL: recipeData?.photoURL || null,
      addedAt: existing.data()?.addedAt ?? FieldValue.serverTimestamp(),
    })

    // 2. Credit the original with one more cook — but only if this user was
    // not already one of them. See the note on idempotency above.
    if (rootExists && !existing.exists) {
      transaction.update(rootRecipeRef, {
        'popularity.cookbooks': FieldValue.increment(1)
      })
    }
  })

  return true
}
