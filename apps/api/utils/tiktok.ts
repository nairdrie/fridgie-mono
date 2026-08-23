// Getting a cooking video's content out of TikTok, without a middleman.
//
// The previous implementation POSTed to a third-party endpoint
// (scriptadmin.tokbackup.com) that has since gone dark — it answers 502 — and
// passed it a randomised `ip` query param, which did nothing to the network and
// only spread requests across that service's own rate-limit buckets. Everything
// it returned is available from TikTok directly:
//
//   1. oEmbed — official, documented, unauthenticated. Gives the caption and a
//      cover image. On recipe TikTok the caption is very often the whole recipe,
//      so this alone resolves a lot of imports for nothing.
//   2. The watch page's __UNIVERSAL_DATA_FOR_REHYDRATION__ blob — the caption
//      again, plus subtitle tracks, the cover, and the video URL.
//   3. Frames from the video itself (see `sampleVideoFrames`).
//
// (1) is tried first because it is stable and documented; (2) fills in what
// oEmbed does not carry. Neither is load-bearing on its own — a failure in
// either degrades rather than throwing.

import axios from 'axios';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Downloading the video is the slow leg, but it is not the only one: oEmbed,
 * the watch page, the subtitle track, the download and then a Claude call with
 * eight images all run inside the client's 120s ceiling (AI_TIMEOUT_MS in
 * apps/mobile/utils/api.ts). This leaves room for the rest.
 */
const VIDEO_TIMEOUT_MS = 30_000;
/** A cooking TikTok is a few MB. This bounds a hostile or mis-parsed URL. */
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;

/**
 * Frames sampled per video, and the width they are scaled to.
 *
 * Eight 720x1280 frames is roughly 9.8K input tokens — about $0.03 of Sonnet.
 * That is the single most valuable input this importer has: recipe TikToks put
 * their quantities in on-screen text ("2 tbsp gochujang") while the audio says
 * "add a bit of this", so a transcript-only import loses exactly the numbers
 * the grocery list needs. 720px keeps overlay text legible at half the tokens
 * of the native 1080p.
 */
const MAX_FRAMES = 8;
const FRAME_WIDTH = 720;
/** Roughly one frame per this many seconds, within the MIN/MAX bounds. */
const SECONDS_PER_FRAME = 8;
const MIN_FRAMES = 3;

export interface TikTokSource {
  /** The video's caption. Often the entire recipe on its own. */
  caption: string;
  author: string | null;
  /**
   * TikTok's numeric id for the video, from the rehydration blob.
   *
   * This is the only reliable way to identify a `vm.tiktok.com` short link,
   * which carries no id until something follows the redirect — and it is what
   * every import of one video is grouped by. Null when the page read failed.
   */
  videoId: string | null;
  /** The creator's @handle, which is stable where their nickname is not. */
  authorHandle: string | null;
  /** Speech, from TikTok's own subtitle track. Empty when the video has none. */
  transcript: string;
  photoURL: string | null;
  /** Signed CDN URL — only fetchable with `cookieHeader` set. */
  videoUrl: string | null;
  cookieHeader: string | null;
  durationSec: number | null;
}

export const isTikTokUrl = (url: string): boolean => {
  try {
    // Suffix match on a label boundary. The old `hostname.includes('tiktok.com')`
    // also matched `nottiktok.com.evil.com`, handing an attacker-controlled host
    // to the branch that fetches and downloads whatever it is given.
    const host = new URL(url).hostname.toLowerCase();
    return host === 'tiktok.com' || host.endsWith('.tiktok.com');
  } catch {
    return false;
  }
};

/**
 * TikTok's official oEmbed endpoint. Documented, keyless, and the only part of
 * this file with any promise of stability, so it runs first and its failure is
 * survivable.
 */
