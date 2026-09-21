import * as cheerio from 'cheerio';
import { fetchPublicUrl, publicUrl, PublicFetchError, type PublicFetchResult } from './publicFetch';

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_CAPTION_CHARS = 20_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; FridgieRecipeImporter/1.0)';
const SHORTCODE = /^[A-Za-z0-9_-]{5,64}$/;

export const isInstagramHost = (host: string): boolean =>
  ['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am', 'www.instagr.am'].includes(host.toLowerCase());
export const isInstagramMediaHost = (host: string): boolean =>
  ['cdninstagram.com', 'fbcdn.net'].some(domain => host === domain || host.endsWith(`.${domain}`));

export function isInstagramUrl(raw: string): boolean {
  try { return isInstagramHost(new URL(raw).hostname); } catch { return false; }
}

export interface InstagramLink { url: string; shortcode: string | null; kind: 'reel' | 'p' | 'tv' | 'share' }
/** Tracking queries never identify a post; share tokens do, until resolved. */
export function instagramLink(raw: string): InstagramLink | null {
  let url: URL;
  try { url = publicUrl(raw, isInstagramHost); } catch { return null; }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'share') {
    const token = parts.length === 2 ? parts[1] : parts.length === 3 && ['reel', 'reels', 'p'].includes(parts[1]!) ? parts[2] : null;
    return token && SHORTCODE.test(token) ? { url: `https://www.instagram.com/${parts.join('/')}/`, shortcode: null, kind: 'share' } : null;
  }
  // Instagram also shares /creator/reel/SHORTCODE/ links.
  const offset = parts.length === 3 && /^[A-Za-z0-9_.]{1,30}$/.test(parts[0]!) ? 1 : 0;
  const kind = parts[offset];
  const code = parts[offset + 1];
  if (parts.length !== offset + 2 || !kind || !['reel', 'reels', 'p', 'tv'].includes(kind) || !code || !SHORTCODE.test(code)) return null;
  return { url: `https://www.instagram.com/${kind === 'reels' ? 'reel' : kind}/${code}/`, shortcode: code, kind: kind === 'reels' ? 'reel' : kind as 'reel' | 'p' | 'tv' };
}

export class InstagramImportError extends Error {
  constructor(readonly code: 'UNSUPPORTED_VIDEO_URL' | 'INSTAGRAM_LOGIN_REQUIRED' | 'INSTAGRAM_RATE_LIMITED' | 'VIDEO_UNAVAILABLE', readonly status: 400 | 422 | 429, message: string) {
    super(message);
  }
}

export interface InstagramSource {
  caption: string;
  author: string | null;
  authorHandle: string | null;
  shortcode: string;
  canonicalUrl: string;
  photoURL: string | null;
  videoUrl: string | null;
  durationSec: number | null;
  cookieHeader: null;
  transcript: string;
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim().slice(0, MAX_CAPTION_CHARS) : ''; }
function mediaUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { return publicUrl(value, isInstagramMediaHost).href; } catch { return null; }
}
function username(value: unknown): string | null {
  const name = text(value).replace(/^@/, '');
  return /^[A-Za-z0-9_.]{1,30}$/.test(name) ? name : null;
}

/** The social/engagement wrapper is metadata, not recipe evidence. */
export function instagramCaption(description: string): { caption: string; authorHandle: string | null } {
  const clean = description.trim();
  // Public meta descriptions use "123 likes, 4 comments - chef on May 1,
  // 2026: \"caption\""; og:title uses "chef on Instagram: \"caption\"".
  const match = /^(?:[\s\S]*?\blikes?,[\s\S]*?\bcomments?\s*-\s*)?@?([A-Za-z0-9_.]{1,30})\s+on\s+(?:Instagram|[A-Za-z]+\s+\d{1,2},?\s+\d{4})\s*:\s*["“]([\s\S]*)["”]\s*\.?$/.exec(clean);
  if (match) return { caption: text(match[2]), authorHandle: match[1]! };
  if (/^(?:Instagram|Log in|Login|Sign up|Create an account|Join Instagram|Watch this reel)/i.test(clean)) return { caption: '', authorHandle: null };
  return { caption: clean.slice(0, MAX_CAPTION_CHARS), authorHandle: null };
}

function walkJson(value: unknown, visit: (value: Record<string, any>) => void): void {
  const queue: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let seen = 0;
  while (queue.length && seen++ < 20_000) {
    const entry = queue.pop()!;
    if (!entry.value || typeof entry.value !== 'object' || entry.depth > 30) continue;
    if (!Array.isArray(entry.value)) visit(entry.value as Record<string, any>);
    for (const child of Object.values(entry.value)) if (child && typeof child === 'object') queue.push({ value: child, depth: entry.depth + 1 });
  }
}

