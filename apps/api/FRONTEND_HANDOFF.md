# Fridgie API — Backend Report & Frontend Handoff

*Backend repo (`nairdrie/fridgie-api`), branch `claude/nifty-lamport-2so384`, 2026-06-11.*
*Audience: frontend agent (app repo owner). This replies to the "Full App Review & Backend Handoff" doc, §3–§4.*

---

## 1. Status of your §3 requests

| § | Request | Status |
|---|---|---|
| 3.1 | Preserve `overrideBase` / unknown `Item` fields | ✅ Done. `Item` is treated as open everywhere. Details in §2.1. |
| 3.2 | `NEEDS-RANK` migration + write-time validation | ✅ Done. Write-time repair on every `POST /list/:id`; migration script `scripts/migrateRanks.ts` ready (needs prod creds to run — Nick, see §5). |
| 3.3 | Echo suppression + revisioning | ✅ Implemented. Full contract in §2.2 — **this is the part you need to wire**. |
| 3.4 | Quantity normalization at source | ✅ Done. Importer + suggest prompts now demand canonical `"<decimal> <unit>"`, and the server re-normalizes outputs (`utils/quantity.ts`) as a backstop. |
| 3.5 | Confirmations | Answered in §3 below. **Two require client changes** (push-token route, recipe fork id adoption). |

## 2. New/changed server contracts

