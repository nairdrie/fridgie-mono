# Fridgie — Full App Review & Backend Handoff

*Reviewed: frontend repo (`nairdrie/fridgie`) as of branch `claude/grocery-meal-prep-review-gzac06`, 2026-06-11.*
*Audience: backend agent (API repo owner). Sections 5–6 are the actionable handoff; sections 1–4 are context and the frontend bug inventory so we agree on the contract.*

---

## 1. Feature inventory (what the app does today)

| Area | Features |
|---|---|
| Auth | Email/password, Google, Apple sign-in; anonymous guest fallback; complete-profile flow |
| Grocery list | Weekly lists per group; add/edit/check/drag-reorder items; sections; sort modes (custom / alphabetical one-shot / AI categorize); quantity chips with editor + unit cycling |
| Meal plan | Meal cards per week; day-of-week assignment; ingredients per meal (drag-sortable); collapse state persisted locally; meal ingredients flow into the grocery list and aggregate by name |
| Recipes | Manual create/edit with photo; URL/TikTok import; view modal; add to meal plan (any upcoming week); personal cookbook (add/remove) |
| AI | Meal suggestions from saved preferences, with re-roll + veto list; list auto-categorization |
| Ratings | Post-meal rating screen (like/dislike + feedback), scheduled via backend, local "already rated" tracking |
| Social | User search (Algolia), follow/unfollow, public profiles with cookbooks, explore feed (trending recipes, featured creators), notifications (group invites, follows) |
| Groups | Create/rename/delete groups, invitations (accept/decline), shared lists, realtime presence (RTDB) |
| Sync | WebSocket live updates per list; debounced full-document saves |

Overall design impression: the product surface is genuinely complete and coherent — weekly list + meal plan + recipes + social is a full loop. The polish gaps are concentrated in (a) the quantity model, (b) the sync protocol, and (c) release hygiene (env config, push notifications). Those three are what stand between "works in my kitchen" and "feels complete."

---

## 2. How list/meal quantity sync works today (shared contract)

- A `List` document holds **one flat `items[]` array plus `meals[]`**. Meal ingredients are just items with a `mealId`; there is no separate ingredients collection.
- `Item = { id, text, checked, listOrder (LexoRank), mealOrder?, isSection, mealId?, quantity?: string, overrideQuantity?: string }`. Quantities are **freeform strings** ("200 g", "2 cups").
- The grocery view aggregates items by `text.trim().toLowerCase()`. Display total = sum of parsed `quantity` values grouped by unit string, joined with `+` (e.g. `"200 g + 2 tsp"`). If any source item has `overrideQuantity`, that wins verbatim.
- Saves are **debounced whole-document POSTs** of `{ items, meals, sort }` to `POST /list/:id`. Incoming WS broadcasts replace local state unless a local edit happened in the last 1200 ms ("dirty window").

Keep this model in mind for everything below.

---

## 3. Quantity sync & conversion — bug list (the area Nick flagged)

These are mostly frontend bugs, listed so we can decide which belong in a shared/backend quantity model instead of being patched in three places.

