import type { KvStore } from './store'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_CODE_TTL_SECONDS,
  FRIDGIE_SCOPE,
  LINK_CODE_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  generateId,
  generateLinkCode,
  generateToken,
  hashSecret,
  isAllowedRedirectUri,
  matchesRegisteredRedirect,
  normalizeLinkCode,
  safeEqual,
  verifyPkce,
} from './oauthCore'

// Collection names. Secrets (codes, tokens, client secrets) are stored under
// their SHA-256, so a read of the database is not a read of anyone's access.
const CLIENTS = 'mcpClients'
const LINK_CODES = 'mcpLinkCodes'
const AUTH_CODES = 'mcpAuthCodes'
const GRANTS = 'mcpGrants'
const TOKENS = 'mcpTokens'

export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic'

export interface ClientRecord {
  clientName: string
  redirectUris: string[]
  authMethod: ClientAuthMethod
  secretHash?: string
  createdAtMs: number
}

/** A one-time code the app shows, which the authorize page trades for a grant. */
export interface LinkCodeRecord {
  uid: string
  /** The household that was open in the app when the code was made. */
  groupId?: string
  /** The phone's IANA zone, so "this week" means the user's week. */
  timezone?: string
  expiresAtMs: number
}

interface AuthCodeRecord {
  grantId: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  expiresAtMs: number
}

/**
 * One connection between one Fridgie account and one client — what the app's
 * "Connected to Claude" screen lists, and what Disconnect deletes. Every token
 * hangs off a grant, so deleting the grant (and its tokens) is the whole of
 * revocation.
 */
export interface GrantRecord {
  uid: string
  clientId: string
  clientName: string
  groupId?: string
  timezone?: string
  createdAtMs: number
  lastUsedAtMs?: number
  /** Pushed forward on every refresh; a grant nobody refreshes ages out. */
  expiresAtMs: number
}

interface TokenRecord {
  kind: 'access' | 'refresh'
  grantId: string
  uid: string
  clientId: string
  expiresAtMs: number
}

/** Who a verified access token speaks for. */
export interface AccessContext {
  uid: string
  grantId: string
  clientId: string
  groupId?: string
  timezone?: string
  expiresAtMs: number
}

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

/** RFC 6749 §5.2 error, carried back to the token endpoint. */
export class OAuthError extends Error {
  constructor(
    public code: 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unsupported_grant_type' | 'invalid_client_metadata' | 'invalid_redirect_uri',
    public description: string,
    public status = 400,
  ) {
    super(description)
  }
}

export interface RegistrationRequest {
  client_name?: unknown
  redirect_uris?: unknown
  token_endpoint_auth_method?: unknown
  grant_types?: unknown
  response_types?: unknown
  [key: string]: unknown
}

