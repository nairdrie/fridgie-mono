# Public social recipe import

`POST /api/recipe/import` accepts `{ "url": "https://www.instagram.com/reel/SHORTCODE/" }` under the existing authenticated, non-anonymous account checks. It returns an editable recipe draft. It does not save a recipe or add ingredients to a list.

## Instagram

Supported public link forms: `/reel/{shortcode}/`, `/reels/{shortcode}/`, `/p/{shortcode}/`, `/tv/{shortcode}/`, `/creator/reel/{shortcode}/`, and `/share/{token}/` or `/share/reel/{token}/` redirects. `instagram.com`, `www.instagram.com`, `m.instagram.com`, and `instagr.am` links normalize to the canonical Instagram host; query tracking is removed. Profiles and Stories are not supported. The canonical post shortcode yields `instagram:{shortcode}` for server-side source deduplication, including reel/post path aliases. An unresolved share token is never treated as a post ID.

The collector reads publicly returned HTML: OpenGraph metadata, matching-post JSON-LD, or matching-post data already embedded in page scripts. Scripts are parsed as JSON, never executed. It does not log in, use user cookies, or call private GraphQL/mobile endpoints. Public Instagram CDN video URLs, when supplied by that page, use the existing bounded MP4 frame sampler. When native subtitles are absent, the importer can obtain public-video speech through Supadata as described below.

A page may be public in the Instagram app yet return a login wall, rate limit, incomplete caption, or no media to this server. Supadata may still read a public post when this server's IP cannot fetch its page. The importer attempts that fallback even if the local collector fails; it does not claim access to private or login-required videos. It does not create a recipe from only the dish name or invent missing quantities, steps, temperatures, or times. A partial recipe is reviewable with missing fields left empty. Photo/screenshot import is the fallback when the original cannot be read.

Meta's [official Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api) describes authenticated APIs for professional accounts, with consumer-account limitations. Those APIs are not configured as an arbitrary shared-link resolver here. No oEmbed API or its metadata is used for Instagram recipe extraction. Platform access and page markup can change independently of this code.

## Public audio fallback

