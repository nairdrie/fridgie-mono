/** Shared by pasted text, incoming OS shares, and recipe provenance labels. */
export type RecipeImportPlatform = 'tiktok' | 'instagram' | 'web';
export type RecipeImportInput = { url: string; platform: RecipeImportPlatform } | { error: string };

const isHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function trimSharePunctuation(value: string): string {
  let result = value.replace(/[.,!;:'’]+$/, '');
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    while (result.endsWith(close) && result.split(close).length > result.split(open).length) result = result.slice(0, -1);
  }
  return result;
}

export function parseRecipeImportInput(input: string): RecipeImportInput {
  const text = input.trim();
  if (!text) return { error: 'Paste a recipe link to get started.' };
  let candidates: string[] = text.match(/https?:\/\/[^\s<>"“”]+/gi) ?? [];
  if (candidates.length === 0) {
    // Native share text sometimes omits the scheme; do not mistake an email
    // address or an arbitrary word in a caption for the requested recipe.
    const social = /(?:^|[\s([{])((?:(?:www|m|vm|vt)\.)?(?:tiktok\.com|instagram\.com|instagr\.am)\/[^\s<>"“”]+)/gi;
    candidates = Array.from(text.matchAll(social), match => `https://${match[1]}`);
    if (candidates.length === 0 && !/\s|@|:\/\//.test(text)) candidates = [`https://${text}`];
  }
  const parsed: { url: string; platform: RecipeImportPlatform }[] = [];
  for (const candidate of candidates) {
    try {
      const url = new URL(trimSharePunctuation(candidate));
      const host = url.hostname.toLowerCase();
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !host.includes('.') || host.includes(':') || /^(?:\d+\.){3}\d+$/.test(host) || isHost(host, 'localhost') || host.endsWith('.local')) continue;
      const platform: RecipeImportPlatform = isHost(host, 'tiktok.com') ? 'tiktok' : isHost(host, 'instagram.com') || isHost(host, 'instagr.am') ? 'instagram' : 'web';
      if (!parsed.some(item => item.url === url.toString())) parsed.push({ url: url.toString(), platform });
    } catch { /* Try the next candidate from the pasted text. */ }
  }
  if (parsed.length === 0) return { error: 'Use a public https:// recipe, TikTok, or Instagram link.' };
  if (parsed.length > 1) return { error: 'There’s more than one link here. Paste just the recipe you want to keep.' };
  const result = parsed[0];
  if (result.platform === 'instagram' && !/^\/(?:(?:[^/]+\/)?(?:reel|reels|p|tv)|share)\/[^/]+/i.test(new URL(result.url).pathname)) {
    return { error: 'Use the link to an Instagram post or reel, rather than a profile or feed.' };
  }
  return result;
}

/** Returns one unambiguous public link; the server still enforces URL safety. */
export function extractRecipeImportUrl(input: string): string | null {
  const result = parseRecipeImportInput(input);
  return 'url' in result ? result.url : null;
}

export function recipeSourceLabel(sourceUrl?: string): string {
  if (!sourceUrl) return 'the web';
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, '');
    if (isHost(host, 'tiktok.com')) return 'TikTok';
    if (isHost(host, 'instagram.com') || isHost(host, 'instagr.am')) return 'Instagram';
    return host || 'the web';
  } catch { return 'the web'; }
}

export type RecipeImportProblem = { title: string; message: string; retryable: boolean };
export function recipeImportProblem(error: unknown): RecipeImportProblem {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const status = (error as { status?: number } | null)?.status;
  if (/TRANSCRIPT_RATE_LIMITED/.test(message)) return { title: 'Video transcription is busy', message: 'We couldn’t read this video’s speech right now. Try again in a few minutes, or scan screenshots of the ingredients and steps.', retryable: true };
  if (/TRANSCRIPT_TIMEOUT/.test(message) || status === 504 || /server did not respond within \d+s/i.test(message)) return { title: 'This import needs more time', message: 'Reading the recipe took longer than expected. Your link is still here. Try again, or scan screenshots of the ingredients and steps.', retryable: true };
  if (/TRANSCRIPT_UNAVAILABLE/.test(message)) return { title: 'Couldn’t read the video’s speech', message: 'Transcription is temporarily unavailable. Try again shortly, or scan screenshots of the ingredients and steps.', retryable: true };
  if (/INSTAGRAM_LOGIN_REQUIRED/.test(message)) return { title: 'Instagram needs a public post', message: 'This post may require a login or be private. Try a public link, or scan screenshots of the ingredients and steps.', retryable: false };
  if (/INSTAGRAM_RATE_LIMITED/.test(message)) return { title: 'Give Instagram a moment', message: 'Instagram is limiting requests right now. Try again shortly, or scan a screenshot instead.', retryable: true };
  if (status === 429) return { title: 'Recipe import is busy', message: 'Try again in a few minutes, or scan screenshots of the ingredients and steps.', retryable: true };
  if (/UNSUPPORTED_VIDEO_URL/.test(message)) return { title: 'Use a post or video link', message: 'Copy the link to the individual TikTok video or Instagram post, rather than a profile or feed.', retryable: false };
  if (/VIDEO_UNAVAILABLE/.test(message)) return { title: 'This video is unavailable', message: 'It may be private, deleted, or restricted. Try another public link, or scan screenshots of the recipe.', retryable: false };
  if (/RECIPE_NOT_FOUND|NO_CONTENT/.test(message)) return { title: 'No recipe found', message: 'We couldn’t find enough ingredients and steps in this post. Try the recipe’s own page, or scan a screenshot.', retryable: false };
  if (/SOURCE_TOO_LARGE/.test(message)) return { title: 'This source is too large', message: 'Try a direct recipe page or scan screenshots of the ingredients and steps.', retryable: false };
  if (/INVALID_URL|UNSAFE_URL/.test(message)) return { title: 'Check this link', message: 'Paste a public recipe page, TikTok video, or Instagram post link.', retryable: false };
  return { title: 'Couldn’t bring in this recipe', message: 'The source didn’t respond. Check your connection and try again, or scan a screenshot instead.', retryable: true };
}

/** Small async fence: replaced/closed drafts never receive late import results. */
export function createRecipeImportGuard() {
  let revision = 0;
  const consumedShares = new Set<string>();
  return {
    begin: () => ++revision,
    invalidate: () => { revision += 1; },
    isCurrent: (request: number) => request === revision,
    consumeShare: (id: string) => {
      if (consumedShares.has(id)) return false;
      consumedShares.add(id);
      return true;
    },
  };
}
