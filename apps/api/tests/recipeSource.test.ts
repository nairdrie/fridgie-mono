import { describe, expect, test } from 'bun:test'
import { hasPublicSource, sourceDocId, sourceKeyFor, tiktokSourceKey } from '../utils/recipeSource'

describe('sourceKeyFor: TikTok', () => {
  test('two people sharing one video land on the same key', () => {
    // This is the whole point of the key. Share sheets, `?is_from_webapp=1`
    // tails and the trailing slash all vary between one person and the next;
    // the video id does not.
    const canonical = sourceKeyFor('https://www.tiktok.com/@chef/video/7311982')
    expect(canonical).toBe('tiktok:7311982')
    expect(sourceKeyFor('https://tiktok.com/@chef/video/7311982/')).toBe(canonical)
    expect(sourceKeyFor('https://www.tiktok.com/@chef/video/7311982?is_from_webapp=1&sender_device=pc')).toBe(canonical)
    // Reposted under a different handle is still the same video.
    expect(sourceKeyFor('https://www.tiktok.com/@someoneelse/video/7311982')).toBe(canonical)
  })

  test('reads the older /v/ path', () => {
    expect(sourceKeyFor('https://m.tiktok.com/v/7311982.html')).toBe('tiktok:7311982')
  })

  test('a short link falls back to a key of its own', () => {
    // Nothing here can resolve the redirect, so `vm.tiktok.com/ZMabc/` cannot
    // be deduped against the canonical URL — but it must still be stable, and
    // it must not collide with another short link.
    const key = sourceKeyFor('https://vm.tiktok.com/ZMabc123/')
    expect(key).toBe('web:vm.tiktok.com/ZMabc123')
    expect(key).not.toBe(sourceKeyFor('https://vm.tiktok.com/ZMxyz789/'))
  })

  test('a lookalike host is not filed under TikTok', () => {
    expect(sourceKeyFor('https://nottiktok.com/@chef/video/7311982')).toBe('web:nottiktok.com/@chef/video/7311982')
  })

  test('tiktokSourceKey agrees with the URL parser', () => {
    expect(sourceKeyFor('https://www.tiktok.com/@chef/video/7311982')).toBe(tiktokSourceKey('7311982'))
  })
})

describe('sourceKeyFor: the open web', () => {
  test('normalises host case, www and the trailing slash', () => {
    const key = sourceKeyFor('https://www.Example.com/recipes/pasta/')
    expect(key).toBe('web:example.com/recipes/pasta')
    expect(sourceKeyFor('https://example.com/recipes/pasta')).toBe(key)
  })

  test('drops tracking query strings', () => {
    expect(sourceKeyFor('https://example.com/r/pasta?utm_source=pinterest&fbclid=x'))
      .toBe('web:example.com/r/pasta')
  })

  test('different pages keep different keys', () => {
    expect(sourceKeyFor('https://example.com/r/pasta')).not.toBe(sourceKeyFor('https://example.com/r/curry'))
  })
})

describe('sourceKeyFor: what is not a source', () => {
  test('returns null for anything that is not a fetchable page', () => {
    expect(sourceKeyFor(undefined)).toBeNull()
    expect(sourceKeyFor(null)).toBeNull()
    expect(sourceKeyFor('')).toBeNull()
    expect(sourceKeyFor('not a url')).toBeNull()
    // A recipe read off a photograph has no public original. If either of these
    // produced a key, the photo importer's output would qualify for Explore.
    expect(sourceKeyFor('data:image/jpeg;base64,abc')).toBeNull()
    expect(sourceKeyFor('javascript:alert(1)')).toBeNull()
    expect(sourceKeyFor('file:///Users/me/recipe.html')).toBeNull()
  })

  test('hasPublicSource follows the same rule', () => {
    expect(hasPublicSource('https://www.tiktok.com/@chef/video/7311982')).toBe(true)
    expect(hasPublicSource('data:image/jpeg;base64,abc')).toBe(false)
    expect(hasPublicSource(undefined)).toBe(false)
  })
})

describe('sourceDocId', () => {
  test('removes the slashes Firestore rejects, without merging distinct keys', () => {
    expect(sourceDocId('tiktok:7311982')).toBe('tiktok:7311982')
    expect(sourceDocId('web:example.com/r/pasta')).toBe('web:example.com|r|pasta')
    expect(sourceDocId('web:example.com/r/pasta')).not.toContain('/')
    expect(sourceDocId('web:example.com/r/pasta'))
      .not.toBe(sourceDocId('web:example.com/r/curry'))
  })
})