`SUPADATA_API_KEY` is optional server configuration, never an Expo/client value. `utils/supadata.ts` calls the [documented transcript endpoint](https://docs.supadata.ai/get-transcript): `GET https://api.supadata.ai/v1/transcript` with URL-encoded `url`, `text=true`, `mode=auto`, and the `x-api-key` header. Auto mode fetches native transcripts or generates speech recognition. Neither an English translation nor a particular spoken language is forced. Only validated TikTok video/share and Instagram post/share URLs reach this adapter; it never sends arbitrary media URLs supplied by a client.

Native transcript text avoids the provider call. A conservative full-caption check also skips paid audio for a written recipe with ingredient/method headings, at least two measured ingredients, and preparation actions. Short descriptions, tags, and promotional captions still request audio. After page collection, frame sampling and audio retrieval run concurrently. A provider failure does not discard a useful caption, native transcript, or sampled frames. If the model finds no recipe in that remaining evidence, the provider's retryable error is preserved. A successful empty transcript means no speech; without other evidence it returns `RECIPE_NOT_FOUND` and never calls the model. Music lyrics and unrelated speech are explicitly excluded by the extraction prompt.

The adapter handles an immediate HTTP 200 transcript or HTTP 202 job ID. It polls `/v1/transcript/{jobId}` every two seconds through `queued` and `active`, finishing on `completed` or sanitized `failed`. The initial HTTP call may use the whole remaining transcription budget because synchronous generation can take approximately 100 seconds; polling requests are each capped at 15 seconds. Both paths share one maximum 120-second deadline. HTTP 206, malformed content, inaccessible videos, credentials/plan errors, and unknown job states fail explicitly. HTTP 429 has its own retryable code. Provider payloads and credentials are never logged or returned to the caller. Redirects are disabled and requests use only the exact `api.supadata.ai` host.

An instance-local cache holds at most 128 transcripts for six hours (five minutes for successful no-speech results), with 20,000 characters per entry. Up to 32 distinct requests may be in flight; repeated requests for one canonical source share the same work. The cache uses the existing video source identity, including Instagram reel/post aliases and TikTok video IDs. Resolved share links use the collector's canonical URL; unresolved shares can only deduplicate against that share token. No provider error is cached. Separate Cloud Run instances do not share this cache. A user retry after a failed/timed-out request may create another billable provider request; the adapter itself never automatically resubmits one.

The synchronous import endpoint budgets 225 seconds overall. Claude receives at most 90 seconds or the remaining budget, with automatic SDK retries disabled for this route only. Cloud Run's Bun server and mobile URL import client allow 240 seconds. Other Claude callers keep their existing defaults. A provider-only import retains the normalized public URL; creator names and cover images are attached only when actually collected.

## Fetch boundaries

All recipe-page, TikTok metadata/subtitle, and social-video downloads use `publicFetch.ts`: HTTP(S) only, default ports, no URL credentials, private/reserved-address rejection including IPv4-mapped IPv6, all-answer DNS validation, a pinned validated socket address, a total request deadline, manually revalidated redirects, and bounded response bodies. Cookies are stripped on cross-origin redirects. Instagram pages and media additionally require exact approved page hosts or Instagram/Facebook CDN suffixes. TikTok retains its official oEmbed/watch-page/subtitle fallback behavior, with TikTok CDN host restrictions.

HTML is capped at 5 MiB; oEmbed at 256 KiB; subtitles at 512 KiB; video at 40 MiB. The model receives at most 20,000 characters per social text source and eight bounded-size frames. Media must begin with an MP4 file-type box; ffmpeg/ffprobe run with the MOV demuxer, only local-file/pipe protocols, bounded execution time, and constrained frame dimensions. Missing ffmpeg or inaccessible video degrades to caption/transcript extraction.

## Error response contract

Errors return `{ "error": "CODE", "message": "human-readable detail" }` (the existing `RECIPE_NOT_FOUND` response may omit `message`).

| Code | HTTP | Recovery |
| --- | --- | --- |
| `INVALID_URL` | 400 | Supply one complete recipe URL. |
| `UNSAFE_URL` | 400 | Use an ordinary public website link. |
| `UNSUPPORTED_VIDEO_URL` | 400 | Copy a specific TikTok video or Instagram Reel/post link, not a profile or Story. |
| `INSTAGRAM_LOGIN_REQUIRED` | 422 | Import a screenshot of the visible caption/recipe. |
| `INSTAGRAM_RATE_LIMITED` | 429 | Retry later or use a screenshot. |
| `VIDEO_UNAVAILABLE` | 422 | Check that the post exists and is public, retry, or use a screenshot. |
| `SOURCE_TOO_LARGE` | 422 | Use a smaller source or screenshot. |
| `FETCH_FAILED` | 502 | Retry a temporarily unreachable site. |
| `TRANSCRIPT_UNAVAILABLE` | 502 / 503 | Retry public audio transcription or import a screenshot; 503 includes missing server configuration. |
| `TRANSCRIPT_TIMEOUT` | 504 | Retry a slower video transcription or use a screenshot. |
| `TRANSCRIPT_RATE_LIMITED` | 429 | Retry later or use a screenshot. |
| `IMPORT_TIMEOUT` | 504 | Retry the import/model extraction. |
| `NO_CONTENT` | 422 | Use a page with readable recipe content. |
| `RECIPE_NOT_FOUND` | 422 | Use a source that actually states a recipe. |

## Validation and limits

Tests use a clearly labelled synthetic Instagram HTML fixture, key-free Supadata response fixtures, injected public-fetch/model responses, and the existing captured TikTok fixture. They exercise caption/metadata parsing, direct/share/tracking links, creator attribution, canonical identity, private/login/rate-limit failures, immediate and queued transcripts, total polling deadlines, malformed/failed jobs, empty speech, bounded cache/in-flight deduplication, metadata-fetch rescue, native/full-caption cost avoidance, prompt evidence requirements including lyrics, unsafe URLs and DNS answers, and TikTok/generic recipe regressions. All external calls are stubbed in these HTTP contract tests, including transcription: they verify orchestration and error handling, not a live provider or AI result.

A live unauthenticated collector check on 2026-09-20 succeeded for [the public Reel linked by Zezza Cooks](https://zezzacooks.com/tomato-burrata-pasta/): `https://www.instagram.com/reel/CV9O_GRrO6t/`. It returned a 460-character caption, `@zezza_cooks`, canonical post identity, and public cover/video URLs. No model request or save was performed. This establishes one working public-page fetch/parser path, not universal Instagram access or a deployed end-to-end test.
