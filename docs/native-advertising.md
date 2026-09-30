# Discover native advertising runbook

## Current product boundary

Discover supports a provider-neutral, low-frequency sponsored slot. The default provider is a Fridgie-controlled house card; missing inventory is no-fill. No third-party sponsor is implied by a house card. Search, Cook Mode, recipe details, timers, grocery controls, nutrition warnings, and allergen contexts never render these slots.

AdMob Native is an optional pilot. It does **not** guarantee food- or grocery-only inventory. AdAdapted remains a possible later grocery/CPG specialist, but it is not integrated and no commercial or privacy terms are assumed here.

The first slot is no earlier than six organic recipe cards. The server may set the repeat interval from 8–12 organic cards and a session maximum. Ads never replace or reorder recipes, and no-fill renders nothing—there is no empty placeholder.

## Two independent enablement gates

Both gates must allow an ad before a provider is called:

1. `appConfig/discoverAds.enabled` is the server kill switch. A missing document, invalid data, read error, or failed mobile refresh disables the surface.
2. The Pro entitlement adapter must explicitly return `ad-supported`. `ad-free`, loading, an adapter error, and the default `unknown` state all suppress ads.

The adapter boundary is intentionally narrow:

```ts
interface DiscoverAdEntitlementAdapter {
  getAdEntitlement(): 'ad-supported' | 'ad-free' | 'unknown' | Promise<...>;
  subscribe?(listener): () => void;
}
```

The root app wires this boundary synchronously beneath `ProProvider`. Only a
current server-verified inactive entitlement maps to `ad-supported`; Pro,
loading, unavailable verification, refresh errors, pending store recovery and
account switches map to `ad-free` or fail-closed `unknown`. Do not copy receipt,
product, trial, or restoration logic into the advertising layer.

## Server-controlled house inventory

Firestore document: `appConfig/discoverAds`

```json
{
  "enabled": true,
  "providerOrder": ["house"],
  "cadence": {
    "firstAfter": 6,
    "interval": 10,
    "maxPerSession": 2
  },
  "houseAds": [
    {
      "id": "autumn-collections",
      "headline": "A week of cozy dinners",
      "body": "Browse a Fridgie collection made for cooler evenings.",
      "ctaLabel": "Browse the collection",
      "destinationUrl": "https://fridgie.ca/collections/autumn"
    }
  ]
}
```

The API forces the displayed brand to `Fridgie` and the client forces the disclosure to `From Fridgie`. IDs are session-deduplicated. Destinations must be an internal app path, a `fridgie:` deep link, or HTTPS on `fridgie.ca`; unsafe cards are dropped. Keep every house card food-related and useful (a real feature, collection, cookbook-print preview, or honest internal promotion).

Set `enabled: false` for an immediate global shutdown. Set `providerOrder` to `['admob', 'house']` only for the controlled AdMob-first pilot; house remains the no-fill fallback.

## AdMob native build configuration

The dependency is pinned to `react-native-google-mobile-ads@15.8.3` for the current Expo 53 / React Native 0.79 app. Version 16.x currently fails React Native New Architecture code generation for this app, while 15.8.3 completes the iOS prebuild and CocoaPods install. The dependency contains native code and is unavailable in Expo Go; rebuild the development client after configuration changes.

Development and preview builds always receive Google's published sample app IDs and native ad-unit IDs. Store builds fail during Expo config evaluation unless all four real values are present and well formed; Google test IDs are explicitly rejected:

- `ADMOB_ANDROID_APP_ID`
- `ADMOB_IOS_APP_ID`
- `EXPO_PUBLIC_ADMOB_ANDROID_NATIVE_UNIT_ID`
- `EXPO_PUBLIC_ADMOB_IOS_NATIVE_UNIT_ID`

`EXPO_PUBLIC_ADMOB_ENABLED=true` makes the native provider eligible, but the server kill switch and entitlement gate still apply. App IDs are build-only values; ad-unit IDs and enablement are public client configuration, not secrets.

The plugin delays app measurement initialization. UMP consent is gathered before the SDK is initialized or an ad request is made. If consent cannot be resolved or `canRequestAds` is false, the provider returns no-fill. Every request sets `requestNonPersonalizedAdsOnly: true` and sends no keywords, content URLs, location, publisher-provided identifier, search text, recipe data, allergies, medical diets, pregnancy-related choices, grocery-list content, or household/profile data.

This pilot does not request App Tracking Transparency and does not add `NSUserTrackingUsageDescription`, because it does not opt into IDFA-based tracking. Add ATT only if a later, separately reviewed product change actually performs tracking.

Native ads with video content are rejected and destroyed before rendering. The card uses advertiser identity, icon, headline, body, one CTA, the SDK-inserted AdChoices asset, and separate Why/Hide/Report controls. AdMob inventory is always labelled `Advertisement · [Advertiser]` before the headline.

## Privacy-minimized measurement

The client sends only this allowlisted body to `POST /api/explore/ads/event`:

```json
{ "event": "impression", "provider": "house" }
```

The other allowed events are `click`, `hide`, and `report`; the other provider is `admob`. The server stores UTC-day/provider/event aggregate counters only. It does not store UID, creative copy, recipe/search context, dietary data, household data, or a cross-context profile. AdMob impression/click events come from its SDK; a house impression is counted only after the card is materially visible.

## app-ads.txt and store work (not complete)

The repository's root [`app-ads.txt`](../app-ads.txt) intentionally authorizes no seller because no real AdMob publisher ID was supplied. `fridgie.ca` hosting is outside this repository. Before production enablement:

- [ ] Replace the comment-only file with the exact seller line supplied by the real AdMob account—never a sample or guessed publisher ID.
- [ ] Publish it at `https://fridgie.ca/app-ads.txt`, put that developer domain in both store listings, and wait for AdMob verification.
- [ ] In Google Play Console, declare that the app contains ads.
- [ ] Review and submit Google Play Data safety answers against the exact Mobile Ads SDK/UMP configuration and actual data flows.
- [ ] Review and submit App Store privacy nutrition labels against those same flows.
- [ ] Configure and publish the required UMP privacy messages in the AdMob console for served regions.
- [ ] Add and device-test an in-app UMP privacy-options control so people can revisit consent choices; keep the AdMob provider disabled until this exists.
- [ ] Confirm the final privacy policy explains house cards, AdMob, non-personalized/contextual mode, Hide/Report, aggregate measurement, and the Pro ad-free benefit.
- [ ] Run a real production-config EAS build for both platforms and test consent, AdChoices, no-fill, kill switch, and Pro suppression on devices.

None of those console, account, domain-hosting, or store-listing steps is performed or claimed complete by this repository change.