| # | Severity | Bug | Where |
|---|---|---|---|
| Q1 | High | **No unit conversion in aggregation.** "200 g" in list + "2 tsp" in a meal renders `"200 g + 2 tsp"` (the known TODO). The `CONVERSIONS` table exists only inside `QuantityEditorModal` and is never used by aggregation. | `components/GroceryListView.tsx:3,91-102`, `components/QuantityEditorModal.tsx:10-17` |
| Q2 | High | **Fractions are mis-parsed, not just unsupported.** `parseQuantityAndText("1 1/2 cups flour")` → quantity `"1"`, text `"1/2 cups flour"` (item text is corrupted on blur). Aggregating two `"1/2 cup"` quantities yields `"2 /2 cup"` (`parseNumericQuantity` reads value `1`, unit `"/2 cup"`). Unicode `½` (common in imported recipes) isn't handled at all. | `components/QuantityEditorModal.tsx:49-84`, `components/GroceryListView.tsx:28-33` |
| Q3 | High | **Open-editor-then-Save corrupts multi-unit totals.** Opening the quantity editor on an aggregated total like `"200 g + 2 tsp"` and pressing Save without edits parses it as value `200`, unit `"g + 2 tsp"`, detects a "unit conflict", and freezes the whole string as `overrideQuantity`. From then on the total never updates when meal ingredients change. | `components/GroceryListView.tsx:223-257` |
| Q4 | High | **`overrideQuantity` is never invalidated.** Once set, it wins over computed totals forever — meal ingredient edits, additions, and deletions no longer affect the displayed grocery quantity, with no UI hint and no way to clear it except editing to a non-conflicting value. | `components/GroceryListView.tsx:86-90` |
| Q5 | Med | **Editing a total below the meal contribution silently fails.** Meals contribute 3 cups; user edits the grocery total to "2 cups" → the standalone list item is deleted and the display snaps back to "3 cups". No warning, no override. | `components/GroceryListView.tsx:273-275` |
| Q6 | Med | **Singular/plural and synonym units don't merge.** `"1 cup" + "2 cups"` → `"1 cup + 2 cups"`. The variations regexes that could normalize this aren't used in aggregation. | `components/GroceryListView.tsx:93-97` |
| Q7 | Med | **Unit-matching regexes have alternation-precedence bugs.** `/^cups?|c$/i` matches any word *ending* in "c" (e.g. "metric"); `/^oz|ounces?$/i` matches "ozzy"/"flounces"; same pattern for ml/tbsp. Should be `/^(cups?|c)$/i` etc. | `components/QuantityEditorModal.tsx:12-16` |
| Q8 | Med | **Unit cycling converts mass↔volume with implicit density 1 g/ml.** 100 g → 3.5 oz → 100 ml → 0.42 cups. Fine for water, wrong for flour/sugar. Also `tsp`, `kg`, `lb` are missing entirely (tsp is literally the unit in the headline TODO). | `components/QuantityEditorModal.tsx:10-17,115-135` |
| Q9 | Med | **Renaming an aggregated grocery row splits it mid-keystroke and can rename a meal ingredient.** The text input writes only to `sources[0]` (first occurrence in array order — which can be a *meal* item). First keystroke changes the aggregation key, the row splits in two while typing, and if the base was a meal item you've renamed an ingredient inside a recipe's meal card from the grocery tab. | `components/GroceryListView.tsx:123-126,380-386` |
| Q10 | Design question | **Deleting an aggregated grocery row deletes the meal ingredients too** (all `sourceIds`). Is that intended? Most apps keep recipe ingredients intact and only remove the shopping entry. Same question for check-toggling (checking the grocery row checks the ingredient inside the meal card — that one feels right). | `components/GroceryListView.tsx:154-156` |

**Recommendation (see §5.1):** stop parsing freeform strings in three different places. Move to a canonical `{ value: number, unit: string|null, raw: string }` quantity produced once (at input/import time), and put the single parser + conversion table in a shared module. Backend involvement needed because the recipe importer and suggestion endpoint are the main producers of quantity strings.

---

## 4. Other frontend bugs found (for completeness / triage)

### Sync & data integrity
| # | Severity | Bug | Where |
|---|---|---|---|
| S1 | **Critical** | **`NEEDS-RANK` listOrder is persisted and crashes LexoRank.** `AddEditRecipeModal.handleSaveRecipe` creates ingredient items with `listOrder: 'NEEDS-RANK'` and `handleRecipeSaved` in `list.tsx` **never re-ranks them** (unlike the suggestions path, which does). They sort to the bottom by accident, get saved to the server verbatim, and `LexoRank.parse('NEEDS-RANK')` throws the next time anyone presses Enter on/after such an item or adds an item (`addItemAfter`, `handleAddItem`, `handleAddIngredient`, `handleAddMealsFromSuggestion` all parse existing ranks). | `components/AddEditRecipeModal.tsx:149`, `app/(tabs)/list.tsx:233-250` |
| S2 | **Critical** | **WS echo → save loop / write amplification.** The debounced-save effect fires on *any* `items/meals/sort` state change, including state set by the WS listener. Every received broadcast triggers a `POST /list` 500 ms later, which the server presumably re-broadcasts. With 2 clients open this ping-pongs writes; it also re-saves on initial load. Bonus: when a list is empty the listener injects a phantom blank item (`list.tsx:140`) which then gets persisted to the server. Needs a "skip save when change came from the server" guard client-side **and** sender-echo suppression server-side (§5.2). | `app/(tabs)/list.tsx:121-161` |
| S3 | High | **Whole-document last-write-wins.** Two group members editing concurrently clobber each other's items — the entire `items[]`+`meals[]` is overwritten by whichever debounce fires last. The 1200 ms dirty window only protects against *displaying* stale data, not against overwriting. | `app/(tabs)/list.tsx:155-161`, `utils/api.ts:101-115` |
| S4 | Med | **WS has no reconnect.** One dropped socket = no live updates until the screen remounts. `onclose` is an empty handler. Token is also passed in the query string (gets into server/proxy logs). | `utils/api.ts:389-434` |
| S5 | Med | **Categorize round-trip races the editor.** `handleAutoCategorize` sends current items and replaces state with the response; anything typed during the request is lost. Also no loading indicator (existing TODO). | `app/(tabs)/list.tsx:341-359` |