export function createOAuthService(store: KvStore, now: () => number = Date.now) {
  const expired = (record: { expiresAtMs: number } | null | undefined) => !record || record.expiresAtMs <= now()

  async function issueTokens(grantId: string, grant: GrantRecord): Promise<TokenResponse> {
    const access = generateToken('fat')
    const refresh = generateToken('frt')
    const base = { grantId, uid: grant.uid, clientId: grant.clientId }
    const refreshExpiry = now() + REFRESH_TOKEN_TTL_SECONDS * 1000
    await Promise.all([
      store.set<TokenRecord>(TOKENS, hashSecret(access), { ...base, kind: 'access', expiresAtMs: now() + ACCESS_TOKEN_TTL_SECONDS * 1000 }),
      store.set<TokenRecord>(TOKENS, hashSecret(refresh), { ...base, kind: 'refresh', expiresAtMs: refreshExpiry }),
      store.update(GRANTS, grantId, { expiresAtMs: refreshExpiry }),
    ])
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refresh,
      scope: FRIDGIE_SCOPE,
    }
  }

  async function deleteGrant(grantId: string): Promise<void> {
    const tokens = await store.where<TokenRecord>(TOKENS, 'grantId', grantId)
    await Promise.all([
      store.delete(GRANTS, grantId),
      ...tokens.map((t) => store.delete(TOKENS, t.id)),
    ])
  }

  return {
    /** RFC 7591 dynamic client registration. */
    async registerClient(request: RegistrationRequest) {
      const redirectUris = request.redirect_uris
      if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
        throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list between 1 and 10 URIs')
      }
      for (const uri of redirectUris) {
        if (!isAllowedRedirectUri(uri)) throw new OAuthError('invalid_redirect_uri', `Redirect URI not allowed: ${String(uri)}`)
      }
      const grantTypes = Array.isArray(request.grant_types) ? request.grant_types : ['authorization_code', 'refresh_token']
      if (!grantTypes.includes('authorization_code')) {
        throw new OAuthError('invalid_client_metadata', 'Only the authorization_code grant is supported')
      }

      const requestedMethod = request.token_endpoint_auth_method
      const authMethod: ClientAuthMethod =
        requestedMethod === 'client_secret_post' || requestedMethod === 'client_secret_basic' ? requestedMethod : 'none'
      const clientName = typeof request.client_name === 'string' && request.client_name.trim()
        ? request.client_name.trim().slice(0, 100)
        : 'An MCP client'

      const clientId = generateId()
      const secret = authMethod === 'none' ? undefined : generateToken('fcs')
      const record: ClientRecord = {
        clientName,
        redirectUris: redirectUris as string[],
        authMethod,
        createdAtMs: now(),
        ...(secret ? { secretHash: hashSecret(secret) } : {}),
      }
      await store.set(CLIENTS, clientId, record)

      return {
        client_id: clientId,
        client_id_issued_at: Math.floor(record.createdAtMs / 1000),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_name: clientName,
        redirect_uris: record.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: authMethod,
        scope: FRIDGIE_SCOPE,
      }
    },

    getClient(clientId: string) {
      return typeof clientId === 'string' && clientId ? store.get<ClientRecord>(CLIENTS, clientId) : Promise.resolve(null)
    },

    /**
     * Checks a client's credentials at the token endpoint. Public clients have
     * none; confidential ones must present the secret they were issued.
     */
    async authenticateClient(clientId: string | undefined, secret: string | undefined): Promise<ClientRecord> {
      const client = clientId ? await store.get<ClientRecord>(CLIENTS, clientId) : null
      if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401)
      if (client.authMethod !== 'none') {
        if (!secret || !client.secretHash || !safeEqual(hashSecret(secret), client.secretHash)) {
          throw new OAuthError('invalid_client', 'Client authentication failed', 401)
        }
      }
      return client
    },

    redirectAllowed(client: ClientRecord, redirectUri: string) {
      return matchesRegisteredRedirect(redirectUri, client.redirectUris)
    },

    /** Made by the signed-in app; typed by the user on the authorize page. */
    async createLinkCode(uid: string, options: { groupId?: string; timezone?: string } = {}) {
      const code = generateLinkCode()
      const record: LinkCodeRecord = {
        uid,
        expiresAtMs: now() + LINK_CODE_TTL_SECONDS * 1000,
        ...(options.groupId ? { groupId: options.groupId } : {}),
        ...(options.timezone ? { timezone: options.timezone } : {}),
      }
      await store.set(LINK_CODES, hashSecret(code), record)
      return { code, expiresAtMs: record.expiresAtMs }
    },

    /**
     * The user typed a valid link code on the authorize page: spend it, and
     * mint the authorization code the client will trade for tokens.
     *
     * Re-connecting the same client replaces its previous grant rather than
     * adding a second row to the app's list of connections.
     */
    async approve(input: { client: ClientRecord; clientId: string; redirectUri: string; codeChallenge: string; linkCode: string }) {
      const normalized = normalizeLinkCode(input.linkCode)
      if (!normalized) return null
      const link = await store.take<LinkCodeRecord>(LINK_CODES, hashSecret(normalized))
      if (!link || expired(link)) return null

      const previous = await store.where<GrantRecord>(GRANTS, 'uid', link.uid)
      await Promise.all(previous.filter((g) => g.value.clientId === input.clientId).map((g) => deleteGrant(g.id)))

      const grantId = generateId()
      const grant: GrantRecord = {
        uid: link.uid,
        clientId: input.clientId,
        clientName: input.client.clientName,
        createdAtMs: now(),
        // Until the first token is issued, the grant is only as good as its code.
        expiresAtMs: now() + AUTH_CODE_TTL_SECONDS * 1000,
        ...(link.groupId ? { groupId: link.groupId } : {}),
        ...(link.timezone ? { timezone: link.timezone } : {}),
      }
      await store.set(GRANTS, grantId, grant)

      const code = generateToken('fac')
      await store.set<AuthCodeRecord>(AUTH_CODES, hashSecret(code), {
        grantId,
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        expiresAtMs: now() + AUTH_CODE_TTL_SECONDS * 1000,
      })
      return { code, uid: link.uid }
    },

    async exchangeCode(input: { clientId: string; code: unknown; codeVerifier: unknown; redirectUri: unknown }): Promise<TokenResponse> {
      if (typeof input.code !== 'string' || !input.code) throw new OAuthError('invalid_request', 'code is required')
      const record = await store.take<AuthCodeRecord>(AUTH_CODES, hashSecret(input.code))
      if (!record || expired(record)) throw new OAuthError('invalid_grant', 'Authorization code is invalid or expired')
      if (record.clientId !== input.clientId) throw new OAuthError('invalid_grant', 'Authorization code was issued to another client')
      if (input.redirectUri !== undefined && input.redirectUri !== record.redirectUri) {
        throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request')
      }
      if (!verifyPkce(input.codeVerifier, record.codeChallenge)) {
        // The code is already spent, so a failed verifier can't be retried against it.
        await deleteGrant(record.grantId)
        throw new OAuthError('invalid_grant', 'PKCE verification failed')
      }
      const grant = await store.get<GrantRecord>(GRANTS, record.grantId)
      if (!grant) throw new OAuthError('invalid_grant', 'This connection has been removed')
      return issueTokens(record.grantId, grant)
    },

    /** Refresh-token rotation: every refresh spends the old token. */
    async refresh(input: { clientId: string; refreshToken: unknown }): Promise<TokenResponse> {
      if (typeof input.refreshToken !== 'string' || !input.refreshToken) {
        throw new OAuthError('invalid_request', 'refresh_token is required')
      }
      const record = await store.take<TokenRecord>(TOKENS, hashSecret(input.refreshToken))
      if (!record || record.kind !== 'refresh' || expired(record)) {
        throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired')
      }
      if (record.clientId !== input.clientId) throw new OAuthError('invalid_grant', 'Refresh token was issued to another client')
      const grant = await store.get<GrantRecord>(GRANTS, record.grantId)
      if (!grant) throw new OAuthError('invalid_grant', 'This connection has been removed')
      return issueTokens(record.grantId, grant)
    },

    async verifyAccessToken(token: string): Promise<AccessContext | null> {
      if (!token) return null
      const record = await store.get<TokenRecord>(TOKENS, hashSecret(token))
      if (!record || record.kind !== 'access' || expired(record)) return null
      const grant = await store.get<GrantRecord>(GRANTS, record.grantId)
      if (!grant) return null

      // Good enough for "last used" on the connections screen, without a
      // write on every single tool call.
      if (!grant.lastUsedAtMs || now() - grant.lastUsedAtMs > 60 * 60 * 1000) {
        void store.update(GRANTS, record.grantId, { lastUsedAtMs: now() }).catch(() => {})
      }

      return {
        uid: grant.uid,
        grantId: record.grantId,
        clientId: record.clientId,
        expiresAtMs: record.expiresAtMs,
        ...(grant.groupId ? { groupId: grant.groupId } : {}),
        ...(grant.timezone ? { timezone: grant.timezone } : {}),
      }
    },

    /** RFC 7009. Revoking a refresh token ends the whole connection. */
    async revokeToken(token: string, clientId: string): Promise<void> {
      const record = await store.get<TokenRecord>(TOKENS, hashSecret(token))
      if (!record || record.clientId !== clientId) return
      if (record.kind === 'refresh') await deleteGrant(record.grantId)
      else await store.delete(TOKENS, hashSecret(token))
    },

    async listGrants(uid: string) {
      const grants = await store.where<GrantRecord>(GRANTS, 'uid', uid)
      return grants
        .filter((g) => !expired(g.value))
        .sort((a, b) => b.value.createdAtMs - a.value.createdAtMs)
        .map(({ id, value }) => ({
          id,
          clientName: value.clientName,
          createdAt: new Date(value.createdAtMs).toISOString(),
          lastUsedAt: value.lastUsedAtMs ? new Date(value.lastUsedAtMs).toISOString() : null,
        }))
    },

    /** Only the grant's owner may remove it. Returns false if it isn't theirs. */
    async revokeGrant(uid: string, grantId: string): Promise<boolean> {
      const grant = await store.get<GrantRecord>(GRANTS, grantId)
      if (!grant || grant.uid !== uid) return false
      await deleteGrant(grantId)
      return true
    },
  }
}

export type OAuthService = ReturnType<typeof createOAuthService>
