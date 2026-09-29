import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { FridgieBackend } from './backend'
import { OAuthError, type OAuthService } from './oauthService'
import { FRIDGIE_SCOPE, isValidChallenge, redirectLabel, withParams } from './oauthCore'
import { renderAuthorizePage, renderErrorPage } from './authorizePage'
import { createFridgieMcpServer } from './tools'

export const MCP_PATH = '/mcp'

/**
 * The public origin, as the client reached us. `PUBLIC_BASE_URL` pins it
 * (https://api.fridgie.ca); otherwise it comes from the forwarded headers Cloud
 * Run sets, so a candidate revision's own URL also works for testing.
 */
export function publicBaseUrl(c: Context): string {
  const pinned = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '')
  if (pinned) return pinned
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '')
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host') || url.host
  return `${proto}://${host}`
}

/**
 * Failed code entries per client address, so the ~40 bits of a link code
 * can't be ground through from one machine. In memory, per instance: the
 * code's ten-minute life does most of the work, this just keeps a script from
 * trying all of it.
 */
function attemptLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>()
  return {
    blocked(key: string) {
      const entry = hits.get(key)
      return !!entry && entry.resetAt > Date.now() && entry.count >= max
    },
    fail(key: string) {
      const entry = hits.get(key)
      if (!entry || entry.resetAt <= Date.now()) hits.set(key, { count: 1, resetAt: Date.now() + windowMs })
      else entry.count++
      if (hits.size > 10_000) hits.clear()
    },
  }
}

const AUTHORIZE_PARAMS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'] as const

async function formOrJson(c: Context): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? ''
  if (type.includes('application/json')) {
    const body = await c.req.json().catch(() => ({}))
    return Object.fromEntries(Object.entries(body ?? {}).map(([k, v]) => [k, String(v)]))
  }
  const body = await c.req.parseBody().catch(() => ({}))
  return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === 'string')) as Record<string, string>
}

/** RFC 6749 §2.3.1: Basic credentials are form-urlencoded before base64. */
function basicCredentials(header: string | undefined): { id?: string; secret?: string } {
  const match = /^Basic\s+(.+)$/i.exec(header ?? '')
  if (!match) return {}
  try {
    const decoded = atob(match[1]!)
    const at = decoded.indexOf(':')
    if (at < 0) return {}
    return { id: decodeURIComponent(decoded.slice(0, at)), secret: decodeURIComponent(decoded.slice(at + 1)) }
  } catch {
    return {}
  }
}

const oauthError = (c: Context, error: OAuthError) => {
  c.header('Cache-Control', 'no-store')
  if (error.status === 401) c.header('WWW-Authenticate', 'Basic realm="fridgie"')
  return c.json({ error: error.code, error_description: error.description }, error.status as 400 | 401)
}