### Release blockers / config
| # | Severity | Bug | Where |
|---|---|---|---|
| R1 | **Critical** | `BASE_URL` is a hardcoded LAN IP (`http://192.168.2.193:3000/api`), with AWS/prod URLs commented out. Needs env-driven config (`app.config.ts` + `EXPO_PUBLIC_API_URL` or expo-updates channels). | `utils/api.ts:17-19` |
| R2 | High | **Push registration is dead code:** `Constants.isDevice` no longer exists in Expo SDK 53 (`expo-device`'s `Device.isDevice` is the replacement), so the function always logs "Must use physical device" and returns before getting a token. Also calls `/notifications/save-push-token` while other notification routes are `/notification/...` — confirm which the backend actually exposes (§6). | `utils/api.ts:236-289` |
| R3 | Med | `eas.json` production Android build is `apk`, not `aab` (Play Store requires aab). | `eas.json` |
| R4 | Low | Firebase web config committed — that's fine by design (these keys are not secrets), but it means **RTDB/Storage security rules are the only protection**. Worth a rules audit (§6). | `utils/firebase.ts:12-21` |

### Dates / timezones
| # | Severity | Bug | Where |
|---|---|---|---|
| D1 | Med | `weekStart` strings are parsed with `new Date(string)`. If the backend stores `yyyy-MM-dd`, that parses as **UTC midnight**, which is the previous day in all of the Americas — while `weekKeyFromDate` formats in *local* time. Week labels, the "past unrated meals" math (`list.tsx:447-463`), and `AddToMealPlanModal`'s week filtering can all be off by a day depending on timezone. Need one canonical rule (suggest: backend stores `yyyy-MM-dd` week keys, frontend parses with `dateFromWeekKey` everywhere — it already exists in `utils/date.ts:40` but is unused in these spots). | `utils/date.ts`, `app/(tabs)/list.tsx:449`, `components/AddToMealPlanModal.tsx:57-67` |
| D2 | Low | `AddToMealPlanModal` re-implements week-start math by hand instead of using `date-fns`/`utils/date.ts`. | `components/AddToMealPlanModal.tsx:59-63` |

### UX bugs (known/confirmed)
| # | Severity | Bug | Where |
|---|---|---|---|
| U1 | Med | Ingredient ✕ delete button doesn't work reliably (the existing TODO): tapping it blurs the input first, `onBlur` clears `editingId`, the button unmounts before its `onPress` fires. Classic fix: keep the button mounted and use `onPressIn`, or delay the blur-clear. | `components/MealCard.tsx:14,234-238` |
| U2 | Med | Adding a recipe to a meal plan from Explore doesn't show up until refetch (existing TODO) — `addRecipeToList` succeeds server-side but no local state/WS-driven update reaches the list screen if it's mounted on that week. | `app/(tabs)/explore.tsx:14`, `components/AddToMealPlanModal.tsx:69-85` |
| U3 | Med | Rate-meal photo "upload" is preview-only; the picked image is never uploaded (comment in code admits it). Edit-recipe button there is also a stub Alert. | `app/rate-meal.tsx:157-195` |
| U4 | Med | RTDB presence: `onDisconnect` registration isn't awaited before setting `online: true`, and logout cleanup doesn't await the offline write — matches the known "issues around logging out" TODO; users can get stuck "online". | `context/AuthContext.tsx:135-172` |
| U5 | Low | `toE164` hardcodes country code `1` (NANP-only). | `utils/utils.ts:1-9` |
| U6 | Low | Meal-name `placeholder` is randomized per render-mount of each card, so placeholders shuffle when cards remount. | `components/MealCard.tsx:81-83` |
| U7 | Low | Keyboard-avoidance TODOs on the list screen (iOS dismiss-on-scroll, Android keep-open) are acknowledged and still open. | `app/(tabs)/list.tsx:554-556` |
| U8 | Low | `useAnimatedStyle` called inside `secondaryFabStyle(index)` factory within render — works today but violates hooks rules; will break if FAB count becomes dynamic. | `app/(tabs)/list.tsx:108-117` |

---

## 5. Backend work requested (implementation gaps)

### 5.1 Canonical quantity model (highest priority — unblocks all of §3)
The frontend currently parses freeform quantity strings in 3 places with 2 different regex sets. Proposal — please review and confirm:
- Extend `Item`/`Ingredient` with structured quantity: `{ value: number | null, unit: string | null, raw: string }`. Keep `raw` for display fallback ("to taste", "a pinch", "2–3").
- **Recipe importer and meal-suggestion endpoints normalize quantities at the source**: convert fractions (`1/2`, `1 1/2`, `½`), normalize unit names to a fixed enum (`g, kg, oz, lb, ml, l, tsp, tbsp, cup, count`), and tag dimension (mass/volume/count) so the client never converts across dimensions.
- Backend `categorize` endpoint must round-trip the new fields untouched.
- Frontend will then do display aggregation + conversion from one shared table (I'll handle that side).
If you'd rather keep quantities as plain strings server-side, say so and I'll centralize parsing client-side instead — but importer output normalization is needed either way (see Q-IMP question below).

### 5.2 Sync protocol hardening
1. **Sender-echo suppression**: accept a `clientId` (or `rev`) on `POST /list/:id` and include it in WS broadcasts so clients can ignore their own echoes. This plus a client guard kills the S2 write loop.
2. **Versioning for conflict safety**: add a monotonically increasing `rev` to the list document; reject (or merge) stale writes instead of silent LWW (S3). Even a simple 409-on-stale-rev would let the client rebase.
3. Longer term: consider item-level patch ops (`add/update/remove/reorder`) instead of whole-document POSTs. Not urgent if 1+2 land.
4. WS: confirm the server tolerates reconnect with the same token, and consider moving the token from query string to first-message auth.

### 5.3 `NEEDS-RANK` defense
I'll fix the client (S1), but please add server-side validation that rejects/repairs items whose `listOrder` is not a parseable LexoRank — existing lists in the DB may already contain `'NEEDS-RANK'` rows. A one-off migration to re-rank any such items would clean up live data.

### 5.4 Smaller items
- **Push notifications**: confirm the save-push-token route path (`/notifications/save-push-token` vs `/notification/...`) and that the Expo push pipeline is live; I'll fix the client-side `Constants.isDevice` bug.
- **`scheduleMealRating` dedupe**: the client calls it every time a meal's day changes — please make it idempotent per (mealId, listId).
- **`addRecipeToList` (POST /meal)**: confirm the server assigns valid `listOrder`/`mealOrder` to the items it creates (the in-app path creates items client-side; the explore path is server-side — they should produce identical item shapes).
- **`hasContent`** on lists: confirm who maintains it (client never sets it).
- **Week-start canonicalization** (D1): confirm the exact format of `weekStart` as stored (`yyyy-MM-dd` local? ISO datetime? UTC?) and that it's Sunday-based, so I can fix client parsing consistently.

---

## 6. Questions for the backend agent (please generate a report back)

1. **List schema & categorize**: exact response shape of `POST /list/categorize/:id` — does it preserve `mealId`, `quantity`, `overrideQuantity`, `mealOrder` on every item, and does it generate fresh valid LexoRanks for all items including sections?
2. **WS protocol**: message shape, whether the sender receives their own broadcast, reconnect/auth semantics, and any server-side debounce.
3. **Recipe importer output**: 10–20 real sample `ingredients[].quantity` strings from recent imports (do we see `½`, ranges, "to taste"?), so the normalization spec in §5.1 matches reality.
4. **Meal suggestions contract**: response shape of `POST /meal/suggest` — are ingredient quantities normalized? Are `tags`/`photoURL` populated?
5. **Notification routes**: definitive list (`/notification` vs `/notifications/...`), and whether follow/invite push notifications are implemented server-side.
6. **Anonymous → registered migration**: when a guest signs up, are their group/lists/cookbook migrated to the new uid, or orphaned?
7. **Security rules**: current Firebase RTDB rules (presence paths) and Storage rules (profile/recipe images) — since the web config is public, rules are the entire security boundary.
8. **Prod environment**: is `https://api.fridgie.ca` live and is WSS terminated correctly (the client derives `ws(s)://` from the API URL)?
9. **Group invitation flow**: behavior of `PUT /group/:id` `members` updates (the client comment says "placeholder") — is member removal actually implemented?
10. **Rate limits / debounce expectations**: any server-side constraints on `POST /list/:id` frequency we should respect when fixing S2?

---

## 7. Suggested fix order

1. S1 (`NEEDS-RANK`) + S2 (echo loop) — data corruption and write storms; both small, high impact.
2. §5.1 quantity model + Q1–Q8 — the "feels complete" win Nick asked about.
3. R1/R2 (env config, push token) — release blockers.
4. S3/S4 (LWW + reconnect), D1 (week parsing), U1–U4.
5. Cosmetics and remaining TODOs.
