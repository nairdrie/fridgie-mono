// api/_middleware/auth.ts
import type { Context, Next } from 'hono'
import { adminAuth }        from '../utils/firebase'
  
export async function auth(c: Context, next: Next) {
  const authz = c.req.header('authorization') || ''
  const token = authz.replace(/^Bearer\s+/, '')
  if (!token) {
    console.error("auth middleware: no token");
    return c.json({ error: 'Unauthorized 1' }, 401)
  }
  
  try {
    // verifySessionCookie → verifyIdToken
    const decoded = await adminAuth.verifyIdToken(token)
    c.set('uid', decoded.uid)
    return await next()
  } catch {
    console.error("auth middleware: invalid token");
    return c.json({ error: 'Unauthorized 2' }, 401)
  }
}