### 2.1 Items are opaque (§3.1)
- `POST /list/:id` stores items as-is (only repairs invalid `listOrder`/`mealOrder`; all other keys untouched).
- `POST /list/categorize/:id` rebuilds the array by **spreading the original item objects**, so `mealId`, `quantity`, `overrideQuantity`, `overrideBase`, `mealOrder`, and any future fields survive.
- Bug fixed while in there: items whose text the AI rewrote used to be **silently dropped from the list**. They are now appended under a trailing `"Other"` section instead. Expect that section to appear in categorize responses.
- `POST /meal` creates ingredient items fresh; it now also assigns a real `mealOrder` LexoRank per ingredient (previously absent), normalizes `quantity` to canonical form, and omits the `quantity` key entirely when the recipe has none (a recipe with a quantity-less ingredient previously 500'd the whole endpoint — RTDB rejects `undefined`).

### 2.2 Save protocol: `clientId` + `rev` (§3.3) — **wire this**
List docs now carry two new server-managed top-level fields (ignore unknown top-level keys when parsing, same as items):
- `rev: number` — monotonically increasing, bumped on **every** committed mutation (client saves, categorize, add-meal).
- `lastClientId: string` — the `clientId` of the client save that produced this revision; **absent** on server-initiated writes (categorize, add-meal, migrations).

**Request** — `POST /api/list/:id?groupId=...`:
```jsonc
{
  "items": [...], "meals": [...], "sort": "...",
  "clientId": "<stable per-app-instance uuid>",   // optional
  "rev": 41                                        // optional: last rev this client saw
}
```
`clientId` and `rev` are consumed by the server, not stored in your payload. Writes are applied inside an RTDB transaction (no more torn read-modify-write between two API calls).

**Responses**:
- `200 { "status": "updated", "rev": 42 }`
- `409 { "error": "stale_rev", "rev": 45, "list": { ...current doc... } }` — your `rev` was behind. Rebase onto `list` (it includes the winning `items`/`meals`/`rev`) and re-save with the new rev.
- `404 { "error": "Not found" }` — the list no longer exists (saves used to silently create ghost docs; they don't anymore).

**Echo suppression**: every WS snapshot is the full doc, so it now includes `rev` and `lastClientId`. Drop any snapshot where `lastClientId === yourClientId` (it's your own save echo). Snapshots without `lastClientId` are server-initiated (categorize / add-meal) — always apply. You can retire the 1.2 s dirty-window heuristic.

**Back-compat**: omitting `clientId`/`rev` keeps the old last-write-wins behavior, so you can ship incrementally.

Item-level patch ops (your §3.3.3) remain future work — agreed it's the right end state.

### 2.3 `POST /recipe` — author check + fork (answers §3.5 "saveRecipe by non-author")
Previously **any user could overwrite any recipe in place** (and the write reassigned `createdBy` to the caller) — fixed. New semantics:
- No `id` → created, `201`, server-generated id.
- `id` unknown to the server → created **with your id** (so client-generated ids keep working), `201`.
- `id` exists, caller is the author → in-place update, `200`.
- `id` exists, caller is **not** the author → **fork**: new doc with `forkedFromId` = root recipe id, `201`, response `id` is the **new** recipe's id. ⚠️ **Client action**: rate-meal photo save must adopt the returned `id` (e.g. update `meal.recipeId`), otherwise the meal keeps pointing at the original. If you'd rather have 403 + author-gated photo button, say so — easy to flip.
- `createdBy` / `createdAt` / `forkedFromId` in the request body are now ignored (server-managed).

## 3. §3.5 confirmations

- **`weekStart` format**: weeks are **Sunday-based** ✅. Stored value is a **full UTC ISO timestamp** of Sunday 00:00 *in the timezone the app passes to `GET /list?tz=...`* (e.g. `2026-06-07T04:00:00.000Z` for Toronto). So `substring(0,10)` → local `yyyy-MM-dd` is correct **only for UTC-negative offsets** (the Americas). For UTC+ timezones (Europe/Asia), local Sunday midnight is Saturday in UTC, so the first 10 chars give **Saturday's date** — week labels would be off by a day there, and the server's own week-dedupe has the same skew (group members in mixed timezones can produce duplicate weeks). Recommendation: we migrate storage to a plain local `yyyy-MM-dd` string in a coordinated change (your parser already handles it). Until then your parsing is fine for NA users. Flag if you want this scheduled now.
- **Push token route**: the server route is **`POST /api/notification/save-push-token`** (singular, like all notification routes). Your client POSTs to `/notifications/...` → that's a 404 today. **Client action: fix the path.** Also: the Expo push *pipeline is not live* — see §4 Q5.
- **WS broadcast on `POST /meal`**: confirmed working by construction — all list writes (client saves, categorize, add-meal) go through RTDB, and the per-list RTDB listener broadcasts every change to all subscribed sockets, including the sender. The old "doesn't show up right away" bug was most likely your (now-fixed) socket churn/no-reconnect issue, with one nuance: the broadcast only reaches sockets subscribed to **that listId** — if Explore added the recipe to a different week's list than the one open, nothing visible changes on the open list by design.
- **Env URLs**: the API container serves HTTP/WS on port 3000 (Bun default; Dockerfile `EXPOSE 3000`). TLS/WSS termination is at the deployment layer, which isn't in this repo — Nick needs to confirm `https://api.fridgie.ca/api` + WSS are live in prod (the server code itself is scheme-agnostic and the WS path is `/api/ws/list/:listId`).
- **`scheduleMealRating`**: now idempotent per `(listId, mealId)` — re-scheduling replaces the prior job. Also fixed: the endpoint previously **500'd on every call** (it called `.toISOString()` on the JSON string `sendAt`), so scheduling had never actually worked. It returns `200 {status:'ok', message:'No push token for user.'}` without scheduling when the user has no token.
- **`hasContent`**: confirmed — computed by the server on every `GET /api/list` response (`items.length > 1`, or 1 non-empty item); never stored, never expected from the client.

## 4. Answers to §4 questions

**Q1 — Categorize contract.** `POST /api/list/categorize/:id?groupId=...`, optional body `{items}` (used as source-of-truth when present; DB fallback otherwise). Response: the complete new `items[]` (sections + items) that was also written to the DB. All original item fields preserved via spread (`mealId`, `quantity`, `overrideQuantity`, `overrideBase`, `mealOrder`, anything else). Every element — sections included — gets a fresh, valid `listOrder` LexoRank (sequential `genNext` from `middle()`); `mealOrder` is untouched. Unmatched/renamed items now land under a final `"Other"` section instead of being dropped. The write bumps `rev` with no `lastClientId`, and is broadcast over the WS like any change.

**Q2 — WS protocol.** Connect: `wss://<host>/api/ws/list/:listId?groupId=<gid>&token=<firebase idToken>`. Server verifies the ID token **and now also group membership** (this check was missing — any authenticated user could previously subscribe to any list; fixed today). Messages: server→client only; each message is the raw JSON of the **entire list doc**, sent once on subscribe and then on every RTDB change. **Yes, the sender receives its own broadcast** — use `rev`/`lastClientId` (§2.2) to drop echoes. No server-side debounce. Client→server messages are ignored. If the list is deleted you'll receive `null`. Token-in-query: the app itself doesn't log URLs, but any proxy/load-balancer in front may log query strings — agreed first-message auth is better; noted as a backend follow-up (will coordinate, since it's a breaking WS change).

**Q3 — Importer samples.** I can't query prod data from this environment, so no real samples — Nick can pull some if you want empirical coverage. What I can give you is the new contract: the importer prompt now mandates `"<decimal> <unit>"` with unit ∈ `g, kg, oz, lb, ml, l, tsp, tbsp, cup` (or bare number), fractions → decimals, ranges → lower bound, `"to taste"`/empty for unmeasurables, first unit only for dual-unit listings — and the server **re-normalizes every ingredient after parsing** (`utils/quantity.ts`: unicode fractions, mixed numbers, `1/2`, unit aliases incl. `c`→`cup`, anchored matching). Unparseable strings pass through untouched, so your freeform fallback still sees `"to taste"` as-is.

**Q4 — Suggest contract.** `POST /api/meal/suggest`, optional body `{vetoedTitles: string[]}`. Response: raw **array** of 3 recipe objects `{name, description, ingredients: [{name, quantity}], instructions: string[], tags: string[]}`. **No `id`** (suggestions aren't persisted — they only get an id once saved via `POST /recipe`) and **no `photoURL`** (never populated for suggestions). `tags` are populated. Quantities now normalized per Q3. When preferences are unset: `404 {error, action: 'redirect_to_preferences'}`.

**Q5 — Notification routes.** Definitive list (all **singular** `/api/notification`):
- `GET /api/notification` — unread notifications, newest first
- `DELETE /api/notification/:id` — dismiss (owner-checked)
- `POST /api/notification/save-push-token` — body `{token}`
- `POST /api/notification/schedule-rating` — body `{mealId, listId, sendAt}`

Follow (`NEW_FOLLOWER`) and group invitations (`group_invitation`) create Firestore notification docs for the in-app list — **but no push notifications are sent anywhere**: there is no Expo push sender in the backend. Scheduled rating jobs are persisted (`scheduledNotifications/` in RTDB) but no worker delivers them. So: in-app notifications ✅, pushes ❌ (backend follow-up — see §5). One more caveat: the `GET` query needs a Firestore composite index (`recipientUid ==` + `read ==` + `createdAt desc`); if notifications 500 in prod, that index is missing.

**Q6 — Anonymous → registered migration.** There is **no server-side migration**. Everything is keyed by Firebase `uid` (groups membership, lists via group, cookbook at `users/{uid}`, recipes `createdBy`). If the client upgrades the anonymous user via `linkWithCredential` (uid preserved), all data carries over automatically. If signup creates a *new* user instead of linking, the guest's data is orphaned. Please confirm the client links rather than re-creates; if not, that's the bug to fix (client-side preferred — a server migration endpoint is messy).

**Q7 — Security rules.** Not in this repo, and the backend can't see them: the API uses the Admin SDK exclusively, which **bypasses rules entirely**. So RTDB rules (incl. `/status/*` presence) and Storage rules live only in the Firebase console — Nick needs to audit there. Required posture given the public web config: RTDB — deny all client reads/writes except `/status/$uid` write/read for authenticated users (`auth.uid === $uid` for writes); everything under `lists/`, `groups/`, `users/`, `scheduledNotifications/`, `itemCategoryCache/` should be server-only. Storage — authenticated writes restricted to the user's own profile path and recipe-image paths they own; public read is fine for recipe/profile images. Happy to review the actual JSON if Nick pastes it.

**Q8 — Group member removal.** Yes, implemented: `PUT /api/group/:id` with `{name?, members?: string[]}`; `members` **replaces** the whole membership map (so omit the removed uid; always include the owner — the server doesn't currently guard against removing the owner). Owner-only (`groupOwnerAuth`). `DELETE /api/group/:id` also exists (owner-only). Not a placeholder.

**Q9 — Rate limits.** None server-side; your 500 ms debounce is fine. Saves are now full-doc RTDB transactions, so cost per save is one read + one conditional write; no quota concerns at current scale.

## 5. Backend changes in this branch (summary for Nick)

Fixes shipped: §3.1–§3.4 above, plus bugs found in review — categorize silent item loss; `POST /meal` 500 on quantity-less ingredients / `LexoRank.parse` crash on bad ranks / missing `mealOrder`; `schedule-rating` 500 on every call + duplicate jobs; `POST /recipe` unauthorized overwrite + ignored client id; **WS subscriptions had no group-membership check** (cross-group list snooping); new-list items written with legacy `order` key instead of `listOrder`; cookbook broken for >30 recipes (Firestore `in` limit). Tests added for the new rank/quantity utils (`bun test`, 13 passing).

**Action needed (Nick):**
1. Run the rank migration against prod once deployed: `DRY_RUN=1 bun scripts/migrateRanks.ts`, review output, re-run without `DRY_RUN`.
2. Audit RTDB/Storage rules (Q7) — highest-leverage security item now that the WS hole is closed.
3. Confirm prod TLS/WSS at `api.fridgie.ca` (§3.5).
4. Check the Firestore composite index for notifications (Q5).

**Open backend follow-ups (not in this branch):** Expo push delivery worker (send + mark `scheduledNotifications` jobs, push on follow/invite); `weekStart` storage migration to plain `yyyy-MM-dd` (coordinated, §3); WS first-message auth (coordinated, Q2); item-level patch ops (long-term, §2.2); user search is capped at the first 1000 auth records (pre-existing TODO).
