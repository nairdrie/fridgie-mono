# Fridgie Pro backend setup

The API is safe to deploy before billing is configured. With no RevenueCat
secret it reports the entitlement as `unavailable`, grants no Pro access, and
keeps the normal free weekly allowance. It never simulates a successful
purchase.

## Runtime behavior

- `GET /api/account/status` returns the authenticated account's authoritative
  plan, entitlement (including the verified `productIdentifier`) and weekly AI
  usage. Verified Pro responses also include the separate Leftovers scan
  allowance, including its exact reset boundary.
- `POST /api/account/status/refresh` bypasses the short entitlement cache. The
  app should call it after a purchase or restore. The Firebase UID from the ID
  token is always used as RevenueCat's App User ID; a client cannot ask the API
  to verify somebody else's subscriber.
- `POST /api/meal/suggest` reserves one use in a Firestore transaction just
  before calling the model. Concurrent calls cannot cross the limit. A caught
  model/validation failure refunds that reservation transactionally. A process
  crash can leave the accepted use counted, which is intentional: the backend
  cannot safely know whether the provider already billed it. Request bodies
  are capped at 64 KiB and return `suggestion_request_too_large` with HTTP 413.
- Usage resets every Monday at 00:00 UTC. State lives at
  `users/{uid}/system/aiUsage` in `fridgie-db`, so reinstalling or switching
  devices does not reset it.
- Pro Leftovers photo analysis uses a separate 50-scan weekly bucket at
  `users/{uid}/system/leftoversScanUsage`. This prevents one scan followed by
  one suggestion from appearing as two suggestion uses. Only one scan per
  account runs at a time by default, and failed provider calls can refund their
  reservation. Configure these controls with
  `FRIDGIE_PRO_WEEKLY_LEFTOVERS_SCAN_LIMIT` and
  `FRIDGIE_MAX_CONCURRENT_LEFTOVERS_SCANS`.
- Ask Fridgie (`POST /api/recipe/ask/:id`, a chat about one open recipe) is
  Pro-only and uses its own 200-message weekly bucket at
  `users/{uid}/system/recipeChatUsage`, plus a non-refundable 40/hour attempt
  guard at `users/{uid}/system/recipeChatHourlyAttempts`. Configure them with
  `FRIDGIE_PRO_WEEKLY_RECIPE_CHAT_LIMIT` and
  `FRIDGIE_RECIPE_CHAT_HOURLY_ATTEMPT_LIMIT`. The route only ever *proposes*
  edits, and only on a recipe whose `createdBy` is the caller; the app saves a
  proposal through the ordinary `POST /api/recipe` after the cook taps Apply.
- Provider dispatches also use separate, non-refundable per-account attempt
  ledgers at `users/{uid}/system/suggestHourlyAttempts` and
  `users/{uid}/system/leftoversHourlyAttempts`. They reset at the next fixed UTC
  clock hour and default to 20 suggestion attempts/hour and 8 Leftovers
  attempts/hour. A provider failure may refund the visible weekly allowance,
  but never its attempt, so repeated failures cannot create unbounded spend.
  Configure the caps with `FRIDGIE_SUGGEST_HOURLY_ATTEMPT_LIMIT` and
  `FRIDGIE_LEFTOVERS_HOURLY_ATTEMPT_LIMIT`. A rejected dispatch returns HTTP
  429, a `Retry-After` header, and an `attemptUsage` status object containing
  the limit, usage, remaining attempts, and exact window boundaries.
- Entitlement state lives at `users/{uid}/system/entitlement`. The API refreshes
  stale state from RevenueCat and never promotes an unverified entitlement.
  During a provider outage, a previously verified active entitlement remains
  valid only through its known expiration.

The defaults are 10 accepted suggestions/week for Free and 100/week for Pro.
The Pro limit is intentionally finite: each suggestion currently asks Claude
Sonnet for three complete recipes, so 100 is a substantial increase while
putting a predictable ceiling around model spend. Change the limits centrally
with `FRIDGIE_FREE_WEEKLY_AI_LIMIT` (1–10) and
`FRIDGIE_PRO_WEEKLY_AI_LIMIT` (11–10000).

## RevenueCat operator steps

1. In App Store Connect and Play Console, create the replaceable monthly and
   annual products chosen by the mobile configuration (initial pricing
   hypothesis: US$4.99/month and US$39.99/year; stores localize display prices).
2. Add the iOS and Android apps to one RevenueCat project. Import both products,
   attach them to an entitlement whose identifier is `fridgie_pro`, and put them
   in the current offering. The mobile RevenueCat SDK must log in with the authenticated
   Firebase UID, not an anonymous RevenueCat-generated ID.
3. Create a RevenueCat v1 secret API key for server-side customer reads. Store
   it in Google Secret Manager; never add it to EAS or an `EXPO_PUBLIC_*`
   variable:

   ```sh
   gcloud secrets create fridgie-revenuecat-secret-api-key --replication-policy=automatic
   printf '%s' "$REVENUECAT_SECRET_API_KEY" | \
     gcloud secrets versions add fridgie-revenuecat-secret-api-key --data-file=-
   gcloud secrets add-iam-policy-binding fridgie-revenuecat-secret-api-key \
     --member="serviceAccount:${RUNTIME_SA}" \
     --role=roles/secretmanager.secretAccessor
   ```

4. Add this binding to the existing Cloud Run deployment's `--set-secrets`
   value (preserve the Anthropic and Supadata bindings already there):

   ```text
   REVENUECAT_SECRET_API_KEY=fridgie-revenuecat-secret-api-key:latest
   ```

   If the entitlement identifier is not `fridgie_pro`, add
   `REVENUECAT_ENTITLEMENT_ID=<identifier>` to `--set-env-vars`. Optional limit
   and cache overrides belong there too. Update both the one-time bootstrap
   command and `.github/workflows/ci.yml`; Cloud Run deploys patch existing
   configuration, so the workflow must remain the source of truth.

5. Exercise sandbox purchase, expiry, cancellation and restore on both stores.
   Confirm the refresh endpoint returns `isPro: true` only for the expected
   Firebase UID and that an expired sandbox subscription returns Free.

RevenueCat recommends webhooks for prompt lifecycle updates. This first version
does not need to trust webhook payloads: the API checks RevenueCat's canonical
customer endpoint at most every 15 minutes and supports a forced post-purchase
refresh. Simultaneous refreshes for one account are coalesced in-process. A
later webhook should authenticate RevenueCat's configured header or HMAC
signature and then perform the same canonical customer lookup rather than
granting access directly from event fields.
