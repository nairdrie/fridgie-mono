import { Hono } from 'hono'
import { adminRtdb, fs } from '@/utils/firebase'

/**
 * GET /api/health          — liveness. Cheap, no I/O.
 * GET /api/health?deep=1   — readiness. Actually touches RTDB and Firestore.
 *
 * Deliberately the ONE route with no auth middleware: the deploy pipeline has
 * to reach it on a no-traffic candidate revision before any user does, and it
 * returns nothing an anonymous caller could not already infer.
 *
 * The deep variant is what makes a deploy trustworthy. Application Default
 * Credentials are the one thing that cannot be exercised locally — a local run
 * always finds utils/firebase-service-account.json — so "the container
 * started" proves nothing about whether the runtime service account can
 * actually read anything. This does a real read of each.
 */
const route = new Hono()

route.get('/', async (c) => {
  const body: Record<string, unknown> = {
    ok: true,
    // Cloud Run injects these; absent locally.
    revision: process.env.K_REVISION ?? 'local',
    uptime: Math.round(process.uptime()),
  }

  if (c.req.query('deep')) {
    const [rtdb, firestore] = await Promise.allSettled([
      adminRtdb.ref('.info/serverTimeOffset').once('value'),
      fs.collection('recipes').limit(1).select().get(),
    ])
    body.rtdb = rtdb.status === 'fulfilled' ? 'ok' : 'fail'
    body.firestore = firestore.status === 'fulfilled' ? 'ok' : 'fail'
    if (rtdb.status === 'rejected') console.error('health: rtdb', rtdb.reason)
    if (firestore.status === 'rejected') console.error('health: firestore', firestore.reason)
    if (body.rtdb !== 'ok' || body.firestore !== 'ok') {
      body.ok = false
      return c.json(body, 503)
    }
  }

  return c.json(body)
})

export default route
