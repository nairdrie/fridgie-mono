import { describe, expect, test } from 'bun:test';
import { createRecipeImportGuard, extractRecipeImportUrl, parseRecipeImportInput, recipeImportProblem, recipeSourceLabel } from './recipeImport';

describe('recipe links pasted or received from another app', () => {
  test.each([
    ['A dinner worth keeping! https://www.tiktok.com/@cook/video/123456789 (TikTok)', 'https://www.tiktok.com/@cook/video/123456789'],
    ['Watch this recipe: (https://vm.tiktok.com/AbCdEf/).', 'https://vm.tiktok.com/AbCdEf/'],
    ['Check this out https://www.instagram.com/reel/ABC_def123/?igsh=MTIz==', 'https://www.instagram.com/reel/ABC_def123/?igsh=MTIz=='],
    ['https://www.instagram.com/cook/reel/ABC_def123/', 'https://www.instagram.com/cook/reel/ABC_def123/'],
    ['www.instagram.com/p/ABC_def123/', 'https://www.instagram.com/p/ABC_def123/'],
    ['From Instagram: instagram.com/share/reel/ABC_def123/', 'https://instagram.com/share/reel/ABC_def123/'],
    ['https://instagr.am/p/ABC_def123/', 'https://instagr.am/p/ABC_def123/'],
    ['recipes.example.com/pasta', 'https://recipes.example.com/pasta'],
    ["My favourite 'https://recipes.example.com/pasta'", 'https://recipes.example.com/pasta'],
    ['https://recipes.example.com/pasta_(vegan)', 'https://recipes.example.com/pasta_(vegan)'],
    ['https://recipes.example.com/a https://recipes.example.com/a', 'https://recipes.example.com/a'],
  ])('extracts one URL from %s', (input, expected) => {
    expect(extractRecipeImportUrl(input)).toBe(expected);
  });

  test.each([
    '', 'a delicious bowl of noodles', 'cook@example.com', 'file:///private/image.jpg',
    'javascript:alert(1)', 'http://localhost/recipe', 'http://127.0.0.1/recipe',
    'http://[::1]/recipe', 'http://router.local/recipe', 'https://name:password@example.com/recipe',
    'https://example.com:8080/recipe', 'https://instagram.com/cook/',
    'https://instagram.com/', 'https://example.com/a https://example.com/b',
  ])('rejects unsafe, absent, profile-only, or ambiguous input: %s', input => {
    expect(extractRecipeImportUrl(input)).toBeNull();
    expect(parseRecipeImportInput(input)).toHaveProperty('error');
  });

  test('keeps source labels accurate, including social subdomains and aliases', () => {
    expect(recipeSourceLabel('https://vt.tiktok.com/abcdef/')).toBe('TikTok');
    expect(recipeSourceLabel('https://www.instagram.com/p/ABC_def123/')).toBe('Instagram');
    expect(recipeSourceLabel('https://instagr.am/p/ABC_def123/')).toBe('Instagram');
    expect(recipeSourceLabel('https://tiktok.com.example.org/recipe')).toBe('tiktok.com.example.org');
    expect(recipeSourceLabel('not a url')).toBe('the web');
  });
});

describe('actionable import problems', () => {
  test.each(['INSTAGRAM_LOGIN_REQUIRED', 'VIDEO_UNAVAILABLE', 'UNSUPPORTED_VIDEO_URL', 'INVALID_URL', 'UNSAFE_URL', 'SOURCE_TOO_LARGE', 'RECIPE_NOT_FOUND', 'NO_CONTENT'])('%s asks for a different source instead of an endless retry', code => {
    expect(recipeImportProblem(new Error(code)).retryable).toBe(false);
  });
  test.each(['FETCH_FAILED', 'INSTAGRAM_RATE_LIMITED', 'Network request failed'])('%s offers retry', code => {
    expect(recipeImportProblem(new Error(code)).retryable).toBe(true);
  });
  test('provides screenshot fallback for private or login-only Instagram posts', () => {
    expect(recipeImportProblem(new Error('INSTAGRAM_LOGIN_REQUIRED')).message).toContain('screenshots');
  });
  test.each([
    ['TRANSCRIPT_UNAVAILABLE', 503, 'Couldn’t read the video’s speech'],
    ['TRANSCRIPT_TIMEOUT', 504, 'This import needs more time'],
    ['TRANSCRIPT_RATE_LIMITED', 429, 'Video transcription is busy'],
  ])('%s preserves retry and screenshot recovery for API response bodies', (code, status, title) => {
    const error = Object.assign(new Error(JSON.stringify({ error: code })), { status });
    expect(recipeImportProblem(error)).toMatchObject({ title, retryable: true });
    expect(recipeImportProblem(error).message).toContain('screenshots');
  });
  test('does not label a transcript or unspecified rate limit as an Instagram problem', () => {
    const generic = Object.assign(new Error('Too many requests'), { status: 429 });
    expect(recipeImportProblem(generic).title).toBe('Recipe import is busy');
    const instagram = Object.assign(new Error('{"error":"INSTAGRAM_RATE_LIMITED"}'), { status: 429 });
    expect(recipeImportProblem(instagram).title).toBe('Give Instagram a moment');
  });
  test('a client deadline retains the link and offers another attempt', () => {
    const error = Object.assign(new Error('The server did not respond within 240s.'), { status: 0 });
    expect(recipeImportProblem(error)).toMatchObject({ title: 'This import needs more time', retryable: true });
    expect(recipeImportProblem(error).message).toContain('Your link is still here');
  });
});

describe('async draft isolation and one import per share request', () => {
  test('a closed or replaced draft ignores late import completions', async () => {
    const guard = createRecipeImportGuard();
    let result = '';
    const old = guard.begin();
    const completion = Promise.resolve('old recipe').then(value => {
      if (guard.isCurrent(old)) result = value;
    });
    guard.invalidate();
    const current = guard.begin();
    await completion;
    expect(result).toBe('');
    expect(guard.isCurrent(current)).toBe(true);
    expect(guard.isCurrent(old)).toBe(false);
  });
  test('rerenders/reopening consume a stable request only once, while a new share of the same link is allowed', () => {
    const guard = createRecipeImportGuard();
    expect(guard.consumeShare('share-1')).toBe(true);
    guard.invalidate();
    expect(guard.consumeShare('share-1')).toBe(false);
    expect(guard.consumeShare('share-2')).toBe(true);
  });
});
