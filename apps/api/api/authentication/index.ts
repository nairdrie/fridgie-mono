// api/authentication/index.ts
import { Hono } from 'hono'
import { adminAuth, fs } from '../../utils/firebase'
import { serialize } from 'cookie'
import { getFirestore } from 'firebase-admin/firestore'
import { defaultPhotoUrls } from '../../utils/defaultPhotoUrls'

const route = new Hono()

// Name of the cookie we’ll use for the Firebase session
const SESSION_COOKIE = '__session'
// How long we want the cookie to live (here: 5 days)
const EXPIRES_IN_MS = 5 * 24 * 60 * 60 * 1000

// POST /api/authentication/login
// body: { idToken: string }
route.post('/login', async (c) => {
  const { idToken } = await c.req.json<{ idToken?: string }>()
  if (!idToken) {
    return c.json({ error: '`idToken` is required' }, 400)
  }

  try {
    // 1. Verify the ID token to get the user's UID and other data
    const decodedToken = await adminAuth.verifyIdToken(idToken)
    const uid = decodedToken.uid

    // 2. Access Firestore
    // const userDocRef = fs.collection('users').doc(uid)

    // let userData = {} as any;
    
    // 3. Check for existing user document and create if it doesn't exist
    // await fs.runTransaction(async (transaction) => {
      // const userDoc = await transaction.get(userDocRef)

      // if (!userDoc.exists) {
        // const randomPhotoURL = defaultPhotoUrls[Math.floor(Math.random() * defaultPhotoUrls.length)]; // ⬅️ Randomly select a URL

        // userData = {
          // uid,
          // email: decodedToken.email || null,
          // phoneNumber: decodedToken.phone_number || null,
          // createdAt: new Date(),
          // lastLogin: new Date(),
          // photoURL: randomPhotoURL,
        // };
        // User document does not exist, so create it
        // transaction.set(userDocRef, userData)
      // } else {
        // userData = userDoc.data();
        // userData.lastLogin = new Date();
        // transaction.update(userDocRef, { lastLogin: userData.lastLogin });
      // }
    // })

    
    // Exchange the Firebase ID token for a session cookie
    const sessionCookie = await adminAuth.createSessionCookie(idToken, {
      expiresIn: EXPIRES_IN_MS,
    })

    // Serialize it into a secure, HTTP-only cookie
    const isProd = process.env.NODE_ENV === 'production'
    const cookieStr = serialize(SESSION_COOKIE, sessionCookie, {
      maxAge: EXPIRES_IN_MS / 1000, // seconds
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      path: '/',
    })

    c.header('Set-Cookie', cookieStr)
    return c.json({ status: 'success' })
  } catch (err) {
    console.error('auth/login error:', err)
    return c.json({ error: 'Unauthorized' }, 401)
  }
})

// POST /api/authentication/logout
// clears the session cookie
route.post('/logout', (c) => {
  const isProd = process.env.NODE_ENV === 'production'
  const cookieStr = serialize(SESSION_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/',
  })

  c.header('Set-Cookie', cookieStr)
  return c.json({ status: 'logged out' })
})

export default route
