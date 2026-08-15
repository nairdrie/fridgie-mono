// api/_middleware/groupAuth.ts
import type { Context, Next } from 'hono'
import { adminRtdb }       from '../utils/firebase'

export async function groupAuth(c: Context, next: Next) {
  const uid     = c.get('uid') as string
  const groupId = c.req.query('groupId') || c.req.param('groupId') || c.req.param('id')
  if (!groupId) {
    console.error("groupAuth middleware: no groupId")
    return c.json({ error: 'Missing groupId' }, 400)
  }

  const snap = await adminRtdb
    .ref(`groups/${groupId}/members/${uid}`)
    .once('value')

  if (!snap.exists()) {
    console.error(`groupAuth middleware: not a member of ${groupId}`)
    return c.json({ error: 'Forbidden' }, 403)
  }

  return next()
}