/** Parse only published page data. Never execute scripts or request hidden APIs. */
export function parseInstagramPage(html: string, requestedUrl: string): InstagramSource | null {
  const $ = cheerio.load(html);
  const requested = instagramLink(requestedUrl);
  const meta = (key: string) => text($(`meta[property="${key}"], meta[name="${key}"]`).first().attr('content'));
  const canonical = instagramLink($('link[rel="canonical"]').attr('href') ?? '') ?? instagramLink(meta('og:url'));
  // A suggested post's metadata is not the requested Reel. Share links may
  // acquire their identity from a canonical post, but known IDs cannot change.
  if (requested?.shortcode && canonical?.shortcode && requested.shortcode !== canonical.shortcode) return null;
  const link = canonical?.shortcode ? canonical : requested;
  if (!link?.shortcode) return null;
  const metaCaption = instagramCaption(meta('og:description') || meta('description'));
  const title = instagramCaption(meta('og:title'));
  let caption = metaCaption.caption || title.caption;
  if (caption === meta('og:title') && !title.authorHandle) caption = '';
  let authorHandle = metaCaption.authorHandle ?? title.authorHandle;
  let author: string | null = authorHandle ? `@${authorHandle}` : null;
  let photoURL = mediaUrl(meta('og:image'));
  let videoUrl = mediaUrl(meta('og:video:secure_url')) ?? mediaUrl(meta('og:video')) ?? mediaUrl(meta('og:video:url'));
  let durationSec: number | null = null;
  let explicitlyPrivate = false;

  $('script[type="application/json"], script[type="application/ld+json"], script:not([src]):not([type])').each((_, element) => {
    let json = $(element).html()?.trim() ?? '';
    const assignment = /^window\._sharedData\s*=\s*([\s\S]+?);?\s*$/.exec(json);
    if (assignment) json = assignment[1]!.replace(/;$/, '');
    if (!json.startsWith('{') && !json.startsWith('[')) return;
    try {
      walkJson(JSON.parse(json), node => {
        const code = text(node.shortcode ?? node.code);
        const nodeLink = instagramLink(text(node.url ?? node.mainEntityOfPage?.['@id'] ?? node.mainEntityOfPage ?? node['@id']));
        const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
        const structuredPost = types.some((type: unknown) => ['VideoObject', 'SocialMediaPosting', 'ImageObject'].includes(String(type)));
        if (code ? code !== link.shortcode : !structuredPost || nodeLink?.shortcode !== link.shortcode) return;
        if (node.is_private === true || node.owner?.is_private === true || node.user?.is_private === true) { explicitlyPrivate = true; return; }
        const ownCaption = text(node.edge_media_to_caption?.edges?.[0]?.node?.text ?? node.caption?.text ?? node.caption ?? node.description);
        if (ownCaption) caption = ownCaption;
        const handle = username(node.owner?.username ?? node.user?.username ?? node.author?.alternateName);
        if (handle) { authorHandle = handle; author = `@${handle}`; }
        else if (!author && text(node.author?.name)) author = text(node.author.name);
        photoURL = mediaUrl(node.display_url ?? node.thumbnail_src ?? node.thumbnailUrl ?? node.image_versions2?.candidates?.[0]?.url) ?? photoURL;
        videoUrl = mediaUrl(node.video_url ?? node.video_versions?.[0]?.url ?? node.contentUrl) ?? videoUrl;
        const duration = Number(node.video_duration ?? node.duration);
        if (Number.isFinite(duration) && duration > 0 && duration <= 3600) durationSec = duration;
      });
    } catch { /* A malformed or unrelated script does not erase useful metadata. */ }
  });
  if (explicitlyPrivate || (!caption && !videoUrl)) return null;
  return { caption, author, authorHandle, shortcode: link.shortcode, canonicalUrl: link.url, photoURL, videoUrl, durationSec, cookieHeader: null, transcript: '' };
}

export async function collectInstagramSource(raw: string, fetchPage: typeof fetchPublicUrl = fetchPublicUrl): Promise<InstagramSource> {
  const link = instagramLink(raw);
  if (!link) throw new InstagramImportError('UNSUPPORTED_VIDEO_URL', 400, 'Use the link to an Instagram Reel or post, rather than a profile or Story.');
  let response: PublicFetchResult;
  try {
    response = await fetchPage(link.url, { timeoutMs: 15_000, maxBytes: MAX_HTML_BYTES, allowedHosts: isInstagramHost, headers: { 'User-Agent': USER_AGENT, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } });
  } catch (error) {
    if (error instanceof PublicFetchError) throw error;
    throw new InstagramImportError('VIDEO_UNAVAILABLE', 422, 'Instagram could not be reached. Try again, or import a screenshot of the recipe.');
  }
  if (response.status === 429) throw new InstagramImportError('INSTAGRAM_RATE_LIMITED', 429, 'Instagram is limiting requests. Try again later, or import a screenshot of the recipe.');
  const html = response.data.toString('utf8');
  const finalUrl = new URL(response.url);
  if ([401, 403].includes(response.status) || /^\/(?:accounts\/login|challenge|checkpoint|accounts\/onetap)/.test(finalUrl.pathname)) {
    throw new InstagramImportError('INSTAGRAM_LOGIN_REQUIRED', 422, 'Instagram requires a login to show this post. Fridgie can only read publicly accessible posts. Import a screenshot of its caption instead.');
  }
  if (response.status < 200 || response.status >= 300) throw new InstagramImportError('VIDEO_UNAVAILABLE', 422, 'That Instagram post could not be opened. It may be private, removed, or unavailable in this region.');
  const resolved = instagramLink(response.url);
  if (link.shortcode && resolved?.shortcode && link.shortcode !== resolved.shortcode) {
    throw new InstagramImportError('VIDEO_UNAVAILABLE', 422, 'Instagram redirected to a different post. Copy the original Reel link and try again.');
  }
  // Preserve the requested ID even if Instagram redirects to unrelated content.
  const source = parseInstagramPage(html, link.shortcode ? link.url : resolved?.shortcode ? resolved.url : link.url);
  if (source) return source;
  if (/accounts\/login|loginForm|"require_login"\s*:\s*true|"is_private"\s*:\s*true/.test(html)) {
    throw new InstagramImportError('INSTAGRAM_LOGIN_REQUIRED', 422, 'Instagram did not make this post readable without logging in. Import a screenshot of its caption instead.');
  }
  throw new InstagramImportError('VIDEO_UNAVAILABLE', 422, 'Instagram did not provide a readable caption or video. Try the original Reel link or import a screenshot of the recipe.');
}
