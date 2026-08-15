// api/list/[id].ts
import { Hono } from 'hono'
import { adminRtdb } from '@/utils/firebase'
import { groupAuth } from '@/middleware/groupAuth'
import { auth } from '@/middleware/auth'
import { sanitizeItems } from '@/utils/rank'
import { mutateList } from '@/utils/listStore'

const route = new Hono()

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

  const result = await mutateList(groupId!, id, (current) => ({ ...current, ...payload }), {
    clientId: typeof clientId === 'string' ? clientId : undefined,
    expectedRev: typeof expectedRev === 'number' ? expectedRev : undefined,
  })

  if (result.status === 'missing') return c.json({ error: 'Not found' }, 404)
  if (result.status === 'stale') {
    return c.json({ error: 'stale_rev', rev: result.rev, list: result.list }, 409)
  }
  return c.json({ status: 'updated', rev: result.rev })
})

export default route
