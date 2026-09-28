import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  formatLinkCode,
  generateLinkCode,
  isAllowedRedirectUri,
  isValidChallenge,
  LINK_CODE_LENGTH,
  matchesRegisteredRedirect,
  normalizeLinkCode,
  verifyPkce,
  withParams,
} from '../mcp/oauthCore'
import { resolveWeek } from '../mcp/weeks'

const challengeFor = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

describe('link codes', () => {
  test('are 8 unambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateLinkCode()
      expect(code).toHaveLength(LINK_CODE_LENGTH)
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]+$/)
    }
  })

  test('read back however the user typed them', () => {
    const code = generateLinkCode()
    expect(normalizeLinkCode(formatLinkCode(code))).toBe(code)
    expect(normalizeLinkCode(` ${formatLinkCode(code).toLowerCase()} `)).toBe(code)
    expect(normalizeLinkCode(code.split('').join(' '))).toBe(code)
  })

  test('reject anything that cannot be a code', () => {
    expect(normalizeLinkCode('ABCD-EFG')).toBeNull()
    expect(normalizeLinkCode('ABCD-EFGHJ')).toBeNull()
    expect(normalizeLinkCode('ABCD-EFG0')).toBeNull() // 0 is not in the alphabet
    expect(normalizeLinkCode('ABCD-EFGI')).toBeNull()
    expect(normalizeLinkCode(12345678)).toBeNull()
  })
})

describe('PKCE', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

  test('accepts the RFC 7636 appendix B example', () => {
    expect(challengeFor(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    expect(verifyPkce(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true)
  })

  test('rejects a wrong or malformed verifier', () => {
    expect(verifyPkce(verifier.replace('d', 'e'), challengeFor(verifier))).toBe(false)
    expect(verifyPkce('short', challengeFor('short'))).toBe(false)
    expect(verifyPkce(undefined, challengeFor(verifier))).toBe(false)
  })

  test('only a S256-shaped challenge is valid', () => {
    expect(isValidChallenge(challengeFor(verifier))).toBe(true)
    expect(isValidChallenge('plain-verifier')).toBe(false)
  })
})

describe('redirect URIs', () => {
  test('https anywhere, http only to loopback, private-use schemes for native apps', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(isAllowedRedirectUri('http://localhost:33418/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://127.0.0.1:5000/cb')).toBe(true)
    expect(isAllowedRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://evil.example/cb')).toBe(false)
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false)
    expect(isAllowedRedirectUri('data:text/html,hi')).toBe(false)
    expect(isAllowedRedirectUri('https://claude.ai/cb#frag')).toBe(false)
    expect(isAllowedRedirectUri('not a url')).toBe(false)
  })

  test('match exactly, except for a loopback port', () => {
    const registered = ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:1234/callback']
    expect(matchesRegisteredRedirect('https://claude.ai/api/mcp/auth_callback', registered)).toBe(true)
    expect(matchesRegisteredRedirect('https://claude.ai/api/mcp/auth_callback/', registered)).toBe(false)
    expect(matchesRegisteredRedirect('https://claude.com/api/mcp/auth_callback', registered)).toBe(false)
    expect(matchesRegisteredRedirect('http://localhost:9999/callback', registered)).toBe(true)
    expect(matchesRegisteredRedirect('http://localhost:9999/other', registered)).toBe(false)
  })

  test('response parameters keep the client\'s own query', () => {
    expect(withParams('https://a.example/cb?x=1', { code: 'c', state: 's', missing: undefined }))
      .toBe('https://a.example/cb?x=1&code=c&state=s')
  })
})

describe('resolveWeek', () => {
  // Wednesday 2026-09-30, midday in Toronto.
  const now = new Date('2026-09-30T16:00:00Z')

  test('this and next week start on the local Sunday', () => {
    expect(resolveWeek(undefined, 'America/Toronto', now)).toMatchObject({ ok: true, weekStart: '2026-09-27', label: 'this week' })
    expect(resolveWeek('next', 'America/Toronto', now)).toMatchObject({ ok: true, weekStart: '2026-10-04', label: 'next week' })
  })

  test('a date means the week it falls in', () => {
    expect(resolveWeek('2026-10-10', 'America/Toronto', now)).toMatchObject({ ok: true, weekStart: '2026-10-04', label: 'next week' })
    expect(resolveWeek('2026-10-11', 'America/Toronto', now)).toMatchObject({ ok: true, weekStart: '2026-10-11', label: 'the week of 2026-10-11' })
  })

  test('the week is the household\'s, not the server\'s', () => {
    // Saturday 23:30 in Vancouver is already Sunday in UTC.
    const lateSaturday = new Date('2026-10-04T06:30:00Z')
    expect(resolveWeek('this', 'America/Vancouver', lateSaturday)).toMatchObject({ weekStart: '2026-09-27' })
    expect(resolveWeek('this', 'UTC', lateSaturday)).toMatchObject({ weekStart: '2026-10-04' })
  })

  test('rejects nonsense and weeks too far away', () => {
    expect(resolveWeek('someday', 'America/Toronto', now).ok).toBe(false)
    expect(resolveWeek('2026-02-30', 'America/Toronto', now).ok).toBe(false)
    expect(resolveWeek('2028-01-01', 'America/Toronto', now).ok).toBe(false)
  })

  test('falls back to a default zone rather than failing on a bad one', () => {
    expect(resolveWeek('this', 'Not/AZone', now)).toMatchObject({ ok: true, weekStart: '2026-09-27' })
  })
})
