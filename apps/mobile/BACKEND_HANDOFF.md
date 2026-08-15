# Fridgie — Full App Review & Backend Handoff

*Frontend repo (`nairdrie/fridgie`), branch `claude/grocery-meal-prep-review-gzac06`, updated 2026-06-11.*
*Audience: backend agent (API repo owner).*

**Status update:** every frontend-fixable finding from the original review has now been **fixed on this branch** (commits after the initial report). Section 2 describes what changed and the new client behavior you must account for. Section 3 is your required work — three of the client fixes are only half of a contract and need backend counterparts. Section 4 is the question list to answer in a report back. Section 5 lists what remains open and why. The original full bug inventory is preserved in Section 6 for reference, with resolution status per item.

---

## 1. App summary (context)

| Area | Features |
|---|---|
| Auth | Email/password, Google, Apple; anonymous guest fallback; complete-profile flow |
| Grocery list | Weekly lists per group; add/edit/check/drag items; sections; sort (custom / alphabetical / AI categorize); quantity chips with editor + unit conversion |
| Meal plan | Meal cards per week, day-of-week assignment, per-meal ingredients that flow into the grocery list and aggregate by name |
| Recipes | Manual create/edit with photo; URL/TikTok import; cookbook; add-to-plan from Explore |
| AI | Meal suggestions (preferences + veto/re-roll); list auto-categorization |
| Social | Search (Algolia), follow, public profiles, explore feed, notifications, post-meal ratings |
| Groups | Create/invite/manage, shared lists, RTDB presence |
| Sync | WebSocket live updates per list; debounced whole-document saves |

Data model reminder: a `List` doc holds one flat `items[]` plus `meals[]`. Meal ingredients are items with `mealId`. The grocery view aggregates items by `text.trim().toLowerCase()`. Quantities are freeform strings. Saves are debounced `POST /list/:id` with the full `{ items, meals, sort }`.

---

## 2. What was fixed on this branch (frontend)

