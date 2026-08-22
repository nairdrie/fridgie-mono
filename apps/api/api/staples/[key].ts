// api/staples/[key].ts
//
// The correction. Everything else about this feature is inferred from
// behaviour, so it needs one place where the user can say plainly that the
// inference is wrong — otherwise a staple is a one-way door and the app can
// hide something you buy every week with no way to argue back.
//
// DELETE /api/staples/:key?groupId=...   "I do buy this" — permanent.
// PUT    /api/staples/:key?groupId=...   undo that, back to counting.

import { Hono } from 'hono'
import { auth } from '@/middleware/auth'
import { groupAuth } from '@/middleware/groupAuth'
import { setAlwaysShow } from '@/utils/stapleStore'
import { stapleKey } from '@fridgie/shared/staples'

const route = new Hono()

route.use('*', auth, groupAuth)

/**
 * Keys come off the wire and are used as an RTDB path segment, so they are
 * re-derived rather than trusted: `stapleKey` is idempotent on an already-clean
 * key and returns '' for anything carrying a path separator or a control
 * character.
 */
function safeKey(raw: string | undefined): string {
  return stapleKey(decodeURIComponent(raw ?? ''))
}

route.delete('/', async (c) => {
  const groupId = c.req.query('groupId')
  const key = safeKey(c.req.param('key'))
  if (!groupId || !key) return c.json({ error: 'Missing groupId or key' }, 400)

  try {
    await setAlwaysShow(groupId, key, true)
    return c.json({ status: 'always_show' })
  } catch (error) {
    console.error(`Failed to unset staple ${key}:`, error)
    return c.json({ error: 'Could not update that.' }, 500)
  }
})

route.put('/', async (c) => {
  const groupId = c.req.query('groupId')
  const key = safeKey(c.req.param('key'))
  if (!groupId || !key) return c.json({ error: 'Missing groupId or key' }, 400)

  try {
    await setAlwaysShow(groupId, key, false)
    return c.json({ status: 'counting' })
  } catch (error) {
    console.error(`Failed to reset staple ${key}:`, error)
    return c.json({ error: 'Could not update that.' }, 500)
  }
})

export default route
