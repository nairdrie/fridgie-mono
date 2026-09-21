# Fridgie mobile redesign

The interface now uses warm ivory, evergreen type, soft mint light, photographic recipe cards, and floating glass navigation. The changes cover planning, shopping, Discover, cookbooks, recipe detail/edit/import/suggestion sheets, profiles, groups, login, setup, preferences, notifications, and quantity editing.

## Shared components

- `apps/mobile/utils/styles.ts` holds the palette.
- `components/ui/Glass.tsx` supplies translucent surfaces, spring press feedback, iOS selection haptics, and live Reduce Motion / Reduce Transparency preferences. Blur stays behind the content and respects every corner radius.
- `components/ui/GlassTabBar.tsx` supplies the floating dock, a spring selection indicator, unread badges, tab events, and keyboard dismissal. Navigation and content respect safe areas.

The glass material uses the existing `expo-blur` native iOS implementation. This is a glass-inspired redesign compatible with this repository’s Expo 53 / React Native 0.79 runtime; it does not use iOS 26’s `UIGlassEffect` refraction API. No framework upgrade or new native dependency is required. The web variant uses browser blur, and reduced transparency uses an opaque readable surface.

The existing list synchronization, offline cache, drag ordering, ingredient editing, recipe actions, and authentication remain in place. Discover’s previously inactive edit action now opens the recipe editor, supports copies, and returns to the recipe after save or cancel. The browser now avoids loading native social SDKs; email sign-in remains available there, with social sign-in in the mobile app.

Planner navigation uses one logo-and-week row above the grocery/meal tabs. Scrolling folds away the date and reduces spacing; changing view or week restores it. Compact counts replace the large introductory panels, and empty states supply their own add actions without a duplicate floating button. Discover places its wordmark beside search.

The approved leaf with a negative-space **f** is now the shared Fridgie identity. `components/ui/Brand.tsx` supplies its mark and outlined wordmark for planner and Discover headers, sign-in, startup, and the small grocery/meal empty-state accents. Editable SVG masters and their native PNG exports live in `assets/brand`; the same mark supplies the app icon, Android adaptive icon, favicon, and ivory launch screen. This branding pass preserves screen layouts and introduces no font or native dependency.

The brand pass passes TypeScript and focused ESLint checks (one existing grocery hook warning). The icon, cold-launch splash, planner/Discover wordmarks, sign-in, and both empty-state accents were visually checked in the iOS simulator.

Follower and following counts now open paginated connection lists from either profile. People can open profiles, follow/unfollow, or remove a follower from their own list after confirmation. Failed changes preserve the row and counts; returning to a profile refreshes its relationships. The new `GET /api/user/:id/connections` and `DELETE /api/user/follower/:id` routes are included in the deployed API revision `fridgie-api-discover-e91227f`. Isolated browser fixtures cover the management flows, pagination, failure/retry, and updated counts; the latest API suite passes 373 tests (2 skipped), including 13 connection route tests.

## Validation

- TypeScript: `tsc --noEmit` passes.
- Mobile utility tests: 96 pass, 0 fail.
- ESLint: zero errors. Existing hook dependency and unused-variable warnings remain.
- Expo production export: iOS Hermes bundle and web static routes pass.
- Mobile browser checks at 393 and 320 points cover tab switching, week picker, grocery check/progress, quantity editing, meal add menu, cookbook sheet, recipe details, recipe edit/cancel, search/clear, profile, email input, and reduced motion. API/auth responses used isolated local fixtures; sample content is not shipped in the app.

Rendered previews are available locally in `apps/mobile/.expo-export-check/design/`. The overview is generated from actual application screenshots, with sample data.

The native preview now runs in the Fridgie Astra iPhone 18 Pro simulator, where the empty states, week picker, and compact headers have been checked. Launching this Expo 53 application on the iOS 27 simulator required a simulator-only compatibility copy of the built app, linked as SDK 26 to avoid iOS 27’s scene-lifecycle assertion. This is not a shipping native migration. Physical-device haptics and VoiceOver still need an on-device pass.

## Discover editions (2026-09-20)

Discover now uses a compact wordmark-and-search header with filtering chips. The scrollable page combines a food-image feature with a glass caption, staggered recipe grids, curated kitchen cards, and a community section. Surprise me opens an eligible recipe, avoiding the last opened item when alternatives exist. Focus, foreground, pull-to-refresh, and a five-minute timer while visible fetch the current stored edition without triggering generation.

The server creates original recipes under four explicitly fictional Fridgie kitchens with working profiles, searchable handles and cookbook entries. The UI labels original AI recipes, user-adapted copies and illustrative images; counts reflect actual records and interactions. Publication timestamps drive freshness labels. The publisher's bounded daily rotation and production setup are documented in [Discover publishing](./discover-publishing.md).

Validation: compact 393px browser layout, collection filter, Surprise-to-detail and creator-to-cookbook navigation; native Astra iOS simulator rendering and filter interaction; 96 mobile utility tests, TypeScript and the iOS Metro bundle pass. The client changes are in the workspace/simulator, not distributed as an App Store release.

- Production Discover QA: the iOS simulator loaded the first published edition, rendered all four curator cards and opened the hero recipe. Maya Green’s public cookbook resolved its three published recipes and opened a recipe detail. Public profiles now use one virtualized scroll surface for the profile header, filters and recipes, removing the nested-list warning; focused typecheck/lint and 25 cookbook/Discover tests pass. The simulator also refreshed to the first automatic edition and displayed its new featured recipe and updated cookbook counts.
