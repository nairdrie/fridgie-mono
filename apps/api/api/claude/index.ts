// api/claude/index.ts — the app's side of the Claude connector: making the
// one-time code the connector's sign-in page asks for, and listing and
// removing the connections it made. The connector itself lives in mcp/.
import { Hono } from 'hono'
import { adminRtdb } from '@/utils/firebase'
import { auth } from '@/middleware/auth'
import { requireAccount } from '@/middleware/requireAccount'
import { oauthService } from '@/mcp'
import { formatLinkCode } from '@/mcp/oauthCore'
import { isValidTimeZone } from '@/mcp/weeks'

const route = new Hono()

// A connection writes recipes into a cookbook, which belongs to a person
// rather than to a device — the same line requireAccount draws for the app.
route.use('*', auth, requireAccount)

/**
 * POST /api/claude/link-code
 * Body: { groupId?: string, timezone?: string }
 *
 * `groupId` is the household that was open in the app, so "add it to my list"
 * lands where the user was looking; `timezone` is the phone's, so "this week"
 * means their week. Both are optional and both are checked here, because the
 * connection will act on them later without the app around to ask.
 */
route.post('/link-code', async (c) => {
  const uid = c.get('uid')
  const body = await c.req.json().catch(() => ({})) as { groupId?: unknown; timezone?: unknown }

  let groupId: string | undefined
  if (typeof body.groupId === 'string' && body.groupId) {
    const member = await adminRtdb.ref(`groups/${body.groupId}/members/${uid}`).once('value')
    if (!member.exists()) return c.json({ error: 'Forbidden' }, 403)
    groupId = body.groupId
  }
  const timezone = isValidTimeZone(body.timezone) ? body.timezone : undefined

  const { code, expiresAtMs } = await oauthService.createLinkCode(uid, { groupId, timezone })
  return c.json({ code: formatLinkCode(code), expiresAt: new Date(expiresAtMs).toISOString() }, 201)
})

/** GET /api/claude/connections — every live connection, newest first. */
route.get('/connections', async (c) => {
  return c.json(await oauthService.listGrants(c.get('uid')))
})

/** DELETE /api/claude/connections/:id — disconnects immediately; its tokens stop working. */
route.delete('/connections/:id', async (c) => {
  const removed = await oauthService.revokeGrant(c.get('uid'), c.req.param('id'))
  if (!removed) return c.json({ error: 'Not found' }, 404)
  return c.json({ status: 'disconnected' })
})

export default route
