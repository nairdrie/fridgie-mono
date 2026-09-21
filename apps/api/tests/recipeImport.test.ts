import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { createImportHandler } from '../api/recipe/import';
import { collectInstagramSource, parseInstagramPage } from '../utils/instagram';
import { PublicFetchError } from '../utils/publicFetch';
import { sourceKeyFor } from '../utils/recipeSource';
import { TranscriptError } from '../utils/supadata';
import transcripts from './fixtures/supadata-transcripts.json';

const sourceUrl = 'https://www.instagram.com/reel/Fridgie_123/';
const fixture = await Bun.file(`${import.meta.dir}/fixtures/instagram-reel-page.html`).text();
const recipe = () => ({ name: 'Lemon chickpeas', description: 'A bright chickpea bowl.', ingredients: [{ name: 'chickpeas', quantity: '1 can' }, { name: 'lemon juice', quantity: '2 tbsp' }], instructions: ['Toss together.'], tags: ['vegetarian'], category: 'Mains', servings: 2 });
const setup = (overrides: Parameters<typeof createImportHandler>[0] = {}) => {
  const model = mock(async <T>(_options: unknown): Promise<T> => ({ found: true, recipe: recipe() }) as T);
  const frames = mock(async () => [] as string[]);
  const app = new Hono().post('/', createImportHandler({
    completeJson: async <T>(options: unknown) => await model(options) as T,
    sampleVideoFrames: frames,
    // Never consult real provider credentials from the local test environment.
    transcribeVideo: async () => { throw new TranscriptError('TRANSCRIPT_UNAVAILABLE', 503, 'Fixture: provider not configured.'); },
    collectInstagramSource: async url => collectInstagramSource(url, async () => ({ data: Buffer.from(fixture), status: 200, headers: {}, url: sourceUrl })),
    fetchPage: async () => { throw new Error('Unexpected generic page fallback'); },
    ...overrides,
  }));
  return { app, model, frames, request: (url: unknown) => app.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }) };
};

