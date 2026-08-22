// api/list/[id].ts
import { Hono } from 'hono'
import { adminRtdb } from '@/utils/firebase'
import { groupAuth } from '@/middleware/groupAuth'
import { auth } from '@/middleware/auth'
import { sanitizeItems } from '@/utils/rank'
import { mutateList } from '@/utils/listStore'
import { recordStapleRejections } from '@/utils/stapleStore'
import { detectStapleRejections, stapleKey } from '@fridgie/shared/staples'
import type { ListSort } from '@/utils/types'

const route = new Hono()

const LIST_SORTS: ListSort[] = ['alphabetical', 'category', 'custom']

route.use('*', auth, groupAuth)

route.get('/', async (c) => {
  const id = c.req.param('id')
  const groupId = c.req.query('groupId')

  if (!id) return c.json({ error: 'Missing id' }, 400)
  const snap = await adminRtdb.ref(`lists/${groupId}/${id}`).once('value')
  const data = snap.val()
  if (!data) return c.json({ error: 'Not found' }, 404)
  return c.json(data)
})

/**
 * POST /api/list/:id?groupId=...
 * Body: { items?, meals?, sort?, ..., clientId?: string, rev?: number }
 *
 * `clientId` and `rev` are consumed by the server (not stored as payload):
 * - the write is rejected with 409 { error: 'stale_rev', rev, list } when
 *   `rev` is behind the stored revision, so the client can rebase;
 * - the committed doc carries `rev` (incremented) and `lastClientId`, which
 *   are included in websocket broadcasts so senders can ignore their echoes.
 * Older clients that send neither keep last-write-wins behaviour.
 */
route.post('/', async (c) => {
  const id = c.req.param('id')
  const groupId = c.req.query('groupId')
  if (!id) return c.json({ error: 'Missing id' }, 400)

  const body = await c.req.json()
  const { clientId, rev: expectedRev, ...payload } = body ?? {}

  if (payload.items !== undefined) {
    payload.items = sanitizeItems(payload.items).items
  }

  // `sort` is a closed union the client exhaustively switches on. Persisting
  // anything outside it (e.g. 'Category') leaves the sort modal with nothing
  // selected and the list falling through every branch.
  if (payload.sort !== undefined && !LIST_SORTS.includes(payload.sort)) {
    payload.sort = 'custom'
  }

  // The document as it stood before this save, captured from inside the
  // mutator because that is the only place it exists. A transaction body can
  // run several times; each attempt overwrites this, so what survives is the
  // state the COMMITTED attempt was built on — which is exactly what the diff
  // below needs.
  let before: any = null

  const result = await mutateList(groupId!, id, (current) => {
    before = current
    return { ...current, ...payload }
  }, {
    clientId: typeof clientId === 'string' ? clientId : undefined,
    expectedRev: typeof expectedRev === 'number' ? expectedRev : undefined,
  })

  if (result.status === 'missing') return c.json({ error: 'Not found' }, 404)
  if (result.status === 'stale') {
    return c.json({ error: 'stale_rev', rev: result.rev, list: result.list }, 409)
  }

  // Which recipe ingredients this household just refused to buy. Deliberately
  // after the commit and deliberately not awaited: this is a background
  // observation about the user's habits, and it must never delay — or fail —
  // the save of their shopping list. See packages/shared/staples.ts for the
  // rules, and note that a 409 never reaches here: a rejected write's diff
  // describes a document that was never stored.
  if (before && groupId) {
    void recordRejectionsFrom(groupId, before, result.list)
  }

  return c.json({ status: 'updated', rev: result.rev })
})

/**
 * Best-effort, fire-and-forget. Every failure path here costs a slower-learning
 * staple list and nothing else, so all of them are swallowed with a log.
 */
async function recordRejectionsFrom(groupId: string, before: any, after: any): Promise<void> {
  try {
    // RTDB stores an array with a hole in it as a keyed OBJECT, and hands it
    // back that way. `detectStapleRejections` takes arrays and would quietly
    // see nothing at all — so the stored side is normalized first, exactly as
    // every other read path here does.
    const previous = { ...before, items: sanitizeItems(before?.items).items }

    const keys = detectStapleRejections(previous, after)
    if (keys.length === 0) return

    // The wording as the user last saw it, so the settings screen can say
    // "olive oil" instead of the hyphenated key. Taken from the rows that were
    // actually removed, which is where the key came from.
    const names: Record<string, string> = {}
    for (const row of previous.items as { text?: string }[]) {
      const key = stapleKey(row?.text)
      if (key && keys.includes(key) && !names[key]) names[key] = String(row.text).trim()
    }

    await recordStapleRejections(groupId, keys, names)
  } catch (error) {
    console.error('Could not record staple rejections:', error)
  }
}

export default route
