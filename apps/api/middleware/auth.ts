// api/_middleware/auth.ts
import type { Context, Next } from 'hono'
import { adminAuth }        from '../utils/firebase'
  
export async function auth(c: Context, next: Next) {
  const authz = c.req.header('authorization') || ''
  const token = authz.replace(/^Bearer\s+/, '')
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  
  try {
    // verifySessionCookie → verifyIdToken
    const decoded = await adminAuth.verifyIdToken(token)
    c.set('uid', decoded.uid)
    return await next()
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }
}
