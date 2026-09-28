// Pure OAuth building blocks for the Claude connector: nothing here touches
// Firebase or the network, so every rule is pinned by tests/mcpOauth.test.ts.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** The one scope there is: everything the connector's tools can do. */
export const FRIDGIE_SCOPE = 'fridgie'

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 // 1 hour
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 60 // 60 days, rolling
export const AUTH_CODE_TTL_SECONDS = 5 * 60
export const LINK_CODE_TTL_SECONDS = 10 * 60

/**
 * No 0/O, 1/I/L: the code is read off a phone and typed on another screen, and
 * a character the reader has to guess at is a failed link. 31 symbols over 8
 * characters is ~40 bits, against a code that lives ten minutes and is spent
 * on first use.
 */
const LINK_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const LINK_CODE_LENGTH = 8

export function generateLinkCode(): string {
  // Rejection sampling, so no symbol is likelier than another.
  const limit = 256 - (256 % LINK_CODE_ALPHABET.length)
  let out = ''
  while (out.length < LINK_CODE_LENGTH) {
    for (const byte of randomBytes(16)) {
      if (byte < limit && out.length < LINK_CODE_LENGTH) out += LINK_CODE_ALPHABET[byte % LINK_CODE_ALPHABET.length]
    }
  }
  return out
}

/** `ABCD-EFGH`, the way the app shows it. */
export const formatLinkCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

/**
 * What the user typed, as the code it was meant to be: case, spaces and the
 * dash don't matter. Anything outside the alphabet can't be a code.
 */
export function normalizeLinkCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const cleaned = input.toUpperCase().replace(/[\s\-_.]/g, '')
  if (cleaned.length !== LINK_CODE_LENGTH) return null
  for (const ch of cleaned) if (!LINK_CODE_ALPHABET.includes(ch)) return null
  return cleaned
}

/** An opaque bearer secret. Only its hash is ever stored. */
export const generateToken = (prefix: 'fat' | 'frt' | 'fac' | 'fcs') =>
  `${prefix}_${randomBytes(32).toString('base64url')}`

export const generateId = () => randomBytes(16).toString('hex')

export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex')

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** RFC 7636 §4.1: 43–128 unreserved characters. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/

/** RFC 7636 S256. Plain is not supported — OAuth 2.1 drops it. */
export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !VERIFIER_PATTERN.test(verifier)) return false
  const computed = createHash('sha256').update(verifier).digest('base64url')
  return safeEqual(computed, challenge)
}

/** A challenge is the base64url of a SHA-256: exactly 43 characters. */
export const isValidChallenge = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9\-_]{43}$/.test(value)

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'])

/**
 * Whether a client may register this redirect URI.
 *
 * https anywhere; plain http only back to the user's own machine, which is how
 * Claude Code and other desktop clients receive the code; and a private-use
 * scheme (`cursor://…`) for native apps. Never one with a fragment, which the
 * code would be lost in.
 */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.hash) return false
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname)
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return false
  // Private-use URI scheme (RFC 8252 §7.1): must look like a real scheme.
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol)
}

/**
 * Whether `requested` is one of the URIs the client registered.
 *
 * Exact match, except that a loopback URI may differ in PORT (RFC 8252 §7.3):
 * a desktop client picks a free port each time it listens.
 */
export function matchesRegisteredRedirect(requested: string, registered: string[]): boolean {
  if (registered.includes(requested)) return true
  let req: URL
  try {
    req = new URL(requested)
  } catch {
    return false
  }
  if (req.protocol !== 'http:' || !LOOPBACK_HOSTS.has(req.hostname)) return false
  return registered.some((uri) => {
    try {
      const reg = new URL(uri)
      return reg.protocol === 'http:'
        && reg.hostname === req.hostname
        && reg.pathname === req.pathname
        && reg.search === req.search
    } catch {
      return false
    }
  })
}

/** Appends OAuth response parameters to a redirect URI, keeping its own query. */
export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

/** The host a redirect will send the user to, for the consent page to name. */
export function redirectLabel(uri: string): string {
  try {
    const url = new URL(uri)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.host
    return url.protocol.replace(/:$/, '')
  } catch {
    return uri
  }
}
