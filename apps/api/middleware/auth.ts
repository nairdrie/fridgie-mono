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
    // Anonymous sign-ins carry a perfectly valid token, so routes that must not
    // serve them need this to tell the difference. Set here rather than
    // re-verified downstream so there is one decode per request.
    // After linkWithCredential the provider flips on the next token refresh,
    // and authorizedFetch force-refreshes on every call.
    c.set('signInProvider', decoded.firebase?.sign_in_provider ?? null)
    c.set('isAnonymous', decoded.firebase?.sign_in_provider === 'anonymous')
    return await next()
  } catch {
    console.error("auth middleware: invalid token");
    return c.json({ error: 'Unauthorized 2' }, 401)
  }
}
