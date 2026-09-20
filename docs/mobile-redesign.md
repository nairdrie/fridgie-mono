# Fridgie mobile redesign

The interface now uses warm ivory, evergreen type, soft mint light, photographic recipe cards, and floating glass navigation. The changes cover planning, shopping, Discover, cookbooks, recipe detail/edit/import/suggestion sheets, profiles, groups, login, setup, preferences, notifications, and quantity editing.

## Shared components

- `apps/mobile/utils/styles.ts` holds the palette.
- `components/ui/Glass.tsx` supplies translucent surfaces, spring press feedback, iOS selection haptics, and live Reduce Motion / Reduce Transparency preferences. Blur stays behind the content and respects every corner radius.
- `components/ui/GlassTabBar.tsx` supplies the floating dock, a spring selection indicator, unread badges, tab events, and keyboard dismissal. Navigation and content respect safe areas.

The glass material uses the existing `expo-blur` native iOS implementation. This is a glass-inspired redesign compatible with this repository’s Expo 53 / React Native 0.79 runtime; it does not use iOS 26’s `UIGlassEffect` refraction API. No framework upgrade or new native dependency is required. The web variant uses browser blur, and reduced transparency uses an opaque readable surface.

The existing list synchronization, offline cache, drag ordering, ingredient editing, recipe actions, and authentication remain in place. Discover’s previously inactive edit action now opens the recipe editor, supports copies, and returns to the recipe after save or cancel. The browser now avoids loading native social SDKs; email sign-in remains available there, with social sign-in in the mobile app.

## Validation

- TypeScript: `tsc --noEmit` passes.
- Existing mobile tests: 38 pass, 0 fail.
- ESLint: zero errors. Existing hook dependency and unused-variable warnings remain.
- Expo production export: iOS Hermes bundle and web static routes pass.
- Mobile browser checks at 393 and 320 points cover tab switching, week picker, grocery check/progress, quantity editing, meal add menu, cookbook sheet, recipe details, recipe edit/cancel, search/clear, profile, email input, and reduced motion. API/auth responses used isolated local fixtures; sample content is not shipped in the app.

Rendered previews are available locally in `apps/mobile/.expo-export-check/design/`. The overview is generated from actual application screenshots, with sample data.

This environment does not contain full Xcode or an iOS simulator. Native runtime behavior, keyboard geometry, haptic feel, VoiceOver, and native blur still need an on-device pass. The iOS bundle check validates JavaScript/assets, not a signed native application build.
