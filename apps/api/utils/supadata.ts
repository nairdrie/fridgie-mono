import { fetchPublicUrl, publicUrl, PublicFetchError } from './publicFetch';
import { instagramLink, isInstagramUrl, InstagramImportError } from './instagram';
import { sourceKeyFor } from './recipeSource';
import { isTikTokUrl } from './tiktok';

export type TranscriptErrorCode = 'TRANSCRIPT_UNAVAILABLE' | 'TRANSCRIPT_TIMEOUT' | 'TRANSCRIPT_RATE_LIMITED';
export class TranscriptError extends Error {
  constructor(readonly code: TranscriptErrorCode, readonly status: 429 | 502 | 503 | 504, message: string) {
    super(message);
  }
}

const unavailable = () => new TranscriptError('TRANSCRIPT_UNAVAILABLE', 502,
  'We could not read the audio from that public video. Try again, or import a screenshot of the recipe.');
const timedOut = () => new TranscriptError('TRANSCRIPT_TIMEOUT', 504,
  'Reading the video audio took too long. Try again, or import a screenshot of the recipe.');
const rateLimited = () => new TranscriptError('TRANSCRIPT_RATE_LIMITED', 429,
  'Video transcription is busy right now. Try again shortly, or import a screenshot of the recipe.');

/** Only known social post/share URLs reach the paid API; never arbitrary files. */
export function transcriptSourceUrl(raw: string): string {
  const url = publicUrl(raw);
  if (isInstagramUrl(url.href)) {
    const link = instagramLink(url.href);
    if (link) return link.url;
  } else if (isTikTokUrl(url.href)) {
    const watch = /^\/@([\w.-]+)\/video\/(\d+)\/?$/.exec(url.pathname);
    if (watch) return `https://www.tiktok.com/@${watch[1]}/video/${watch[2]}`;
    const legacy = /^\/v\/(\d+)(?:\.html)?\/?$/.exec(url.pathname);
    if (legacy) return `https://www.tiktok.com/v/${legacy[1]}.html`;
    if ((['vm.tiktok.com', 'vt.tiktok.com'].includes(url.hostname) && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) ||
        (['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(url.hostname) && /^\/t\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))) {
      url.protocol = 'https:';
      url.search = '';
      return url.href;
    }
  }
  throw new InstagramImportError('UNSUPPORTED_VIDEO_URL', 400,
    'Copy the link to a specific public TikTok video or Instagram Reel/post. Profiles and Stories cannot be imported.');
}

/** Conservative cost-saving shortcut; short/promotional captions still need audio. */
export function captionContainsRecipe(caption: string): boolean {
  if (caption.length < 160 || !/\bingredients?\s*[:\n]/i.test(caption) ||
      !/\b(?:method|instructions|directions|steps)\s*[:\n]/i.test(caption)) return false;
  const amounts = caption.match(/\b\d+(?:[./]\d+)?\s*(?:g|kg|ml|l|cups?|tsp|tbsp|tablespoons?|teaspoons?|ounces?|oz|cans?|cloves?)\b/gi) ?? [];
  const actions = caption.match(/\b(?:mix|stir|toss|bake|roast|fry|cook|boil|simmer|blend|whisk|chop|slice|heat|add|drain|serve|combine)\b/gi) ?? [];
  return amounts.length >= 2 && actions.length >= 2;
}

export interface VideoTranscript { text: string; language: string | null }
export interface TranscriptOptions { timeoutMs?: number }
interface AdapterOptions {
  fetcher?: typeof fetchPublicUrl;
  getApiKey?: () => string | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  cacheLimit?: number;
  maxInFlight?: number;
}
const MAX_TRANSCRIPT_CHARS = 20_000;
const MAX_WAIT_MS = 120_000;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const EMPTY_TTL_MS = 5 * 60_000;

function transcriptResult(body: Record<string, unknown>): VideoTranscript {
  const content = body.content;
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && content.every(chunk => chunk && typeof chunk === 'object' && typeof chunk.text === 'string')) {
    text = content.map(chunk => chunk.text).join('\n');
  } else throw unavailable();
  return { text: text.trim().slice(0, MAX_TRANSCRIPT_CHARS), language: typeof body.lang === 'string' ? body.lang.slice(0, 32) : null };
}

/**
 * REST contract: https://docs.supadata.ai/get-transcript. No SDK or retries that
 * can silently create a second billable job. Cache/dedup are per API instance,
 * bounded, and hold transcript text only; no API keys or provider responses.
 */
export function createSupadataTranscriber({
  fetcher = fetchPublicUrl,
  getApiKey = () => process.env.SUPADATA_API_KEY,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  cacheLimit = 128,
  maxInFlight = 32,
}: AdapterOptions = {}) {
  const cache = new Map<string, { result: VideoTranscript; expires: number }>();
  const inFlight = new Map<string, Promise<VideoTranscript>>();

  async function run(url: string, timeoutMs: number): Promise<VideoTranscript> {
    const apiKey = getApiKey();
    if (!apiKey) throw new TranscriptError('TRANSCRIPT_UNAVAILABLE', 503,
      'Video transcription is temporarily unavailable. Import a screenshot of the recipe or try again later.');
    const expires = now() + Math.min(MAX_WAIT_MS, Math.max(1, timeoutMs));

    async function request(endpoint: URL, initial = false): Promise<{ status: number; body: Record<string, unknown> }> {
      const remaining = expires - now();
      if (remaining <= 0) throw timedOut();
      let response: Awaited<ReturnType<typeof fetchPublicUrl>>;
      try {
        response = await fetcher(endpoint.href, {
          // A synchronous generation can take ~100s. Poll reads are short.
          timeoutMs: initial ? remaining : Math.min(15_000, remaining),
          maxBytes: 1024 * 1024, maxRedirects: 0,
          allowedHosts: host => host === 'api.supadata.ai',
          headers: { 'x-api-key': apiKey!, Accept: 'application/json' },
        });
      } catch (error) {
        // Provider bodies, network errors and API credentials never reach logs
        // or the mobile client. A failed request is not automatically resubmitted.
        const fetchTimedOut = error instanceof PublicFetchError && error.code === 'FETCH_FAILED' && error.message === 'The website took too long to respond.';
        throw now() >= expires || fetchTimedOut ? timedOut() : unavailable();
      }
      if (now() >= expires) throw timedOut();
      if (response.status === 429) throw rateLimited();
      if (response.status === 408 || response.status === 504) throw timedOut();
      if (response.status !== 200 && response.status !== 202) throw unavailable();
      let body: unknown;
      try { body = JSON.parse(response.data.toString('utf8')); } catch { throw unavailable(); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw unavailable();
      return { status: response.status, body: body as Record<string, unknown> };
    }

    const endpoint = new URL('https://api.supadata.ai/v1/transcript');
    endpoint.search = new URLSearchParams({ url, text: 'true', mode: 'auto' }).toString();
    const initial = await request(endpoint, true);
    if (initial.status === 200) return transcriptResult(initial.body);
    const jobId = initial.body.jobId;
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw unavailable();
    const jobUrl = new URL(`https://api.supadata.ai/v1/transcript/${jobId}`);
    while (now() < expires) {
      await sleep(Math.min(2_000, expires - now()));
      const { body } = await request(jobUrl);
      if (body.status === 'completed') {
        // REST is flat; tolerate the SDK's documented result wrapper too.
        return transcriptResult(body.result && typeof body.result === 'object' && !Array.isArray(body.result)
          ? body.result as Record<string, unknown> : body);
      }
      if (body.status === 'failed') {
        const error = typeof body.error === 'object' && body.error ? body.error as Record<string, unknown> : null;
        if (body.error === 'limit-exceeded' || error?.error === 'limit-exceeded') throw rateLimited();
        throw unavailable();
      }
      if (body.status !== 'queued' && body.status !== 'active') throw unavailable();
    }
    throw timedOut();
  }

  return async (raw: string, options: TranscriptOptions = {}): Promise<VideoTranscript> => {
    const url = transcriptSourceUrl(raw);
    const key = sourceKeyFor(url)!;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) {
      cache.delete(key);
      cache.set(key, cached);
      return { ...cached.result };
    }
    if (cached) cache.delete(key);
    const existing = inFlight.get(key);
    if (existing) return { ...await existing };
    if (inFlight.size >= maxInFlight) throw rateLimited();
    const task = run(url, options.timeoutMs ?? MAX_WAIT_MS).then(result => {
      if (cacheLimit > 0) {
        cache.set(key, { result, expires: now() + (result.text ? CACHE_TTL_MS : EMPTY_TTL_MS) });
        while (cache.size > cacheLimit) cache.delete(cache.keys().next().value!);
      }
      return result;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return { ...await task };
  };
}

export const transcribeVideo = createSupadataTranscriber();
