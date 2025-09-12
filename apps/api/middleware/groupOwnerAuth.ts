// api/_middleware/groupAuth.ts
import type { Context, Next } from 'hono'
import { adminRtdb }       from '../utils/firebase'

export async function groupOwnerAuth(c: Context, next: Next) {
  const uid     = c.get('uid') as string
  const groupId = c.req.query('groupId') || c.req.param('groupId') || c.req.param('id')
  if (!groupId) {
    console.error("groupOwnerAuth middleware: no groupId")
    return c.json({ error: 'Missing groupIddd' }, 400)
  }

  // ensure group/owner == uid
  const snap = await adminRtdb
  .ref(`groups/${groupId}`)
  .once('value')
  
  if (!snap.exists()) {
    console.error("groupOwnerAuth middleware: group not found")
    return c.json({ error: 'Forbidden' }, 403)
  }
  
  if(snap.val().owner !== uid) {
    console.error("groupOwnerAuth middleware: not group owner")
    return c.json({ error: 'Forbidden, not group owner' }, 403)
  }
  return next()
}
