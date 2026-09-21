# Recipe imports and system sharing

Fridgie accepts recipe-site links, TikTok links (including short links and pasted share text), and publicly readable Instagram Reels/posts. Incoming system shares open `/import-recipe`, then the existing recipe editor. Extraction produces an editable review; it never saves automatically or adds meals or groceries.

## User flow

1. In TikTok or Instagram, share the **link** using the system share sheet and choose **Fridgie**. Depending on the source app, the system sheet may be behind its More/Share to action.
2. Fridgie keeps the link locally while authentication loads. If necessary, sign in or finish setting up the profile; the same import resumes afterward.
3. Check the extracted ingredients, quantities, steps, and source credit, then choose **Save to cookbook**.

Pasting a link in the normal cookbook editor uses the same validation and review. Failed imports keep the link editable and offer a screenshot fallback. Cancellation fences off late results. A failed cookbook write keeps the reviewed recipe open; retry reuses the already-saved recipe ID. Another share queues behind the active import instead of replacing it. The inbox persists links, not unsaved edits to the extracted recipe.

## Instagram and TikTok

`apps/api/utils/instagram.ts` reads published caption/metadata and available video URLs, then the importer uses the same evidence-based recipe extraction and bounded frame sampling as TikTok. Creator attribution and canonical Instagram shortcode identity survive save; tracking variants and `/p/` versus `/reel/` do not create different source identities.

Only publicly accessible content is supported. Supadata now supplies audio transcripts when captions/subtitles are insufficient and can recover public videos blocked to the local metadata collector. No Instagram login or cookies from a user account are used. Private/deleted posts, login walls, and rate limits return actionable errors. Missing recipe evidence returns “No recipe found” rather than inventing ingredients.

All source, subtitle, and video requests now use bounded public fetching: validated redirect destinations, public DNS results pinned to the connection, response-size/time limits, and platform media-host restrictions.

## Native setup and release

- `expo-share-intent` is pinned to **4.1.2**, the upstream Expo SDK 53 version. The small upstream `xcode@3.0.1` patch is applied by `patch-package` alongside the existing postinstall patch.
- The iOS share extension is `com.nairdrie.fridgie.share-extension`, target **Save to Fridgie**. Both targets use **group.com.nairdrie.fridgie**. Activation accepts one web URL/web page or text; raw image/video sharing is not advertised.
- Android receives `ACTION_SEND` with `text/*`. Expo Router rewrites the extension’s transport URL and routes the durable shared-link inbox into the import screen.
- This requires a **new native build**; an OTA JavaScript update or Expo Go cannot add a system share extension. Real-device/release signing must provision the host and extension with the matching Apple App Group. No Apple account configuration was changed here.
- The Instagram/Supadata backend is deployed to `api.fridgie.ca` as of 2026-09-20. Distributing the share extension still requires a signed native client build.

Primary references: [module compatibility and configuration](https://github.com/achorein/expo-share-intent/tree/v4.1.2), [Expo native-intent routing](https://docs.expo.dev/router/advanced/native-intent/), [Apple share extensions](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Share.html).

## Verification

- Mobile TypeScript passes; all 96 mobile utility tests pass, including link parsing, async isolation, pending-link persistence and duplicate-event handling.
- Isolated browser checks exercise automatic extraction into review, failed cookbook filing, retry using the same recipe ID (one recipe write, two filing attempts), return to the cookbook, blocked-Reel messaging, screenshot fallback, cancellation of late responses, and keep/discard confirmation for an unsaved draft. Fixture traffic cannot reach production services.
- A live unauthenticated fetch of [this public Reel](https://www.instagram.com/reel/CV9O_GRrO6t/), linked by [its creator’s recipe page](https://www.zezzacooks.com/tomato-burrata-pasta/), returned caption, creator, cover and video URL. Subsequent authenticated cloud tests verified both providers. A captionless live Reel extraction returned a 16-ingredient, 15-step Pumpkin Cinnamon Roll Honey Buns recipe in 26 seconds, using actual Supadata and Anthropic calls. No user recipe was saved.
- API TypeScript passes; 373 API tests pass, with two ffmpeg-dependent tests skipped because ffmpeg is unavailable in the local test environment.
- On the Astra iOS simulator, Safari’s real system share sheet displays Fridgie with its brand icon. Both warm and cold app launches retain the exact public Reel URL and reach the sign-in-to-import screen. The shared App Group payload is cleared after the durable inbox receives it. This validates native handoff; authenticated extraction/save was exercised separately with isolated browser fixtures.
- TikTok/Instagram application share buttons still need a physical-device pass. Android intent configuration is generated, but Android runtime sharing was not tested. Physical-device release signing/provisioning remains outstanding; API and compatibility-function deployment is complete.

## Audio transcription provider

Supadata is integrated for videos without useful descriptions or subtitles. Public-demo tests and authenticated API calls from Google Cloud succeeded for both TikTok and Instagram on 2026-09-20. The key is a server-side Secret Manager binding. See [provider findings and implementation notes](./social-transcription-provider.md).