async function fetchOEmbed(url: string): Promise<Partial<TikTokSource> | null> {
  try {
    const { data } = await axios.get<{
      title?: string; author_name?: string; thumbnail_url?: string;
    }>('https://www.tiktok.com/oembed', {
      params: { url },
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    });
    return {
      caption: (data?.title ?? '').trim(),
      author: data?.author_name?.trim() || null,
      photoURL: data?.thumbnail_url?.trim() || null,
    };
  } catch (error) {
    console.warn('TikTok oEmbed failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * The watch page carries a JSON blob with everything the page needs to render,
 * including the fields the dead third-party API used to resell.
 *
 * The response's cookies matter as much as its body: the video CDN rejects the
 * signed `playAddr` with a 403 unless the request carries the `ttwid` cookie
 * that this fetch sets. Both are returned together for that reason.
 */
export interface WatchPageData {
  item: Record<string, any>;
  cookieHeader: string | null;
}

/**
 * Pull the rehydration blob out of a watch page's HTML.
 *
 * Separate from the fetch so it can be tested against captured pages — the
 * blob's shape is the part that changes under us, and it is the part a live
 * request is least able to pin down.
 */
export function parseWatchPage(html: string): Record<string, any> | null {
  const match = /__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s.exec(html);
  if (!match?.[1]) return null;
  try {
    const scope = JSON.parse(match[1])?.['__DEFAULT_SCOPE__'];
    return scope?.['webapp.video-detail']?.itemInfo?.itemStruct ?? null;
  } catch {
    return null;
  }
}

/**
 * The watch page carries a JSON blob with everything the page needs to render,
 * including the fields the dead third-party API used to resell.
 *
 * The response's cookies matter as much as its body: the video CDN rejects the
 * signed `playAddr` with a 403 unless the request carries the `ttwid` cookie
 * that this fetch sets. Both are returned together for that reason.
 */
async function fetchWatchPage(url: string): Promise<WatchPageData | null> {
  try {
    const response = await axios.get<string>(url, {
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 5,
      responseType: 'text',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const item = parseWatchPage(response.data);
    if (!item) return null;

    const setCookie = response.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) && setCookie.length > 0
      ? setCookie.map((c) => c.split(';')[0]).join('; ')
      : null;

    return { item, cookieHeader };
  } catch (error) {
    // The blob is renamed and reshaped from time to time, and datacenter IPs get
    // challenged. Neither is fatal — oEmbed still gave us the caption.
    console.warn('TikTok page read failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Pick the most useful subtitle track.
 *
 * Field names come from TikTok's Go backend so they are capitalised, but the
 * lower-cased spellings turn up too. Prefer the original ASR track over a
 * machine translation: for a recipe the original wording carries the numbers.
 */
export function pickSubtitleTrack(item: Record<string, any>): string | null {
  const tracks: any[] = item?.video?.subtitleInfos ?? [];
  if (!Array.isArray(tracks) || tracks.length === 0) return null;

  const get = (track: any, key: string) => track?.[key] ?? track?.[key.charAt(0).toLowerCase() + key.slice(1)];
  const isWebVtt = (t: any) => String(get(t, 'Format') ?? 'webvtt').toLowerCase().includes('vtt');
  const isEnglish = (t: any) => String(get(t, 'LanguageCodeName') ?? '').toLowerCase().startsWith('eng');
  const isOriginal = (t: any) => String(get(t, 'Source') ?? '').toUpperCase() !== 'MT';

  const usable = tracks.filter((t) => isWebVtt(t) && get(t, 'Url'));
  const chosen =
    usable.find((t) => isEnglish(t) && isOriginal(t))
    ?? usable.find((t) => isEnglish(t))
    ?? usable.find(isOriginal)
    ?? usable[0];

  return chosen ? String(get(chosen, 'Url')) : null;
}

/** WebVTT to plain speech: drop the header, cue numbers, timings and tags. */
export function webVttToText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === 'WEBVTT') continue;
    if (line.startsWith('NOTE') || line.startsWith('STYLE')) continue;
    if (line.includes('-->') || /^\d+$/.test(line)) continue;

    const text = line.replace(/<[^>]+>/g, '').trim();
    // TikTok's ASR repeats a rolling window of words across consecutive cues,
    // so the same sentence arrives several times. Keep the first of each run.
    if (text && text !== lines[lines.length - 1]) lines.push(text);
  }
  return lines.join(' ');
}

async function fetchTranscript(subtitleUrl: string, cookieHeader: string | null): Promise<string> {
  try {
    const { data } = await axios.get<string>(subtitleUrl, {
      timeout: REQUEST_TIMEOUT_MS,
      responseType: 'text',
      headers: {
        'User-Agent': BROWSER_UA,
        Referer: 'https://www.tiktok.com/',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });
    return webVttToText(typeof data === 'string' ? data : String(data));
  } catch (error) {
    console.warn('TikTok subtitle fetch failed:', error instanceof Error ? error.message : error);
    return '';
  }
}

/**
 * Everything we can learn about a TikTok without downloading it.
 *
 * Returns whatever it managed to gather; the caller decides whether that is
 * enough. Only a total failure — no caption and no transcript — is worth
 * refusing on, and that is the caller's call to make.
 */
export async function collectTikTokSource(url: string): Promise<TikTokSource> {
  const [oembed, page] = await Promise.all([fetchOEmbed(url), fetchWatchPage(url)]);

  const item = page?.item;
  const cookieHeader = page?.cookieHeader ?? null;

  const subtitleUrl = item ? pickSubtitleTrack(item) : null;
  const transcript = subtitleUrl ? await fetchTranscript(subtitleUrl, cookieHeader) : '';

  const duration = Number(item?.video?.duration);

  return {
    // The page's `desc` and oEmbed's `title` are the same field; either will do,
    // and having both means one source being down is not the end of the import.
    caption: (item?.desc || oembed?.caption || '').trim(),
    author: item?.author?.nickname || item?.author?.uniqueId || oembed?.author || null,
    videoId: item?.id ? String(item.id) : null,
    authorHandle: item?.author?.uniqueId ? String(item.author.uniqueId) : null,
    transcript,
    photoURL: item?.video?.cover || item?.video?.originCover || oembed?.photoURL || null,
    videoUrl: item?.video?.playAddr || item?.video?.downloadAddr || null,
    cookieHeader,
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

/** How many frames a video of this length is worth, within the configured bounds. */
function frameCountFor(durationSec: number): number {
  const wanted = Math.ceil(durationSec / SECONDS_PER_FRAME);
  return Math.max(MIN_FRAMES, Math.min(MAX_FRAMES, wanted));
}

async function ffprobeDuration(path: string): Promise<number | null> {
  try {
    const probe = Bun.spawn(
      ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    const seconds = Number((await new Response(probe.stdout).text()).trim());
    await probe.exited;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

/**
 * Evenly spaced JPEG stills from a local video file, base64-encoded for a Claude
 * image block.
 *
 * Split from the download so the ffmpeg leg can be tested against a fixture —
 * and so a machine without ffmpeg degrades to the text path rather than
 * erroring, which is what local dev should do.
 */
export async function framesFromFile(videoPath: string, fallbackDuration?: number | null): Promise<string[]> {
  const duration = (await ffprobeDuration(videoPath)) ?? fallbackDuration;
  if (!duration) return [];

  const workDir = await mkdtemp(join(tmpdir(), 'fridgie-frames-'));
  try {
    const count = frameCountFor(duration);
    const frames: string[] = [];

    for (let i = 0; i < count; i += 1) {
      // Mid-slot rather than slot edges: t=0 is usually a title card or a black
      // frame, and seeking to exactly the duration frequently yields nothing.
      const at = (duration * (i + 0.5)) / count;
      const framePath = join(workDir, `frame-${i}.jpg`);

      const ffmpeg = Bun.spawn(
        [
          'ffmpeg', '-nostdin', '-v', 'error',
          '-ss', at.toFixed(2), '-i', videoPath,
          '-frames:v', '1', '-vf', `scale=${FRAME_WIDTH}:-2`,
          '-q:v', '3', '-f', 'image2', '-y', framePath,
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if ((await ffmpeg.exited) !== 0) continue;

      frames.push(Buffer.from(await readFile(framePath)).toString('base64'));
    }

    return frames;
  } catch (error) {
    console.warn('Frame extraction failed:', error instanceof Error ? error.message : error);
    return [];
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Sample frames from a TikTok's video stream.
 *
 * Empty on any failure — frames are an enhancement, and losing them must never
 * cost us an import that the caption alone could have satisfied. Requires
 * ffmpeg on PATH (the API image installs it; see apps/api/Dockerfile).
 */
export async function sampleVideoFrames(source: TikTokSource): Promise<string[]> {
  if (!source.videoUrl) return [];

  let workDir: string | null = null;
  try {
    const { data } = await axios.get<ArrayBuffer>(source.videoUrl, {
      timeout: VIDEO_TIMEOUT_MS,
      responseType: 'arraybuffer',
      maxContentLength: MAX_VIDEO_BYTES,
      maxRedirects: 5,
      headers: {
        'User-Agent': BROWSER_UA,
        // Both are required: the CDN 403s a signed playAddr without the `ttwid`
        // cookie the watch-page fetch set, and Referer alone is not enough.
        Referer: 'https://www.tiktok.com/',
        ...(source.cookieHeader ? { Cookie: source.cookieHeader } : {}),
      },
    });

    workDir = await mkdtemp(join(tmpdir(), 'fridgie-tiktok-'));
    const videoPath = join(workDir, 'video.mp4');
    await writeFile(videoPath, Buffer.from(data));

    return await framesFromFile(videoPath, source.durationSec);
  } catch (error) {
    console.warn('TikTok frame sampling failed:', error instanceof Error ? error.message : error);
    return [];
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
