// api/recipe/index.ts
import { Hono } from 'hono'
import { invalidateSearchIndex } from '@/utils/searchIndex';
import { fs } from '@/utils/firebase' // Use Firestore admin
import { FieldValue } from 'firebase-admin/firestore'
import { auth } from '@/middleware/auth'
import { guessRecipeCategory, normalizeRecipeCategory } from '@/utils/recipeCategory'
import { sourceDocId, sourceKeyFor } from '@/utils/recipeSource'

const route = new Hono()

route.use('*', auth)

/**
 * The recipe as it will be STORED, with its cookbook shelf settled.
 *
 * Three cases, in order: a category we recognise is kept (every AI path returns
 * one, and an edit round-trips whatever was already filed); otherwise the title
 * decides it where it can, for free; otherwise the field is left off entirely.
 *
 * Deliberately no model call on this path — saving a recipe must not wait on
 * one — and no re-filing of a recipe that already has a category. The cookbook
 * fetch has the model, and picks up whatever is still unfiled.
 */
function withCategory<T extends Record<string, any>>(details: T): T {
  const { category, ...rest } = details
  const stated = normalizeRecipeCategory(category)
  const settled = stated ?? guessRecipeCategory(details)
  // `rest` on the update path is what leaves an unrecognised value alone rather
  // than clearing what is already stored.
  return (settled ? { ...rest, category: settled } : rest) as T
}

/**
 * The recipe as it will be STORED, with its origin and its audience settled.
 *
 * Two fields the client does not get to decide:
 *
 * `sourceKey` is recomputed from `sourceUrl` on every write. It is the bucket
 * every independent import of one video lands in, so a client that could name
 * its own key could drop a recipe into any other dish's pile — or split itself
 * out of the one it belongs to and claim a fresh slot in Explore.
 *
 * `visibility` defaults to `'public'`, which is what every recipe already was
 * before the field existed. The importers are what narrow it: the photo
 * importer stamps `'private'` on what it returns, because a photograph of a
 * handwritten card has no public original and was never anybody's to publish.
 * An explicit value from the client is honoured — it is how the owner changes
 * their mind later.
 */
function withSource<T extends Record<string, any>>(details: T, creating: boolean): T {
  const { sourceKey: _ignored, sourceUrl, visibility, ...rest } = details

  const key = sourceKeyFor(sourceUrl)
  const settled: Record<string, any> = { ...rest }

  // A `sourceUrl` that yields no key is not a public origin — a `data:` URL, a
  // typo, a bare string. Storing it would credit an origin that isn't one.
  if (key) {
    settled.sourceUrl = sourceUrl
    settled.sourceKey = key
  }

  const stated = visibility === 'private' || visibility === 'public' ? visibility : null
  if (stated) {
    settled.visibility = stated
  } else if (creating) {
    settled.visibility = 'public'
  }
  // On an update with nothing stated, the field is left off the patch entirely.
  // Writing the default here instead would mean any edit that did not happen to
  // round-trip `visibility` — renaming a recipe, fixing a typo in a step —
  // silently republished a recipe its owner had made private.

  return settled as T
}

/** Everything both helpers settle, for a create (`creating`) or an edit. */
const toStored = <T extends Record<string, any>>(details: T, creating: boolean): T =>
  withSource(withCategory(details), creating)

/**
 * Count one more person having imported this source.
 *
 * This is the number the whole `sourceKey` idea exists to produce. Fifty people
 * importing one video is fifty recipe documents and one of these, and "47
 * people saved this" is a far better measure of a dish than a like count —
 * a like is a tap, an import is somebody deciding to cook the thing.
 *
 * Called only when a recipe is CREATED. Editing an imported recipe must not
 * inflate its source, and neither must a fork: the fork already counted when
 * whoever it was forked from imported it.
 *
 * Never awaited by the caller. A counter that fails to increment costs a rank;
 * a save that fails because a counter was unavailable costs the user their
 * recipe.
 */
function countImport(details: Record<string, any>): void {
  const key = details.sourceKey
  if (!key) return

  fs.collection('recipeSources').doc(sourceDocId(key)).set({
    sourceKey: key,
    sourceUrl: details.sourceUrl ?? null,
    sourceAuthor: details.sourceAuthor ?? null,
    importCount: FieldValue.increment(1),
    lastImportedAt: new Date(),
  }, { merge: true }).catch((error) => {
    console.warn(`Import count failed for ${key}:`, error instanceof Error ? error.message : error)
  })
}

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
  // Ownership/lineage fields are server-managed — never trust them from the body.
  // authorName/authorUid/lastAte are DERIVED per-request from createdBy and must
  // be stripped too: the client round-trips them, and writing them back stamped
  // the original author onto every fork.
  const {
    id,
    createdBy: _cb,
    createdAt: _ca,
    forkedFromId: _ff,
    authorName: _an,
    authorUid: _au,
    lastAte: _la,
    ...recipeDetails
  } = await c.req.json()

  if (!id) {
    const data = { ...toStored(recipeDetails, true), createdBy: uid, createdAt: new Date() }
    const docRef = await fs.collection('recipes').add(data)
    countImport(data)
    invalidateSearchIndex()  // new recipe -> searchable now, not in <=5 min
    return c.json({ id: docRef.id, ...data }, 201)
  }

  const docRef = fs.collection('recipes').doc(id)
  const recipeDoc = await docRef.get()

  if (!recipeDoc.exists) {
    const data = { ...toStored(recipeDetails, true), createdBy: uid, createdAt: new Date() }
    await docRef.set(data)
    countImport(data)
    invalidateSearchIndex()
    return c.json({ id, ...data }, 201)
  }

  const existing = recipeDoc.data() ?? {}

  if (existing.createdBy && existing.createdBy !== uid) {
    const rootId = existing.forkedFromId || id
    // A fork starts its own life: engagement counters belong to the original and
    // must not be copied, or every fork inherits the source's popularity.
    const { popularity, ratingCount, ratingTotal, ...carryOver } = existing
    const forkData = {
      ...carryOver,
      ...toStored(recipeDetails, true),
      createdBy: uid,
      createdAt: new Date(),
      forkedFromId: rootId,
    }
    const forkRef = await fs.collection('recipes').add(forkData)
    invalidateSearchIndex()
    return c.json({ id: forkRef.id, ...forkData }, 201)
  }

  const update = toStored(recipeDetails, false)
  await docRef.update({ ...update, updatedAt: new Date() })
  invalidateSearchIndex()
  return c.json({ id, ...existing, ...update })
})

export default route
