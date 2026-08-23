// The identity of the thing a recipe was imported FROM, as opposed to the
// identity of the recipe itself.
//
// Fifty people importing the same viral gochujang pasta produce fifty recipe
// documents, and always will — each one is that person's own copy, editable and
// forkable without touching anybody else's. What they must NOT produce is fifty
// separate entries in Explore. `sourceKeyFor` is what collapses them: every
// import of one video answers to the same key, so the feed can group them and
// count how many people thought the dish was worth keeping.
//
// That count is the most honest popularity signal this app has. A like is a
// tap; an import is somebody deciding to cook the thing.

/**
 * TikTok's own id for a video, as it appears in a canonical watch URL.
 *
 * Prefer the id from the rehydration blob where a fetch already happened —
 * `vm.tiktok.com` short links carry no id at all, and only the redirect
 * resolves them. This exists for the paths that never fetch.
 */
function tiktokVideoIdFromUrl(url: URL): string | null {
  // /@handle/video/7311982..., and the older /v/7311982....html
  const match = /\/(?:video|v)\/(\d+)/.exec(url.pathname);
  return match?.[1] ?? null;
}

/** The key for a TikTok whose numeric video id is already known. */
export const tiktokSourceKey = (videoId: string): string => `tiktok:${videoId}`;

/**
 * A stable key for any public source URL, or null if there isn't one.
 *
 * Query strings are dropped rather than sorted. On a recipe page they are
 * essentially always tracking noise (`?utm_source=`, `?fbclid=`), and treating
 * two links to one recipe as two sources defeats the entire point of the key.
 * The rare site that puts the recipe's identity in a query param loses dedup
 * for that page; that is the better failure of the two.
 */
export function sourceKeyFor(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;

  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }

  // Anything that isn't a fetchable web page has no business being treated as
  // a public origin — `javascript:` and `data:` most of all.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  // Suffix match on a label boundary, matching isTikTokUrl — `nottiktok.com`
  // must not be filed under TikTok's namespace.
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const videoId = tiktokVideoIdFromUrl(url);
    if (videoId) return tiktokSourceKey(videoId);
    // A short link nobody resolved. Falling through to the generic key keeps it
    // deduped against itself, which is all that is available without a fetch.
  }

  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `web:${host}${path}`;
}

/**
 * The same key, safe to use as a Firestore document id.
 *
 * Document ids may not contain `/`, and a web key is mostly path. The mapping
 * has to be injective or two different pages would share a counter, which is
 * why `|` — a character no URL path carries unescaped — is used rather than
 * something that could already appear in the input.
 */
export const sourceDocId = (key: string): string => key.replace(/\//g, '|');

/**
 * Whether a recipe carrying this source may be shown to strangers.
 *
 * A public source is the ONLY thing that earns a place in Explore. Recipes
 * people write themselves stay in their own cookbook, and a photograph of a
 * handwritten card — which the photo importer produces — is the case this rule
 * exists to protect.
 */
export const hasPublicSource = (sourceUrl: string | null | undefined): boolean =>
  sourceKeyFor(sourceUrl) !== null;