describe('recipe import HTTP contract', () => {
  test('imports a public Instagram caption, preserves attribution and resolves share identity', async () => {
    const { request, model, frames } = setup();
    const response = await request('https://www.instagram.com/share/reel/Token123/?igsh=tracking');
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.sourceUrl).toBe(sourceUrl);
    expect(result.sourceAuthor).toBe('@fixture_cook');
    expect(sourceKeyFor(result.sourceUrl)).toBe('instagram:Fridgie_123');
    expect(result.photoURL).toContain('scontent.cdninstagram.com');
    expect(result.ingredients).toHaveLength(2);
    expect(result.servings).toBe(2);
    expect(model).toHaveBeenCalledTimes(1);
    expect(frames).toHaveBeenCalledTimes(1);
    const prompt = model.mock.calls[0]![0] as { system: string; user: { type: string; text?: string }[] };
    expect(prompt.system).toContain('Never reconstruct a familiar recipe');
    expect(prompt.user.at(-1)?.text).toContain('1 can chickpeas');
  });
  test('passes available frames to the video model in chronological order', async () => {
    let captured: any;
    const { request } = setup({ sampleVideoFrames: async () => ['frame-one', 'frame-two'], completeJson: async <T>(options: unknown) => { captured = options; return { found: true, recipe: recipe() } as T; } });
    expect((await request(sourceUrl)).status).toBe(200);
    expect(captured.user.filter((part: any) => part.type === 'image').map((part: any) => part.source.data)).toEqual(['frame-one', 'frame-two']);
  });
  test('does not call the model with just a creator or cover image', async () => {
    const source = parseInstagramPage(fixture, sourceUrl)!;
    const { request, model } = setup({ collectInstagramSource: async () => ({ ...source, caption: '', videoUrl: null }), transcribeVideo: async () => ({ text: '', language: null }) });
    const response = await request(sourceUrl);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe('RECIPE_NOT_FOUND');
    expect(model).not.toHaveBeenCalled();
  });
  test('retains explicit recipe-not-found and incomplete-recipe behavior', async () => {
    const missing = setup({ completeJson: async <T>() => ({ found: false, recipe: null }) as T, transcribeVideo: async () => ({ text: '', language: null }) });
    expect((await (await missing.request(sourceUrl)).json()).error).toBe('RECIPE_NOT_FOUND');
    const partial = setup({ completeJson: async <T>() => ({ found: true, recipe: { ...recipe(), instructions: [], servings: null } }) as T });
    const result = await (await partial.request(sourceUrl)).json();
    expect(result.instructions).toEqual([]);
    expect(result.servings).toBeUndefined();
  });
  test('returns stable login/rate-limit/unavailable errors without generating', async () => {
    for (const [status, code, expectedStatus] of [[403, 'INSTAGRAM_LOGIN_REQUIRED', 422], [429, 'INSTAGRAM_RATE_LIMITED', 429], [404, 'VIDEO_UNAVAILABLE', 422]] as const) {
      const { request, model } = setup({ collectInstagramSource: async url => collectInstagramSource(url, async () => ({ data: Buffer.alloc(0), status, url: sourceUrl, headers: {} })) });
      const response = await request(sourceUrl);
      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toMatchObject({ error: code, message: expect.any(String) });
      expect(model).not.toHaveBeenCalled();
    }
  });
  test('rejects unsafe/malformed inputs and propagates bounded-source failures', async () => {
    const { request, app, model } = setup();
    for (const value of [null, 42, {}, '', 'x'.repeat(4097)]) expect((await request(value)).status).toBe(400);
    for (const value of ['file:///etc/passwd', 'http://127.1/', 'https://user:pass@www.instagram.com/reel/Fridgie_123/']) expect((await (await request(value)).json()).error).toBe('UNSAFE_URL');
    expect((await app.request('/', { method: 'POST', body: '{' })).status).toBe(400);
    expect(model).not.toHaveBeenCalled();
    const oversized = setup({ collectInstagramSource: async () => { throw new PublicFetchError('SOURCE_TOO_LARGE', 'Too large'); } });
    expect((await (await oversized.request(sourceUrl)).json()).error).toBe('SOURCE_TOO_LARGE');
  });
  test('preserves structured web-recipe name, photo and declared servings', async () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Recipe', name: 'Source title', recipeIngredient: ['2 cans chickpeas'], recipeInstructions: ['Drain the chickpeas.'], recipeYield: 'Serves 3', image: 'https://example.com/dish.jpg', author: { '@type': 'Person', name: 'Source Cook' } })}</script>`;
    const { request } = setup({ fetchPage: async () => html, completeJson: async <T>() => recipe() as T });
    const result = await (await request('https://example.com/recipe')).json();
    expect(result).toMatchObject({ name: 'Source title', photoURL: 'https://example.com/dish.jpg', servings: 3, sourceAuthor: 'Source Cook' });
  });
  test('preserves TikTok caption, cover, canonical watch URL and creator attribution', async () => {
    const { request } = setup({ collectTikTokSource: async () => ({ caption: '1 can chickpeas. Toss with 2 tbsp lemon juice.', author: 'Fixture Cook', authorHandle: 'fixture_cook', videoId: '7311982', transcript: '', photoURL: 'https://p16.tiktokcdn.com/cover.jpg', videoUrl: null, cookieHeader: null, durationSec: null }) });
    const response = await request('https://vm.tiktok.com/Token123/');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceUrl: 'https://www.tiktok.com/@fixture_cook/video/7311982', sourceAuthor: 'Fixture Cook', photoURL: 'https://p16.tiktokcdn.com/cover.jpg' });
  });
  test('uses audio when an Instagram caption is missing or only promotional', async () => {
    for (const caption of ['', 'My favorite salad! Full recipe in bio.']) {
      const source = parseInstagramPage(fixture, sourceUrl)!;
      const audio = mock(async () => ({ text: transcripts.immediate.content, language: 'en' }));
      const { request, model } = setup({ collectInstagramSource: async () => ({ ...source, caption }), transcribeVideo: audio });
      expect((await request(sourceUrl)).status).toBe(200);
      expect(audio).toHaveBeenCalledTimes(1);
      expect((model.mock.calls[0]![0] as any).user.at(-1).text).toContain(transcripts.immediate.content);
    }
  });
  test('provider audio rescues a public link despite a blocked Instagram page', async () => {
    const audio = mock(async () => ({ text: transcripts.immediate.content, language: 'en' }));
    const { request, model } = setup({
      collectInstagramSource: async url => collectInstagramSource(url, async () => ({ data: Buffer.alloc(0), status: 403, url: sourceUrl, headers: {} })),
      transcribeVideo: audio,
    });
    const response = await request(`${sourceUrl}?igsh=tracking`);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.sourceUrl).toBe(sourceUrl);
    expect(result.sourceAuthor).toBeUndefined();
    expect(result.photoURL).toBeUndefined();
    expect(model).toHaveBeenCalledTimes(1);
    expect(audio).toHaveBeenCalledTimes(1);
  });
  test('provider audio rescues a failed TikTok metadata collector and preserves direct identity', async () => {
    const { request } = setup({ collectTikTokSource: async () => { throw new Error('Blocked page'); }, transcribeVideo: async () => ({ text: transcripts.immediate.content, language: 'en' }) });
    const response = await request('https://www.tiktok.com/@cook/video/7311982?tracking=1');
    expect(response.status).toBe(200);
    expect((await response.json()).sourceUrl).toBe('https://www.tiktok.com/@cook/video/7311982');
  });
  test('uses canonical resolved share identity for provider requests', async () => {
    const audio = mock(async (_url: string) => ({ text: transcripts.immediate.content, language: 'en' }));
    const { request } = setup({ transcribeVideo: audio });
    expect((await request('https://www.instagram.com/share/Token123/?igsh=tracking')).status).toBe(200);
    expect(audio.mock.calls[0]![0]).toBe(sourceUrl);
  });
  test('native subtitles or a clearly complete written recipe avoid provider costs', async () => {
    const source = parseInstagramPage(fixture, sourceUrl)!;
    const audio = mock(async () => { throw new Error('Should not call provider'); });
    const native = setup({ collectInstagramSource: async () => ({ ...source, transcript: transcripts.immediate.content }), transcribeVideo: audio });
    expect((await native.request(sourceUrl)).status).toBe(200);
    const fullCaption = 'Lemon chickpea salad\nIngredients:\n1 can chickpeas\n2 tbsp lemon juice\n2 tbsp olive oil\nInstructions:\nDrain the chickpeas and add them to a large bowl. Toss with lemon juice and olive oil, then serve immediately.';
    const written = setup({ collectInstagramSource: async () => ({ ...source, caption: fullCaption }), transcribeVideo: audio });
    expect((await written.request(sourceUrl)).status).toBe(200);
    expect(audio).not.toHaveBeenCalled();
  });
  test('starts frame sampling and audio together, retaining frames when audio fails', async () => {
    const source = parseInstagramPage(fixture, sourceUrl)!;
    let audioStarted = false;
    let finishFrames!: (frames: string[]) => void;
    const { request, model } = setup({
      collectInstagramSource: async () => ({ ...source, caption: '' }),
      sampleVideoFrames: () => new Promise(resolve => { finishFrames = resolve; }),
      transcribeVideo: async () => { audioStarted = true; finishFrames(['actual-frame']); throw new TranscriptError('TRANSCRIPT_UNAVAILABLE', 502, 'Try again.'); },
    });
    expect((await request(sourceUrl)).status).toBe(200);
    expect(audioStarted).toBe(true);
    expect((model.mock.calls[0]![0] as any).user[1].source.data).toBe('actual-frame');
  });
  test('keeps caption evidence despite transcript failure and bounds Claude without retries', async () => {
    const { request, model } = setup({ transcribeVideo: async () => { throw new TranscriptError('TRANSCRIPT_RATE_LIMITED', 429, 'Try again.'); } });
    expect((await request(sourceUrl)).status).toBe(200);
    const options = model.mock.calls[0]![0] as any;
    expect(options.maxRetries).toBe(0);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(90_000);
  });
  test('no remaining evidence returns stable sanitized transcript failures without calling Claude', async () => {
    for (const [code, status] of [['TRANSCRIPT_UNAVAILABLE', 502], ['TRANSCRIPT_TIMEOUT', 504], ['TRANSCRIPT_RATE_LIMITED', 429]] as const) {
      const { request, model } = setup({ collectInstagramSource: async () => { throw new Error('Blocked page'); }, transcribeVideo: async () => { throw new TranscriptError(code, status, 'Retry or import a screenshot.'); } });
      const response = await request(sourceUrl);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code, message: 'Retry or import a screenshot.' });
      expect(model).not.toHaveBeenCalled();
    }
  });
  test('a promotional caption does not hide a retryable audio failure behind recipe-not-found', async () => {
    const source = parseInstagramPage(fixture, sourceUrl)!;
    const { request } = setup({
      collectInstagramSource: async () => ({ ...source, caption: '#pasta' }),
      transcribeVideo: async () => { throw new TranscriptError('TRANSCRIPT_TIMEOUT', 504, 'Please retry.'); },
      completeJson: async <T>() => ({ found: false, recipe: null }) as T,
    });
    const response = await request(sourceUrl);
    expect(response.status).toBe(504);
    expect((await response.json()).error).toBe('TRANSCRIPT_TIMEOUT');
  });
  test('empty speech plus no visual/caption evidence does not generate a recipe', async () => {
    const { request, model } = setup({ collectInstagramSource: async () => { throw new Error('Blocked page'); }, transcribeVideo: async () => ({ text: '', language: 'en' }) });
    const response = await request(sourceUrl);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe('RECIPE_NOT_FOUND');
    expect(model).not.toHaveBeenCalled();
  });
  test('explicitly excludes lyrics from recipe evidence and preserves a negative model result', async () => {
    let prompt = '';
    const { request } = setup({
      collectInstagramSource: async () => { throw new Error('Blocked page'); },
      transcribeVideo: async () => ({ text: transcripts.lyrics.content, language: 'en' }),
      completeJson: async <T>(options: any) => { prompt = options.system; return { found: false, recipe: null } as T; },
    });
    const response = await request(sourceUrl);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe('RECIPE_NOT_FOUND');
    expect(prompt).toContain('If the only transcript is song lyrics, do not infer a recipe');
  });
  test('rejects unsupported links and unsafe collector redirects before invoking the paid provider', async () => {
    const audio = mock(async () => ({ text: transcripts.immediate.content, language: 'en' }));
    const { request } = setup({ transcribeVideo: audio, collectInstagramSource: async () => { throw new PublicFetchError('UNSAFE_URL', 'Unsafe redirect'); } });
    for (const url of ['https://www.instagram.com/creator/', 'https://www.tiktok.com/@creator']) {
      expect((await (await request(url)).json()).error).toBe('UNSUPPORTED_VIDEO_URL');
    }
    expect((await (await request(sourceUrl)).json()).error).toBe('UNSAFE_URL');
    expect(audio).not.toHaveBeenCalled();
  });
  test('model timeouts produce an actionable 504', async () => {
    const { request } = setup({ completeJson: async () => { const error = new Error('SDK timeout'); error.name = 'APIConnectionTimeoutError'; throw error; } });
    const response = await request(sourceUrl);
    expect(response.status).toBe(504);
    expect((await response.json()).error).toBe('IMPORT_TIMEOUT');
  });
});