export function createMcpApp(deps: { oauth: OAuthService; backend: FridgieBackend }) {
  const { oauth, backend } = deps
  const app = new Hono()
  const limiter = attemptLimiter(10, 10 * 60 * 1000)

  // Browser-based MCP clients (the MCP Inspector, web IDEs) discover and call
  // these cross-origin. Claude itself calls them server-to-server.
  const openCors = cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', 'Mcp-Protocol-Version', 'Mcp-Session-Id', 'Last-Event-ID'],
    exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'],
  })
  app.use('/.well-known/*', openCors)
  app.use(MCP_PATH, openCors)
  app.use('/oauth/token', openCors)
  app.use('/oauth/register', openCors)
  app.use('/oauth/revoke', openCors)

  // ── Discovery ────────────────────────────────────────────────────────────

  const protectedResource = (c: Context) => {
    const base = publicBaseUrl(c)
    return c.json({
      resource: `${base}${MCP_PATH}`,
      authorization_servers: [base],
      scopes_supported: [FRIDGIE_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Fridgie',
      resource_documentation: 'https://fridgie.ca',
    })
  }
  app.get('/.well-known/oauth-protected-resource', protectedResource)
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, protectedResource)

  const authorizationServer = (c: Context) => {
    const base = publicBaseUrl(c)
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: [FRIDGIE_SCOPE],
      service_documentation: 'https://fridgie.ca',
    })
  }
  app.get('/.well-known/oauth-authorization-server', authorizationServer)
  app.get(`/.well-known/oauth-authorization-server${MCP_PATH}`, authorizationServer)

  // ── Registration (RFC 7591) ─────────────────────────────────────────────

  app.post('/oauth/register', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return oauthError(c, new OAuthError('invalid_client_metadata', 'Expected a JSON body'))
    }
    try {
      c.header('Cache-Control', 'no-store')
      return c.json(await oauth.registerClient(body), 201)
    } catch (error) {
      if (error instanceof OAuthError) return oauthError(c, error)
      throw error
    }
  })

  // ── Authorization ────────────────────────────────────────────────────────

  /**
   * Validates an authorization request. Problems with the client or its
   * redirect URI are shown on our own page — redirecting to an unverified URI
   * is how an open redirector happens. Everything else goes back to the client
   * as an OAuth error on its (now verified) redirect URI.
   */
  async function checkAuthorizeRequest(params: Record<string, string | undefined>) {
    const client = params.client_id ? await oauth.getClient(params.client_id) : null
    if (!client) return { page: 'This app isn\'t registered with Fridgie.' } as const
    const redirectUri = params.redirect_uri
    if (!redirectUri || !oauth.redirectAllowed(client, redirectUri)) {
      return { page: 'This app asked to send you somewhere Fridgie doesn\'t recognise.' } as const
    }
    const fail = (error: string, description: string) =>
      ({ redirect: withParams(redirectUri, { error, error_description: description, state: params.state }) }) as const
    if (params.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported')
    if (params.code_challenge_method !== 'S256' || !isValidChallenge(params.code_challenge)) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required')
    }
    return { client, clientId: params.client_id!, redirectUri, codeChallenge: params.code_challenge! } as const
  }

  const carried = (params: Record<string, string | undefined>) =>
    Object.fromEntries(AUTHORIZE_PARAMS.filter((k) => params[k] !== undefined).map((k) => [k, params[k]!]))

  const pageHeaders = (c: Context) => {
    c.header('Cache-Control', 'no-store')
    c.header('X-Frame-Options', 'DENY')
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
    c.header('Referrer-Policy', 'no-referrer')
  }

  app.get('/oauth/authorize', async (c) => {
    pageHeaders(c)
    const params = c.req.query()
    const check = await checkAuthorizeRequest(params)
    if ('page' in check) return c.html(renderErrorPage(check.page!), 400)
    if ('redirect' in check) return c.redirect(check.redirect!, 302)
    return c.html(renderAuthorizePage({
      clientName: check.client.clientName,
      redirectHost: redirectLabel(check.redirectUri),
      params: carried(params),
    }))
  })

  app.post('/oauth/authorize', async (c) => {
    pageHeaders(c)
    const params = await formOrJson(c)
    const check = await checkAuthorizeRequest(params)
    if ('page' in check) return c.html(renderErrorPage(check.page!), 400)
    if ('redirect' in check) return c.redirect(check.redirect!, 303)

    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    const again = (error: string, status: 400 | 429) => c.html(renderAuthorizePage({
      clientName: check.client.clientName,
      redirectHost: redirectLabel(check.redirectUri),
      params: carried(params),
      linkCode: params.link_code,
      error,
    }), status)

    if (limiter.blocked(ip)) return again('Too many attempts. Wait a few minutes and get a new code from the app.', 429)

    const approved = await oauth.approve({
      client: check.client,
      clientId: check.clientId,
      redirectUri: check.redirectUri,
      codeChallenge: check.codeChallenge,
      linkCode: params.link_code ?? '',
    })
    if (!approved) {
      limiter.fail(ip)
      return again('That code didn\'t work. Codes last 10 minutes and can be used once — get a fresh one from the app.', 400)
    }

    return c.redirect(withParams(check.redirectUri, { code: approved.code, state: params.state }), 303)
  })

  // ── Tokens ───────────────────────────────────────────────────────────────

  app.post('/oauth/token', async (c) => {
    const body = await formOrJson(c)
    const basic = basicCredentials(c.req.header('authorization'))
    const clientId = basic.id ?? body.client_id
    const secret = basic.secret ?? body.client_secret
    try {
      await oauth.authenticateClient(clientId, secret)
      let tokens
      if (body.grant_type === 'authorization_code') {
        tokens = await oauth.exchangeCode({
          clientId: clientId!,
          code: body.code,
          codeVerifier: body.code_verifier,
          redirectUri: body.redirect_uri,
        })
      } else if (body.grant_type === 'refresh_token') {
        tokens = await oauth.refresh({ clientId: clientId!, refreshToken: body.refresh_token })
      } else {
        throw new OAuthError('unsupported_grant_type', 'Supported: authorization_code, refresh_token')
      }
      c.header('Cache-Control', 'no-store')
      c.header('Pragma', 'no-cache')
      return c.json(tokens)
    } catch (error) {
      if (error instanceof OAuthError) return oauthError(c, error)
      throw error
    }
  })

  app.post('/oauth/revoke', async (c) => {
    const body = await formOrJson(c)
    const basic = basicCredentials(c.req.header('authorization'))
    const clientId = basic.id ?? body.client_id
    try {
      await oauth.authenticateClient(clientId, basic.secret ?? body.client_secret)
    } catch (error) {
      if (error instanceof OAuthError) return oauthError(c, error)
      throw error
    }
    // RFC 7009 §2.2: an unknown token is still a 200.
    if (body.token) await oauth.revokeToken(body.token, clientId!)
    return c.body(null, 200)
  })

  // ── MCP (Streamable HTTP, stateless) ────────────────────────────────────

  app.all(MCP_PATH, async (c) => {
    const base = publicBaseUrl(c)
    const token = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]?.trim()
    const access = token ? await oauth.verifyAccessToken(token) : null
    if (!access) {
      // The pointer to our metadata is how a client discovers it needs to
      // sign in at all (MCP authorization spec, RFC 9728 §5.1).
      const challenge = [`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${MCP_PATH}"`]
      if (token) challenge.push('error="invalid_token"', 'error_description="The access token is invalid or expired"')
      c.header('WWW-Authenticate', challenge.join(', '))
      return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }, 401)
    }

    // Stateless: every POST is a whole exchange, so there is no stream to GET
    // and no session to DELETE.
    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST')
      return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, 405)
    }

    const server = createFridgieMcpServer({
      uid: access.uid,
      ...(access.groupId ? { groupId: access.groupId } : {}),
      ...(access.timezone ? { timezone: access.timezone } : {}),
    }, backend)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    try {
      return await transport.handleRequest(c.req.raw, {
        authInfo: {
          token: token!,
          clientId: access.clientId,
          scopes: [FRIDGIE_SCOPE],
          expiresAt: Math.floor(access.expiresAtMs / 1000),
          extra: { uid: access.uid },
        },
      })
    } finally {
      void server.close()
    }
  })

  return app
}
