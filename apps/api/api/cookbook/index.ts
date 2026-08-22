import { Hono } from 'hono'
import { FieldValue } from 'firebase-admin/firestore'
import { fs } from '@/utils/firebase'
import { auth } from '@/middleware/auth'
import { requireAccount } from '@/middleware/requireAccount'
import { getAuth } from 'firebase-admin/auth'
import { fileRecipes, normalizeRecipeCategory } from '@/utils/recipeCategory'

const route = new Hono()

// All cookbook routes require authentication
route.use('*', auth)


// Firestore 'in' queries accept at most 30 values, so fetch in chunks.
async function fetchRecipeDocsByIds(recipeIds: string[]) {
  const chunks: string[][] = []
  for (let i = 0; i < recipeIds.length; i += 30) {
    chunks.push(recipeIds.slice(i, i + 30))
  }
  const snapshots = await Promise.all(
    chunks.map((ids) => fs.collection('recipes').where('__name__', 'in', ids).get())
  )
  return snapshots.flatMap((snapshot) => snapshot.docs)
}

/**
 * POST /api/cookbook
 * Adds a recipe to the user's personal cookbook.
 *
 * The cookbook holds the version the user actually chose, so the entry is filed
 * under `recipeId` itself. Filing it under the root instead used to mean that
 * editing someone else's recipe — which forks it — put the original straight
 * back on the shelf and the user's own copy nowhere at all.
 *
 * Popularity still accrues to the root: a fork is one more person cooking the
 * original, not a rival recipe starting from zero.
 */
route.post('/', requireAccount, async (c) => {
  const uid = c.get('uid')
  const { recipeId } = await c.req.json<{ recipeId: string }>()

  if (!recipeId) {
    return c.json({ error: 'Missing recipeId' }, 400)
  }

  const recipeDoc = await fs.collection('recipes').doc(recipeId).get()
  if (!recipeDoc.exists) {
    return c.json({ error: 'Recipe not found' }, 404)
  }
  const recipeData = recipeDoc.data()

  const rootRecipeRef = fs.collection('recipes').doc(recipeData?.forkedFromId || recipeId)

  // The recipe ID is the document ID, which is what prevents duplicates.
  const cookbookRef = fs.collection('users').doc(uid).collection('cookbook').doc(recipeId)

  try {
    // Run a transaction to perform both writes atomically
    await fs.runTransaction(async (transaction) => {
      // A root that has since been deleted is no reason to refuse the shelf
      // space — read it first (Firestore wants every read before any write).
      const rootExists = (await transaction.get(rootRecipeRef)).exists

      // 1. Add to the user's personal cookbook
      transaction.set(cookbookRef, {
        name: recipeData?.name,
        photoURL: recipeData?.photoURL || null,
        addedAt: FieldValue.serverTimestamp(),
      })

      // 2. Credit the original with one more cook
      if (rootExists) {
        transaction.update(rootRecipeRef, {
          'popularity.cookbooks': FieldValue.increment(1)
        })
      }
    })

    return c.json({ message: 'Recipe added to cookbook' }, 201)
  } catch (error: any) {
    console.error('Error adding to cookbook:', error)
    return c.json({ error: 'Could not add to cookbook', details: error.message }, 500)
  }
})

/**
 * A Firestore timestamp, a Date, or a string, as an ISO-8601 string.
 *
 * All three are in the wild: the POST above writes `serverTimestamp()`, the
 * seed script writes a `Date`, and a client that has just written one reads
 * back null until the server stamp lands.
 */
function toIsoString(value: any): string | null {
  if (!value) return null
  if (typeof value?.toDate === 'function') return value.toDate().toISOString()
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : null
}

/**
 * Every recipe on a user's shelf, newest first.
 *
 * Two things here can't come off the recipe documents alone:
 *
 * 1. The ORDER. The cookbook subcollection knows when each recipe was shelved;
 *    the recipes themselves don't. Firestore `in` queries return document-id
 *    order regardless of the order the ids were passed in, and the fetch is
 *    chunked on top of that, so the addedAt ordering has to be re-applied after
 *    the fetch — until it was, "newest first" was really "by document id".
 *
 * 2. The CATEGORY, for any recipe saved before it had one. Filing them on read
 *    is what stops the cookbook's filters being empty for existing users, and
 *    each answer is written back onto the recipe, so a given recipe is filed
 *    once ever rather than once per fetch.
 */
export async function getCookbook(uid: string) {
    const cookbookSnapshot = await fs.collection('users').doc(uid).collection('cookbook').orderBy('addedAt', 'desc').get()

    if (cookbookSnapshot.empty) {
      return [];
    }

    const entries = cookbookSnapshot.docs.map((doc) => ({
      id: doc.id,
      addedAt: toIsoString(doc.data()?.addedAt),
    }))
    const shelfOrder = new Map(entries.map((entry, index) => [entry.id, index]))
    const addedAt = new Map(entries.map((entry) => [entry.id, entry.addedAt]))

    const recipeDocs = await fetchRecipeDocsByIds(entries.map((entry) => entry.id));

    // Authors and categories are independent questions about the same recipes,
    // and both are round trips — one to Auth, one to the model. Ask together.
    const uniqueAuthorUids = [...new Set(recipeDocs.map(doc => doc.data().createdBy))];
    const [authorResults, categories] = await Promise.all([
      Promise.all(uniqueAuthorUids.map(authorUid =>
        getAuth().getUser(authorUid).catch(error => {
            // If a user is not found or another error occurs, return null
            // This prevents one failed lookup from crashing the entire Promise.all
            console.error(`Could not fetch author for UID: ${authorUid}`, error.code);
            return null;
        })
      )),
      // Never throws — a cookbook that fails to load because a model was busy
      // would be a far worse trade than one whose newest recipe has no chip yet.
      fileRecipes(recipeDocs.map(doc => ({
        id: doc.id,
        name: doc.data().name,
        description: doc.data().description,
        category: doc.data().category,
      }))),
    ]);

    // An easy-to-use map of { uid: displayName } for quick lookups
    const authorMap = new Map();
    authorResults.forEach(userRecord => {
        // Only add to the map if the user was successfully fetched
        if (userRecord) {
            authorMap.set(userRecord.uid, userRecord.displayName || 'Unknown Author');
        }
    });

    const recipes = recipeDocs.map(doc => {
        const recipeData = doc.data();
        const authorUid = recipeData.createdBy;

        // This lookup is instant and requires no new API calls
        const authorName = authorMap.get(authorUid) || 'Unknown Author';

        // What is stored wins; what was just resolved fills the gap. Anything
        // stored that this build doesn't recognise is dropped rather than sent
        // on, since the client can only draw a chip for a category it knows.
        const category = normalizeRecipeCategory(recipeData.category)
          ?? categories.get(doc.id)
          ?? undefined;

        return {
            id: doc.id,
            ...recipeData,
            category,
            addedAt: addedAt.get(doc.id) ?? null,
            authorName: authorName,
            authorUid: authorUid,
            author: authorName,
        };
    });

    // Back into the order the shelf is actually kept in.
    recipes.sort((a, b) => (shelfOrder.get(a.id) ?? 0) - (shelfOrder.get(b.id) ?? 0));

    return recipes;

}


/**
 * GET /api/cookbook
 * Retrieves all recipes in the user's cookbook.
 */
route.get('/', async (c) => {
  const uid = c.get('uid');
  try {
    const res = await getCookbook(uid);
    return c.json(res);
  } catch (error: any) {
    console.error('Error fetching cookbook:', error)
    return c.json({ error: 'Could not fetch cookbook', details: error.message }, 500)
  }
})

export default route