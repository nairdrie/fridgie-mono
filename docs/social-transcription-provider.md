# Social video transcription provider

Research and public-demo validation: 2026-09-20. Recommendation: **Supadata** for the social-link-to-transcript step. It handles both TikTok and Instagram and can transcribe audio without published captions. [TikTok support](https://supadata.ai/tiktok-transcript-api), [Instagram support](https://supadata.ai/instagram-transcript-api).

## Observed live results

The public playground was tested with `mode=generate`, `text=true`, and no supplied API key:

- `https://vm.tiktok.com/ZNdfSseUr`: nonempty English spoken transcript discussing pasta.
- `https://www.instagram.com/reel/CV9O_GRrO6t/`: completed English transcript of the music playing in the clip. This was successful speech recognition, but the lyrics contained no usable recipe instructions.

Follow-up authenticated calls from the Google Cloud project using the supplied key also succeeded: TikTok returned 2,579 characters in 16 seconds; Instagram returned 119 characters in 18 seconds. These establish working examples, not universal platform coverage or recipe accuracy. The key is stored in Google Secret Manager as `fridgie-supadata-api-key`; it is never bundled in the app or source archive.

## Deployment and end-to-end evidence

On 2026-09-20, Cloud Run revision `fridgie-api-social-b9941c6` reached 100% traffic with healthy Firestore/RTDB readiness checks. The gen2 `transcribe_tiktok` function is active with secret version 1 and rejects unauthenticated calls (401). The subsequent Discover release retains this integration and secret binding.

A real captionless extraction of [Moribyan’s pumpkin honey buns Reel](https://www.instagram.com/reel/DdXFNmNhU-0/) produced “Pumpkin Cinnamon Roll Honey Buns,” 16 ingredients and 15 steps in 26 seconds. This ran the production container’s import handler with metadata and frames deliberately unavailable, actual Supadata plus Anthropic credentials supplied from Secret Manager, and no recipe writes. It tests transcript-only extraction, separately from HTTP authentication/readiness checks.

Negative examples correctly returned `RECIPE_NOT_FOUND`: a pasta-discussion TikTok and music-only Reel. A creator-linked crispy-potato TikTok also yielded unrelated lyrics from Supadata in both auto and generate modes; the importer rejected it. This provider limitation means not every public video will yield its expected voiceover, and the editable review/screenshot fallback remains necessary.

## API contract

`GET https://api.supadata.ai/v1/transcript` uses a server-side `x-api-key` and an encoded `url`. Request `text=true`. `auto` tries existing captions before audio generation; `generate` forces audio transcription. Handle both immediate `200` results and `202 {jobId}`. Poll `/v1/transcript/{jobId}` for completion; REST transcript text is in top-level `content`. Generation may take roughly 100 seconds, so it cannot simply be added sequentially to the current 120-second mobile request. [Transcript API](https://docs.supadata.ai/get-transcript).

Current pricing is 100 free credits/month, or $17/month for 3,000 credits. Generated transcription uses two credits per video minute. A two-minute clip therefore uses four credits. [Pricing](https://supadata.ai/pricing).

## Implemented Fridgie integration

The importer retains existing descriptions and subtitles. When subtitles are absent and the caption does not clearly contain a full recipe, it supplements the evidence with a Supadata transcript. Transcription and frame sampling run concurrently. The provider can recover a public video even when local metadata collection fails. Source attribution and the editable review remain intact. Music lyrics and empty speech are not recipe instructions.

`apps/api/utils/supadata.ts` handles immediate and asynchronous provider responses within 120 seconds. The existing request/recipe response contract is retained; provider polling happens inside that request, rather than relying on unawaited background work on Cloud Run. Imports have a 225-second processing budget, Bun allows 240 seconds for this route, and the mobile URL importer allows 240 seconds. Model calls use the remaining budget with no automatic retry. The mobile screen describes the longer wait and keeps cancellation/draft isolation.

Per-instance caching retains up to 128 transcripts for six hours (empty speech for five minutes) and deduplicates in-flight requests. It is intentionally not a global persistent cache. Provider failures preserve valid caption/frame evidence; when extraction still finds no recipe, the original retryable transcription failure is returned.

The protected compatibility function is maintained separately in `functions/social_transcript`. It retains the `transcribe_tiktok` entrypoint and plain-text response, supports both platforms, and now requires a registered Firebase bearer token. Its old download/Whisper implementation and OpenAI binding are replaced by Supadata.

ScrapeCreators is an alternative, but its Instagram ASR and TikTok AI fallback only support videos under two minutes. Its TikTok native subtitle retrieval is less restricted. [Instagram endpoint](https://docs.scrapecreators.com/v2/instagram/media/transcript/), [TikTok endpoint](https://docs.scrapecreators.com/v1/tiktok/video/transcript/). It was documentation-checked, not live-tested.

Direct audio transcription is also possible after Fridgie's downloader obtains the MP4, but it cannot resolve blocked social-media URLs. Keeping the existing frame extraction is essential for quantities and steps shown only on screen.
