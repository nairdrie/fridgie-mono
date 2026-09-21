import { describe, expect, mock, test } from 'bun:test';
import fixtures from './fixtures/supadata-transcripts.json';
import { captionContainsRecipe, createSupadataTranscriber, transcriptSourceUrl, TranscriptError } from '../utils/supadata';
import { PublicFetchError, type PublicFetchOptions } from '../utils/publicFetch';

const url = 'https://www.instagram.com/reel/Fridgie_123/';
const response = (body: unknown, status = 200) => ({ data: Buffer.from(JSON.stringify(body)), status, headers: {}, url: 'https://api.supadata.ai/v1/transcript' });
function setup(sequence: { body: unknown; status?: number }[], options: { cacheLimit?: number; maxInFlight?: number } = {}) {
  let now = 0;
  let next = 0;
  const fetcher = mock(async (_url: string, _options: PublicFetchOptions) => {
    const item = sequence[Math.min(next++, sequence.length - 1)]!;
    return response(item.body, item.status);
  });
  const transcribe = createSupadataTranscriber({ fetcher, getApiKey: () => 'fixture-only-key', now: () => now, sleep: async ms => { now += ms; }, ...options });
  return { transcribe, fetcher, advance: (ms: number) => { now += ms; } };
}

describe('Supadata public video adapter', () => {
  test('uses documented REST parameters and keeps credentials on the fixed API host', async () => {
    const { transcribe, fetcher } = setup([{ body: fixtures.immediate }]);
    expect(await transcribe(`${url}?igsh=tracking`)).toEqual({ text: fixtures.immediate.content, language: 'en' });
    const [request, options] = fetcher.mock.calls[0]!;
    const endpoint = new URL(request);
    expect(endpoint.origin + endpoint.pathname).toBe('https://api.supadata.ai/v1/transcript');
    expect(endpoint.searchParams.get('url')).toBe(url);
    expect(endpoint.searchParams.get('text')).toBe('true');
    expect(endpoint.searchParams.get('mode')).toBe('auto');
    expect(options.headers?.['x-api-key']).toBe('fixture-only-key');
    expect(options.maxRedirects).toBe(0);
    expect(options.timeoutMs).toBe(120_000);
    expect(options.maxBytes).toBe(1024 * 1024);
    expect(options.allowedHosts?.('api.supadata.ai')).toBe(true);
    expect(options.allowedHosts?.('api.supadata.ai.attacker.test')).toBe(false);
  });
  test('polls HTTP 202 through queued and active to the flat REST completed response', async () => {
    const { transcribe, fetcher } = setup([
      { body: fixtures.accepted, status: 202 }, { body: fixtures.queued }, { body: fixtures.active }, { body: fixtures.completed },
    ]);
    expect((await transcribe(url)).text).toBe(fixtures.completed.content);
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const [request] of fetcher.mock.calls.slice(1)) expect(request).toBe('https://api.supadata.ai/v1/transcript/fixture-job-123');
  });
  test('also accepts chunk responses and completed result wrappers', async () => {
    expect((await setup([{ body: fixtures.chunks }]).transcribe(url)).text).toBe('Drain 1 can chickpeas.\nToss with 2 tbsp lemon juice.');
    const { transcribe } = setup([{ body: fixtures.accepted, status: 202 }, { body: { status: 'completed', result: fixtures.chunks } }]);
    expect((await transcribe(url)).language).toBe('en');
  });
  test('empty speech is a valid empty result and does not trigger another paid request', async () => {
    const { transcribe, fetcher } = setup([{ body: fixtures.empty }]);
    expect((await transcribe(url)).text).toBe('');
    expect((await transcribe(url)).text).toBe('');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  test('has a total deadline for queued jobs, not a fresh deadline per poll', async () => {
    const { transcribe, fetcher } = setup([{ body: fixtures.accepted, status: 202 }, { body: fixtures.active }]);
    await expect(transcribe(url, { timeoutMs: 5_000 })).rejects.toMatchObject({ code: 'TRANSCRIPT_TIMEOUT', status: 504 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  test('maps HTTP errors and never exposes provider details or retries paid requests', async () => {
    for (const [status, code] of [[206, 'TRANSCRIPT_UNAVAILABLE'], [401, 'TRANSCRIPT_UNAVAILABLE'], [402, 'TRANSCRIPT_UNAVAILABLE'], [403, 'TRANSCRIPT_UNAVAILABLE'], [404, 'TRANSCRIPT_UNAVAILABLE'], [429, 'TRANSCRIPT_RATE_LIMITED'], [500, 'TRANSCRIPT_UNAVAILABLE'], [504, 'TRANSCRIPT_TIMEOUT']] as const) {
      const { transcribe, fetcher } = setup([{ status, body: { error: 'private-provider-detail', message: 'sensitive fixture-only-key' } }]);
      try { await transcribe(url); throw new Error('Expected rejection'); } catch (error) {
        expect(error).toBeInstanceOf(TranscriptError);
        expect((error as TranscriptError).code).toBe(code);
        expect((error as Error).message).not.toContain('sensitive');
        expect((error as Error).message).not.toContain('fixture-only-key');
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  test('failed and malformed jobs are sanitized and cannot alter polling destination', async () => {
    for (const body of [fixtures.failed, { status: 'unknown' }, { status: 'completed' }]) {
      const { transcribe } = setup([{ status: 202, body: fixtures.accepted }, { body }]);
      await expect(transcribe(url)).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
    }
    const { transcribe, fetcher } = setup([{ status: 202, body: { jobId: '../../?secret=foo' } }]);
    await expect(transcribe(url)).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  test('missing configuration and network failures are sanitized', async () => {
    const fetcher = mock(async () => { throw new Error('Secret-bearing network detail'); });
    await expect(createSupadataTranscriber({ getApiKey: () => undefined, fetcher })(url)).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE', status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(createSupadataTranscriber({ getApiKey: () => 'fixture-only-key', fetcher })(url)).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE', status: 502 });
    const slow = createSupadataTranscriber({ getApiKey: () => 'fixture-only-key', fetcher: async () => { throw new PublicFetchError('FETCH_FAILED', 'The website took too long to respond.'); } });
    await expect(slow(url)).rejects.toMatchObject({ code: 'TRANSCRIPT_TIMEOUT', status: 504 });
  });
  test('deduplicates concurrent requests and caches canonical post identities', async () => {
    const { transcribe, fetcher } = setup([{ body: fixtures.immediate }]);
    const [one, two] = await Promise.all([transcribe(url), transcribe('https://m.instagram.com/p/Fridgie_123/?igsh=another')]);
    expect(one).toEqual(two);
    expect(fetcher).toHaveBeenCalledTimes(1);
    one.text = 'mutated';
    expect((await transcribe(url)).text).toBe(fixtures.immediate.content);
  });
  test('expires cache entries, uses a shorter no-speech TTL and bounds cache size', async () => {
    const { transcribe, fetcher, advance } = setup([{ body: fixtures.immediate }], { cacheLimit: 1 });
    await transcribe(url);
    await transcribe('https://www.instagram.com/reel/Other_123/');
    await transcribe(url);
    expect(fetcher).toHaveBeenCalledTimes(3);
    advance(6 * 60 * 60_000 + 1);
    await transcribe(url);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const empty = setup([{ body: fixtures.empty }]);
    await empty.transcribe(url);
    empty.advance(5 * 60_000 + 1);
    await empty.transcribe(url);
    expect(empty.fetcher).toHaveBeenCalledTimes(2);
  });
  test('bounds distinct simultaneous jobs while allowing duplicates to share one', async () => {
    let finish!: () => void;
    const fetcher = mock(async () => { await new Promise<void>(resolve => { finish = resolve; }); return response(fixtures.immediate); });
    const transcribe = createSupadataTranscriber({ fetcher, getApiKey: () => 'fixture-only-key', maxInFlight: 1 });
    const first = transcribe(url);
    const duplicate = transcribe(url);
    await expect(transcribe('https://www.instagram.com/reel/Other_123/')).rejects.toMatchObject({ code: 'TRANSCRIPT_RATE_LIMITED' });
    finish();
    await Promise.all([first, duplicate]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  test('rejects unsupported/private-address inputs before looking up the key', async () => {
    const getApiKey = mock(() => 'fixture-only-key');
    const transcribe = createSupadataTranscriber({ getApiKey });
    for (const link of ['http://127.0.0.1/video.mp4', 'https://example.com/video.mp4', 'https://www.instagram.com/creator/', 'https://www.instagram.com/stories/creator/123/', 'https://www.tiktok.com/@creator', 'https://www.tiktok.com.evil.test/@creator/video/123']) {
      await expect(transcribe(link)).rejects.toBeInstanceOf(Error);
    }
    expect(getApiKey).not.toHaveBeenCalled();
  });
  test('normalizes supported TikTok and Instagram share/tracking forms', () => {
    for (const link of ['https://vm.tiktok.com/Token123/?k=1', 'https://vt.tiktok.com/Token123/', 'https://www.tiktok.com/t/Token123/', 'https://www.tiktok.com/@cook/video/7311982?is_from_webapp=1', 'https://www.tiktok.com/v/7311982.html', 'https://www.instagram.com/share/reel/Token123/?igsh=foo']) {
      expect(transcriptSourceUrl(link)).not.toContain('?');
    }
  });
  test('only skips audio for a clearly complete written recipe', () => {
    expect(captionContainsRecipe('My favorite chickpea bowl! #recipe')).toBe(false);
    expect(captionContainsRecipe('Ingredients: 1 can chickpeas, 2 tbsp lemon juice. Full recipe in bio!')).toBe(false);
    expect(captionContainsRecipe('Lemon chickpea salad\nIngredients:\n1 can chickpeas\n2 tbsp lemon juice\n2 tbsp olive oil\nInstructions:\nDrain the chickpeas and add them to a large bowl. Toss with lemon juice and olive oil, then serve immediately.')).toBe(true);
  });
});