### 2.1 New shared quantity engine — `utils/quantity.ts`
All quantity parsing/conversion/aggregation now lives in one module (previously three divergent regex sets). It handles:
- **Fractions**: `1/2`, `1 1/2`, and unicode `½ ¼ ¾ ⅓ ⅔ ⅛ …` — `"1 1/2 cups flour"` now parses as qty `1.5 cups` + text `flour` (previously it corrupted the item to text `"1/2 cups flour"`, qty `"1"`).
- **Unit normalization**: `cup/cups/c`, `tbsp/tablespoons`, `g/grams`, etc. map to canonical units `g, kg, oz, lb, ml, l, tsp, tbsp, cup` with anchored regexes (the old `/^cups?|c$/` matched any word ending in "c").
- **Dimension-aware conversion**: mass and volume each convert within their dimension; cross-dimension conversion is refused (no more implicit 1 g = 1 ml). `tsp`, `kg`, `lb`, `l` added.
- **Aggregation** (`aggregateQuantities`): same-dimension quantities convert into the unit of the first item and sum — `"1 cup" + "2 tbsp"` → `"1.13 cups"`, `"1 cup" + "2 cups"` → `"3 cups"`, `"1/2 cup" × 2` → `"1 cup"`. Different dimensions stay separate (`"200 g + 2 tsp"` — correct, since sugar by weight and by spoon genuinely can't merge without density). Unknown units group by token with naive plural merging (`"2 bunches" + "1 bunch"` → `"3 bunches"`). Unparseable strings ("to taste") are ignored in totals.
- **Smarter text splitting**: `"2 chicken breasts"` → qty `2`, text `chicken breasts` (the old parser produced qty `"2chicken"`).

The unit-cycle button in the quantity editor now cycles only within the current dimension.

### 2.2 Override semantics fixed — **new `Item.overrideBase` field** ⚠️ *backend action needed (§3.1)*
- Opening the editor on a computed total and saving without changes is now a no-op (previously it froze e.g. `"200 g + 2 tsp"` into a permanent `overrideQuantity`).
- When an override IS set, the client also stores `overrideBase`: the aggregated total of the other source items at that moment. At display time the total is recomputed; **if it no longer matches `overrideBase`, the override is considered stale and ignored**, so meal-plan quantity edits flow through again instead of being masked forever.
- Setting a total *below* the meal contribution now stores it as an explicit override (previously the input was silently discarded and the display snapped back).

### 2.3 Sync hardening — `app/(tabs)/list.tsx`, `utils/api.ts`
- **Echo loop killed (client side)**: state changes that came from the server (WS snapshots) no longer trigger the debounced save. Previously *every* broadcast caused a `POST /list` 500 ms later — with two clients open this ping-ponged writes indefinitely.
- **Initial-load guard**: no saves are sent until the first server snapshot for the selected list has been applied. Previously the save effect could fire on mount and **overwrite the list with the initial empty state** if the WS snapshot took >500 ms.
- **`NEEDS-RANK` eliminated**: recipe-save now assigns real LexoRanks (list *and* meal order) to new ingredient items — this path previously persisted the literal string `'NEEDS-RANK'` and crashed `LexoRank.parse` on the next insert. All other rank parsing now goes through `utils/rank.ts` (`safeParseRank` / `nextListRank` / `sanitizeListOrders`), and incoming snapshots + categorize responses are sanitized, so existing bad rows in the DB are repaired on read.
- **WS reconnect**: dropped sockets now reconnect with exponential backoff (1s → 30s cap) and a fresh ID token per attempt. Previously one drop meant no live updates until remount.
- **No socket churn from presence**: the listener and save effects now depend on `groupId`/`listId` strings instead of object identities; presence updates were re-creating the group object and tearing down/reopening the socket on every member status change.

### 2.4 Other fixes
| Area | Fix |
|---|---|
| Dates/TZ | All `weekStart` parsing goes through new `parseWeekStart()` (local-time `yyyy-MM-dd`); previously `new Date(string)` parsed UTC midnight = previous day across the Americas. Applied in list screen (unrated-meal check), `ListHeader`, `AddToMealPlanModal` (also de-duplicated its hand-rolled week math), `ListContext`, `getWeekLabel`, `getAvailableWeeks`. |
| Config | `BASE_URL` now reads `EXPO_PUBLIC_API_URL`, **defaulting to `https://api.fridgie.ca/api`** (was a hardcoded LAN IP). `eas.json` production Android build switched `apk` → `app-bundle`. |
| Push | `registerForPushNotificationsAsync` no longer dead code — `Constants.isDevice` (removed in SDK 53) check dropped, token request passes the EAS `projectId` and fails gracefully on simulators. |
| UX | Ingredient/item ✕ delete buttons now use `onPressIn` (the input's `onBlur` unmounted them before `onPress` could fire — the long-standing "delete button broken" TODO). Renaming an aggregated grocery row renames **all** source items, so the row no longer splits mid-keystroke. Categorize shows a "Sorting…" spinner and disables the sort button. Meal-name placeholders are deterministic per meal id (no more reshuffling). Rate-meal photo pick now actually uploads + persists via `saveRecipe` (was preview-only with a "in a real app…" comment). Meal-preferences save now surfaces errors instead of silently failing. FAB animation styles no longer call hooks via a factory. |
| Presence | Cleanup now runs in safe order (unsubscribe → cancel `onDisconnect` → write offline, errors swallowed). Partial fix; see §5. |
| Type errors | Fixed two pre-existing `tsc` failures (`bowl-outline` icon name, `setInterval` typing). `npx tsc --noEmit` is now clean. |

**Design decision (was Q10):** checking/unchecking and deleting an aggregated grocery row intentionally act on **all** source items, including meal ingredients. Kept and documented in code — flag if you disagree.

---

## 3. Backend work required to sync up

### 3.1 Preserve `overrideBase` (and unknown `Item` fields generally) — **required, or quantity overrides regress**
The client now writes `overrideBase?: string` on items alongside `overrideQuantity`. Anything server-side that reads and re-emits items must round-trip it:
- the list document store itself (presumably fine if items are opaque JSON),
- **`POST /list/categorize/:id`** — if it reconstructs items field-by-field it will strip `overrideBase` (and possibly `overrideQuantity`/`mealOrder`); please make it pass through unknown fields,
- **`POST /meal`** (add recipe to list) item creation,
- any other code path that maps/validates items.
Treat `Item` as open/extensible: copy unknown keys through.

### 3.2 `NEEDS-RANK` cleanup — one-off migration + validation
The client no longer produces it and repairs it on read, but stored lists may still contain items with `listOrder: 'NEEDS-RANK'` (or missing `mealOrder` on meal items). Please:
1. Run a migration re-ranking any item whose `listOrder` doesn't parse as a LexoRank.
2. Add write-time validation rejecting/repairing unparseable `listOrder` so no other client can reintroduce it.

### 3.3 Sender-echo suppression + revisioning — the remaining sync gap
The client no longer *echoes* saves, but the underlying protocol is still whole-document last-write-wins; two members editing concurrently still clobber each other (original finding S3, **still open**):
1. Accept a `clientId` (or echo a `rev`) on `POST /list/:id` and include it in WS broadcasts so clients can hard-ignore their own echoes (the client currently uses a 1.2 s dirty-window heuristic).
2. Add a monotonically increasing `rev` to the list doc; reject stale writes with 409 so the client can rebase, or merge server-side.
3. (Longer term) item-level patch ops instead of full-document POSTs.
Tell me the shape you choose and I'll wire the client.

### 3.4 Quantity normalization at the source — recommended
The client parser is now tolerant (fractions, unicode, plurals), but the **recipe importer** and **meal-suggest** endpoints should still emit canonical `"<decimal> <unit>"` strings (unit ∈ `g, kg, oz, lb, ml, l, tsp, tbsp, cup`, or unitless) so totals are exact and the freeform fallback path is rarely hit. Send me 10–20 real sample quantity strings from recent imports (see §4 Q3) and I'll confirm coverage either way.

### 3.5 Confirmations needed for fixes already shipped
- **`weekStart` format**: client now parses the first 10 chars as local `yyyy-MM-dd`. Confirm that's what you store (and that weeks are Sunday-based). If you store a UTC datetime computed from a different timezone, week labels can still be off — say so and I'll adjust.
- **Push token route**: client POSTs to `/notifications/save-push-token`, but other notification routes are `/notification/...` (singular). Confirm the real path and that the Expo push pipeline is live.
- **`saveRecipe` by non-author**: rate-meal now persists a picked photo via `POST /recipe`. What happens when the rater isn't the recipe author — fork, in-place update, or 403? If 403, I'll gate the photo button to authors.
- **WS broadcast on `POST /meal`**: adding a recipe from Explore relies on the server broadcasting the list change over the websocket; the old "doesn't show up right away" bug suggests it doesn't. Please confirm/add.
- **Env URLs**: client now defaults to `https://api.fridgie.ca/api` and reads `EXPO_PUBLIC_API_URL` otherwise. Confirm prod is live with WSS (client derives `ws(s)://` from the API URL). Nick: for local dev, add `.env` with `EXPO_PUBLIC_API_URL=http://<lan-ip>:3000/api`.
- **`scheduleMealRating`**: client calls it on every day-of-week change; please make it idempotent per (mealId, listId).
- **`hasContent`**: confirm the server maintains this flag (client never writes it).

---

## 4. Questions — please generate a report back

1. **Categorize contract**: exact response of `POST /list/categorize/:id` — does it preserve `mealId`, `quantity`, `overrideQuantity`, `overrideBase`, `mealOrder` and produce valid LexoRanks for all items including sections?
2. **WS protocol**: message shape, does the sender receive its own broadcast, any server-side debounce, reconnect/auth semantics (client now reconnects with a fresh token — is a token in the query string logged anywhere? consider first-message auth).
3. **Importer output**: 10–20 real `ingredients[].quantity` samples from recent imports (fractions? `½`? ranges like "2-3"? "to taste"?).
4. **Suggest contract**: response shape of `POST /meal/suggest` — quantities normalized? `tags`/`photoURL` populated?
5. **Notification routes**: definitive list (`/notification` vs `/notifications/...`); are follow/invite pushes implemented?
6. **Anonymous → registered migration**: are a guest's groups/lists/cookbook migrated on signup or orphaned?
7. **Security rules**: current Firebase RTDB rules (`/status/*` presence paths) and Storage rules (profile/recipe images) — the web config is public by design, so rules are the entire boundary.
8. **Group member removal**: is `PUT /group/:id` with `members` actually implemented? (Client comment says "placeholder".)
9. **Rate limits**: any constraints on `POST /list/:id` frequency the client's 500 ms debounce should respect?

---

## 5. Known remaining items (frontend, deliberately not done)

| Item | Why |
|---|---|
| LWW conflict clobbering | Needs §3.3 backend protocol first; client will follow. |
| Presence stuck-online after logout | Mitigated (ordered cleanup), but a complete fix needs the offline write awaited *before* `signOut()` in the logout flow, and RTDB rules that allow it — pending §4 Q7. |
| Explore → meal plan not instant | Pending §3.5 WS-broadcast confirmation. |
| `toE164` hardcodes +1 | Product decision (country picker) — out of scope for a bug pass. |
| iOS/Android keyboard dismissal polish (TODOs in list.tsx) | Needs on-device testing; behavior-tuning, not a bug. |
| Rate-meal "edit recipe" stub | Feature work (navigating into the edit modal from rate-meal), not a bug; left as-is. |
| Cosmetic lint (unescaped apostrophes, pre-existing `exhaustive-deps` warnings) | Pre-existing, no behavior impact. |

Verification done: `npx tsc --noEmit` clean; `eslint` on all touched files introduces no new findings; the quantity engine was exercised against all the §6 bug scenarios (fraction parsing, plural merge, dimension separation, regex precedence, conversion cycle) with a scripted run — all pass. Not yet verified on a device/simulator — worth a manual pass on the grocery/meal flow before release.

---

## 6. Original findings (reference, with resolution status)

### Quantity sync & conversion
| # | Severity | Bug | Status |
|---|---|---|---|
| Q1 | High | No unit conversion in aggregation ("200 g + 2 tsp") | ✅ Fixed (§2.1) — same-dimension merges; cross-dimension correctly stays separate |
| Q2 | High | Fractions mis-parsed; "1 1/2 cups flour" corrupted item text; "2 /2 cup" totals | ✅ Fixed (§2.1) |
| Q3 | High | Open-editor-then-Save froze computed totals as overrides | ✅ Fixed (§2.2) |
| Q4 | High | `overrideQuantity` never invalidated | ✅ Fixed (§2.2) — needs §3.1 server round-trip of `overrideBase` |
| Q5 | Med | Total below meal contribution silently discarded | ✅ Fixed (§2.2) — becomes explicit override |
| Q6 | Med | "1 cup + 2 cups" didn't merge | ✅ Fixed (§2.1) |
| Q7 | Med | Unit regex precedence bugs (`/^cups?\|c$/` etc.) | ✅ Fixed (§2.1) |
| Q8 | Med | Mass↔volume cycling at 1 g/ml; tsp/kg/lb missing | ✅ Fixed (§2.1) |
| Q9 | Med | Renaming aggregated row split it and could desync a meal ingredient | ✅ Fixed — renames all sources |
| Q10 | Design | Delete/check on aggregate hits meal ingredients | ✅ Decided: intentional, documented in code |

### Sync & data integrity
| # | Severity | Bug | Status |
|---|---|---|---|
| S1 | Critical | `NEEDS-RANK` persisted; `LexoRank.parse` crashes | ✅ Fixed client-side; **backend migration §3.2 pending** |
| S2 | Critical | WS echo → save loop; save-on-mount could wipe list | ✅ Fixed client-side; **echo suppression §3.3 recommended** |
| S3 | High | Whole-doc last-write-wins clobbering | ❌ Open — needs §3.3 |
| S4 | Med | No WS reconnect; token in query string | ✅ Reconnect fixed; token placement = §4 Q2 |
| S5 | Med | Categorize race; no loading indicator | ✅ Indicator added, response sanitized; race inherent until §3.3 |
| S6 | Med | (Found during fix) presence updates tore down/reopened the WS on every status change | ✅ Fixed — id-based effect deps |

### Release / config
| # | Severity | Bug | Status |
|---|---|---|---|
| R1 | Critical | Hardcoded LAN `BASE_URL` | ✅ Fixed — `EXPO_PUBLIC_API_URL`, prod default |
| R2 | High | Push registration dead (`Constants.isDevice` gone in SDK 53); route mismatch | ✅ Client fixed; route = §3.5 |
| R3 | Med | Production Android build = apk | ✅ Fixed — app-bundle |
| R4 | Low | Firebase web config public (by design) → rules are the boundary | Open — §4 Q7 rules audit |

### Dates / timezones
| # | Severity | Bug | Status |
|---|---|---|---|
| D1 | Med | `new Date('yyyy-MM-dd')` = UTC midnight, off-by-a-day in the Americas | ✅ Fixed — `parseWeekStart` everywhere; format confirm = §3.5 |
| D2 | Low | Hand-rolled week math in AddToMealPlanModal | ✅ Fixed |

### UX
| # | Severity | Bug | Status |
|---|---|---|---|
| U1 | Med | Ingredient ✕ delete button unmounted before press registered | ✅ Fixed — `onPressIn` |
| U2 | Med | Explore → meal plan not visible until refetch | ❌ Open — likely backend WS broadcast, §3.5 |
| U3 | Med | Rate-meal photo never uploaded; edit-recipe stub | ✅ Photo upload fixed; edit stub deferred (§5) |
| U4 | Med | Presence stuck-online on logout | ✅ Partial (§2.4, §5) |
| U5 | Low | `toE164` NANP-only | Deferred (§5) |
| U6 | Low | Meal placeholders reshuffled per mount | ✅ Fixed — deterministic |
| U7 | Low | Keyboard dismissal TODOs | Deferred (§5) |
| U8 | Low | Hooks called via factory in render (FAB) | ✅ Fixed |
