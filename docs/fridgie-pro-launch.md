# Fridgie Pro launch checklist

The repository contains the complete credential-independent subscription,
entitlement, quota, Leftovers Mode, and nutrition flows. Checkout stays
disabled when secure verification is unavailable; development builds never
pretend a purchase succeeded.

## Identifiers and pricing

The replaceable defaults are centralized in `apps/mobile/constants/pro.ts`:

| Item | Default |
| --- | --- |
| RevenueCat entitlement | `fridgie_pro` |
| RevenueCat offering | `default` |
| Monthly product | `fridgie_pro_monthly` |
| Annual product | `fridgie_pro_annual` |
| Pricing hypothesis | US$4.99/month, US$39.99/year |

The app always renders the localized price returned by the store. The dollar
amounts above are fallback launch copy only and cannot initiate a purchase.
If production identifiers differ, set the corresponding `EXPO_PUBLIC_*`
values below instead of editing paywall code.

## App Store Connect and Play Console

1. Accept the current paid-app agreements and complete tax/banking setup for
   the existing iOS and Android developer accounts.
2. In App Store Connect, enable In-App Purchase for
   `com.nairdrie.fridgie`, create one auto-renewable subscription group, then
   add monthly and annual products. Add required localization, review notes,
   pricing, and a paywall review screenshot.
3. In Play Console, create matching monthly and annual subscriptions for
   `com.nairdrie.fridgie`, add and activate their base plans, and configure
   license testers. The generated Android manifest is set to `singleTop` by
   `plugins/withRevenueCatAndroidLaunchMode.js` so bank-app verification does
   not cancel checkout.
4. Do not promise “unlimited.” The backend defaults to 100 accepted suggestion
   generations per UTC week for Pro, configurable with
   `FRIDGIE_PRO_WEEKLY_AI_LIMIT`. Leftovers analysis has a separate default of
   50 scans/week and one in-flight scan/account, configurable with
   `FRIDGIE_PRO_WEEKLY_LEFTOVERS_SCAN_LIMIT` and
   `FRIDGIE_MAX_CONCURRENT_LEFTOVERS_SCANS`. Non-refundable provider-attempt
   guards additionally cap each account at 20 suggestion dispatches/hour and 8
   Leftovers dispatches/hour by default, configurable with
   `FRIDGIE_SUGGEST_HOURLY_ATTEMPT_LIMIT` and
   `FRIDGIE_LEFTOVERS_HOURLY_ATTEMPT_LIMIT`.

## RevenueCat

1. Create one RevenueCat project and add both store apps. Upload the current
   App Store and Google Play service credentials RevenueCat requests.
2. Import both products, attach them to the `fridgie_pro` entitlement, and add
   packages `$rc_monthly` and `$rc_annual` to the `default` offering. If any
   identifier differs, set the overrides below on every EAS environment and
   set the same entitlement identifier on the API.
3. Copy each app's **public SDK key** into EAS. Public SDK keys are expected in
   the compiled client; the RevenueCat secret key is not.

   ```sh
   eas env:create --environment production --name EXPO_PUBLIC_REVENUECAT_IOS_API_KEY --value <ios_public_key> --visibility plaintext
   eas env:create --environment production --name EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY --value <android_public_key> --visibility plaintext
   ```

   Repeat for the EAS `preview` and `development` environments used for store
   sandbox testing. A fresh native build is required after adding the SDK or
   changing native configuration; Expo Go cannot perform real purchases.

4. Optional mobile overrides:

   ```text
   EXPO_PUBLIC_REVENUECAT_PRO_ENTITLEMENT_ID=fridgie_pro
   EXPO_PUBLIC_REVENUECAT_OFFERING_ID=default
   EXPO_PUBLIC_FRIDGIE_PRO_MONTHLY_PRODUCT_ID=fridgie_pro_monthly
   EXPO_PUBLIC_FRIDGIE_PRO_ANNUAL_PRODUCT_ID=fridgie_pro_annual
   EXPO_PUBLIC_PRIVACY_URL=https://…
   EXPO_PUBLIC_TERMS_URL=https://…
   ```

   Supply real Privacy Policy and Terms URLs before store review. They are
   intentionally not guessed by the app.

5. Create a RevenueCat **v1 secret API key** with subscriber-read access and
   place it in the API runtime as `REVENUECAT_SECRET_API_KEY`. Set
   `REVENUECAT_ENTITLEMENT_ID=fridgie_pro`. See
   `apps/api/docs/fridgie-pro.md` for Cloud Run Secret Manager commands,
   cache behavior, quota storage, and endpoint details.

The Firebase UID is the RevenueCat App User ID on device and server. Anonymous
Fridgie guests must sign in before checkout, which gives purchases a durable
cross-device identity. The API performs the authoritative RevenueCat lookup;
local SDK state alone never unlocks Pro.

## Firestore authority boundary

Pro entitlements, weekly quota ledgers, nutrition goals, and nutrition caches
are server-owned. Mobile code has no direct Firestore data path, so
`firestore.rules` denies every mobile/web client read and write while the API's
Admin SDK continues to use IAM. `firebase.json` targets the actual named
database, `fridgie-db`, rather than silently publishing to `(default)`.

The `main` deployment publishes these rules before it deploys a new API
revision. Grant the Workload Identity deployer the narrow rules role once:

```sh
gcloud services enable firebaserules.googleapis.com \
  --project=grocerease-5abbb
gcloud projects add-iam-policy-binding grocerease-5abbb \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role=roles/firebaserules.admin \
  --condition=None
```

Do not replace that with `roles/firebase.admin`; the rules deployer does not
need access to user documents. A rules deployment failure stops the API release
before traffic is changed.

## Nutrition provider

Fridgie had no existing nutrition source. The implementation uses a
provider interface and an Edamam adapter, but outbound analysis is off unless
`NUTRITION_PROVIDER_ENABLED=true` and both credentials are present. Leave that
flag off until signed terms approve storage/caching and attribution and a
provider-side hard monthly spend/request/licensing cap is configured. The
per-request analysis/concurrency controls do not bound aggregate cost. Complete
the approval, credential, cap, and smoke-test steps in
`docs/nutrition-provider.md` before enabling estimates in production.

## Release verification

Use store sandbox accounts on real iOS and Android builds and verify:

1. Free usage shows its remaining count and exact reset, warns at 3 and 1, and
   opens the paywall at 0. Two concurrent tenth requests must yield one success
   and one HTTP 429, never eleven accepted uses.
2. Monthly and annual checkout display localized store prices. Cancellation
   leaves the user Free. A successful purchase unlocks only after the API
   refresh verifies the `fridgie_pro` entitlement.
3. Restore Purchases works after reinstall and on a second device signed into
   the same Fridgie account. Expiry, billing failure, and revocation return the
   account to Free after server refresh/cache expiry.
4. Leftovers Mode accepts multiple camera/library photos, supports reorder and
   removal, survives one unusable photo, discards photo data after analysis,
   and never logs or persists source images.
5. Nutrition goals, planned totals, cooked toggles, partial coverage, and the
   no-provider state all remain explicitly labeled as estimates and never gate
   free dietary/allergen controls.
6. With either mobile public keys or the server secret removed, checkout is
   disabled or verification returns an honest error; no path grants Pro.

No ad network is added in this release. `isPro` is the durable server-backed
entitlement future Discover ad rendering must check before showing a native ad.
