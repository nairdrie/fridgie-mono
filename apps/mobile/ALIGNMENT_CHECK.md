# Frontend ↔ Backend Alignment Check — Agent Brief

*For an agent with access to BOTH repos. Goal: verify the assumptions the frontend now makes (after the fixes on branch `claude/grocery-meal-prep-review-gzac06`) against actual backend behavior, and either fix the backend or report the mismatch. `BACKEND_HANDOFF.md` in this repo has full context; this is the ordered checklist.*

Work top to bottom — items 1–4 can corrupt or lose user data if misaligned; the rest are functional/config.

---

## 1. `Item` field round-trip (data-loss risk)

The frontend added `overrideBase?: string` to `Item` and relies on `overrideQuantity`, `mealOrder`, `quantity`, and `mealId` surviving every server round-trip. Overrides silently stop working (stale-detection always fires) if `overrideBase` is stripped.

**Check in backend:** every code path that reads and re-emits list items — the list save/load, **`POST /list/categorize/:id`** (highest risk: if it rebuilds items field-by-field or passes them through an LLM prompt, unknown fields die), and **`POST /meal`** (add recipe to list). Items must be treated as open objects: unknown keys copied through.

**Frontend anchors:** `types/types.ts` (Item), `components/GroceryListView.tsx` `handleSaveQuantity` (writes `overrideBase`), aggregation in the same file (reads it).

## 2. LexoRank integrity (crash risk)

Frontend no longer produces `'NEEDS-RANK'` and repairs invalid ranks on read (`utils/rank.ts`), but stored lists may still contain them, and other/old clients could reintroduce them.

**Check in backend:** scan the lists collection for items whose `listOrder` fails LexoRank parsing (including missing `mealOrder` on items with `mealId`); write a migration to re-rank them; add write-time validation. Also verify the categorize endpoint returns valid ranks for every item including sections.

## 3. WebSocket protocol (sync correctness)

Frontend behavior now: ignores its own state changes for saving, reconnects with backoff + fresh Firebase ID token, expects each WS message to be a full `List` JSON (`{items, meals, sort, ...}`).

**Check in backend:**
- Does the server echo a broadcast back to the **sender** of a `POST /list/:id`? Frontend tolerates it via a 1.2 s dirty-window heuristic only. Recommended: accept a `clientId` on save and exclude (or tag) the sender in broadcasts.
- Does **`POST /meal`** trigger a WS broadcast on the affected list? Frontend relies on this for "add to plan from Explore" appearing live (known bug if missing).
- Is there any document versioning (`rev`)? If not, concurrent editors clobber each other (whole-doc last-write-wins) — this is the one sync gap left open on the frontend, waiting on a backend design (409-on-stale-rev preferred). See `BACKEND_HANDOFF.md` §3.3.
- Reconnects: same URL/token query-param auth must work repeatedly; check whether tokens in query strings land in server/proxy logs.

**Frontend anchors:** `app/(tabs)/list.tsx` (listener + save effects, `applyingRemoteRef`/`hasLoadedRef`), `utils/api.ts` `listenToList`.

## 4. `weekStart` format (off-by-a-day risk)

Frontend now parses `weekStart.slice(0, 10)` as **local** `yyyy-MM-dd` everywhere (`utils/date.ts` `parseWeekStart`) and assumes Sunday-start weeks.

**Check in backend:** what exactly is stored in `weekStart` (bare date key vs ISO datetime, and in which timezone it was computed), and what `createList` does with the `weekStart` the client sends. If the server stores UTC datetimes computed in a non-local zone, week labels and the past-meal rating prompt can still shift a day. Align on: server stores/accepts bare `yyyy-MM-dd`, Sunday-start.

## 5. Quantity string formats from AI endpoints

Frontend parser (`utils/quantity.ts`) handles decimals, `1/2`, `1 1/2`, unicode `½…`, and units `g kg oz lb ml l tsp tbsp cup` (+aliases). Everything else becomes a non-convertible literal.

**Check in backend:** sample real outputs of the **recipe importer** (`POST /recipe/import`) and **`POST /meal/suggest`** — look for ranges ("2-3"), "to taste", compound units ("fl oz"), non-English. Ideally normalize at the source to `"<decimal> <canonical-unit>"`; otherwise report the observed formats so the frontend parser can be extended.

## 6. Endpoint path & contract checks (fast greps)

| Frontend call (`utils/api.ts`) | Verify in backend |
|---|---|
| `POST /notifications/save-push-token` | Route exists? Other notification routes are `/notification/*` (singular) — one of the two is wrong. Is the Expo push pipeline actually sending? |
| `POST /notifications/schedule-rating` | Same singular/plural question; idempotent per (mealId, listId)? Frontend calls it on **every** day-of-week change. |
| `POST /recipe` (`saveRecipe`) | Called by rate-meal photo upload for recipes the user may not own. Fork, in-place edit, or 403? If 403, frontend must gate the photo button. |
| `POST /list/:id` (`updateList`) | Accepts and persists `sort`? Who maintains `hasContent` (client never writes it)? Any rate limits the 500 ms debounce could trip? |
| `PUT /group/:id` | Client comment says member-removal is a "placeholder" — implemented or dead? |
| `GET /user/:uid`, `GET /user?q=` | Frontend types these as Firebase `User` — almost certainly wrong; confirm actual response shape and fix the frontend types. |

## 7. Environment & auth

- Frontend `BASE_URL` = `EXPO_PUBLIC_API_URL` or default `https://api.fridgie.ca/api`. Confirm prod is deployed, serves WSS (client derives `ws(s)://` from it), and CORS/upgrade headers are right.
- `authorizedFetch` force-refreshes the Firebase ID token on **every request** (`getIdToken(user, true)`) — check backend/Firebase quota tolerance; a cached-token approach may be warranted.
- Anonymous → registered: when a guest signs up, are their groups/lists/cookbook migrated to the new uid or orphaned?
- Firebase web config is public (by design) → audit RTDB rules for `/status/*` (presence writes after signOut currently fail — is that intended?) and Storage rules for `profile_images/*`, `recipe_images/*`.

## 8. Report back

Produce a short report: per item above — **aligned / fixed in backend / needs frontend change** (with the specific mismatch). Anything requiring a frontend change should reference the frontend anchor listed so the next agent can jump straight there.
