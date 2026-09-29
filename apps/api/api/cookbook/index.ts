import { Hono } from 'hono'
import { fs } from '@/utils/firebase'
import { auth } from '@/middleware/auth'
import { requireAccount } from '@/middleware/requireAccount'
import { publicProfiles } from '@/utils/publicProfiles'
import { fileRecipes, normalizeRecipeCategory } from '@/utils/recipeCategory'
import { addToCookbook } from '@/utils/cookbookStore'

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
 * Adds a recipe to the user's personal cookbook. Idempotent — see
 * `addToCookbook`.
 */
route.post('/', requireAccount, async (c) => {
  const uid = c.get('uid')
  const { recipeId } = await c.req.json<{ recipeId: string }>()

  if (!recipeId) {
    return c.json({ error: 'Missing recipeId' }, 400)
  }

  try {
    if (!(await addToCookbook(uid, recipeId))) {
      return c.json({ error: 'Recipe not found' }, 404)
    }
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
export async function getCookbook(uid: string, viewerUid = uid) {
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

    const recipeDocs = (await fetchRecipeDocsByIds(entries.map((entry) => entry.id)))
      .filter(doc => viewerUid === uid || doc.data().visibility !== 'private');

    // Authors and categories are independent questions about the same recipes,
    // and both are round trips — one to Auth, one to the model. Ask together.
    const uniqueAuthorUids = [...new Set(recipeDocs.map(doc => doc.data().createdBy))];
    const [authorResults, categories] = await Promise.all([
      publicProfiles(uniqueAuthorUids).catch(() => new Map()),
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
