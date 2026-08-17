# FRIDGIE MEAL-TREND SUGGESTIONS — FINAL IMPLEMENTATION SPEC

Everything below was read from `/Users/nick/Dev/fridgie-mono` in this session. All cadence numbers were executed, not estimated (scripts: `/private/tmp/claude-501/-Users-nick-Dev-fridgie/380e1acf-977c-490d-9eed-906cb55267f9/scratchpad/cad2.ts` and `keys.ts`; full outputs in §8).

---

## 0. Corrections to the merged design, and to the reviewers

**The merged design's one "non-negotiable prerequisite" is already shipped.** Reviews 2 and 3 are correct and the merged design's §0 table is wrong. `/Users/nick/Dev/fridgie-mono/apps/api/api/recipe/feedback/[id].ts` is 121 lines; lines 49–52 parse and cap `feedback` at `MAX_FEEDBACK_CHARS = 2000`, lines 64–67 build `users/{uid}/recipeFeedback/{rootRecipeId}`, and lines 95–111 write `{rating, feedback, ratedRecipeId, mealId, timesRated, ratedAt, firstRatedAt}` inside the transaction, with prior-rating counter correction at 83–93. **§3.3 and §5.3 of the merged design are deleted from this spec.** The field is `feedback`, not `note`. Applying the proposed `transaction.set({merge:true})` would have clobbered `timesRated` and `firstRatedAt`.

Verdicts on the rest:

| Claim | Verdict |
|---|---|
| R1-A: `mad()` returns 0 whenever a majority of gaps are equal, so the dispersion test is structurally blind | **Correct and fatal.** MAD is deleted. Replaced by bucket-snap + inlier fraction + max-gap cap (§3.4). |
| R1-B: `due` has no upper bound; abandoned habits are maximally due and win the ranking | **Correct.** Two gates added: calendar freshness (≤10 weeks) and planned-week staleness. Ranking is recency-weighted (§3.5). |
| R1-C: `cadWeeks` computed then unused; due test runs in calendar days | **Correct.** All cadence and due arithmetic now runs in planned-week index. Calendar days appear only in the freshness gate. |
| R1-D: `occ >= 3` is two cycles, contradicting "3 complete cycles" | **Correct.** `occ >= 4`. |
| R1-E: even-count medians give half-integer cadences no template covers | **Correct.** Snapped to `{1,2,3,4}` planned weeks. |
| R1-G/G2/G3: empty `dishKey` collapses all junk into one high-`n` dish; possessives split; singulariser asymmetries; lexicon written in the wrong alphabet | **All correct.** Fixed in §3.2; lexicon keys are run through `dishKey` at module load and asserted in tests. |
| R1-H: multi-form names have no precedence rule | **Correct.** Head-noun-last (§3.6), pinned by test. |
| R1-J: no `.endAt`, so auto-created future weeks are counted as observations | **Correct and fatal.** `.endAt(targetWeek)` + explicit exclusion of the target week from evidence. |
| R1-K: legacy tz duplicate week docs give cadence 6 days | **Correct.** `snapToSunday` canonicalisation, verified against both real duplicate keys (§8). |
| R1-L/M: `recipeId` = "most recent non-null" produces false receipts; `dow` tallied over undeduped meals | **Correct.** Majority-rule binding; dedupe before any tally. |
| R1-O: `TZ` unset in Dockerfile is the only thing making `localWeekKeys` safe | **Correct.** `ENV TZ=UTC` added. |
| R1-N / R3-D5: per-group profile splits multi-group users' cadence | **Correct but not fixed in v1.** Per-group is retained; the failure direction is a *missed* pattern (no card), not a wrong one. See §7 and §9. |
| R2-1.1: ~96% of the 26-week read is grocery items; RTDB has no projection | **Correct.** Not fixable without the v2 projection. Mitigated by the `groupStats` counter gate (§3.1), which makes the tier-0 majority pay one small read instead of 359 KB. |
| R2-1.3: the memo contains `targetWeek`/`onTargetWeek` but is keyed on `groupId`, and is never busted on write | **Correct and fatal.** Memo split: target-independent history digest is memoised; target-week overlay is read fresh from `lists/{g}/{l}/meals` on every request. `Set` replaced with arrays. |
| R2-1.4: two endpoints cannot share a per-replica memo | **Correct.** The riff seed, avoid list and form bias are echoed by the client and re-validated server-side. |
| R2-1.5 / R3-D8: two add paths behind one button drop meals order-dependently | **Correct and fatal.** One path: everything goes through `POST /api/meal`, sequentially. The modal's optimistic write is deleted. |
| R2-1.6 / R3-D10: `weekStart` is not always `yyyy-MM-dd` in production | **Correct.** `slice(0,10)` + `snapToSunday` + window widened one day. |
| R2-1.2: `.indexOn` is unversioned and silently revertible | **Correct.** Rules committed to the repo — after exporting the live rules first (§4). |
| R2-1.7: no cheap way to skip the scan for the cohort that renders nothing | **Correct.** `groupStats/{groupId}` counter written from `mutateList`. In v1, not v2. |
| R2-3.1: `mealTrends` keyed without `groupId` leaks mutes across households and auto-mutes in one evening | **Correct.** Namespaced per group; decay on distinct session ids. |
| R2-3.2: the receipts sheet is a per-member behavioural disclosure | **Correct.** Exact dates and modal weekday only when `memberCount === 1`. |
| R2-3.3: leaving/deleting a group leaves `lists/{groupId}` intact and mineable | **Correct.** `joinedAt` window clamp added; orphaned-lists-on-delete flagged as a pre-existing defect this feature makes load-bearing. |
| R3-B3: `runLength < 3` fires exactly on perfect regularity, so the habit layer switches off for the user the brief names | **Correct and fatal.** `runLength` is deleted. |
| R3-B4: RIFF collides with `PROTEIN_SLOTS`, whose comment (`suggest/index.ts:72–79`) says it exists to fix the vegetarian skew | **Correct.** Resolved concretely: the riff replaces slot 1's protein line, and the riff prompt requires a different primary protein (§5). |
| R3-C: the rating funnel requires `dayOfWeek` + `recipeId` + the currently-selected list, so `recipeFeedback` will be near-empty | **Correct.** A 6-line fix to `list.tsx:552` ships in v1 — it is the difference between the taste layer existing and not. |
| R3-D1: trend cards bypass the dietary filter, which lives only in the prompt | **Correct and a safety issue.** REPEAT cards are filtered against `dietaryNeeds` and `dislikedIngredients` server-side, and REPEAT now requires a real recipe (so there is always something to filter). |
| R3-D2: cookbook membership is not planning evidence | **Correct.** The `"you"` branch is deleted for multi-member groups. |
| R3-D3: `"Dave's thing"` renders as a usual | **Correct.** Dissolved by requiring a majority-bound `recipeId` for REPEAT. |
| R3-D4: `ListContext` lands the user on *last* week by default, and the trends endpoint would compute against it | **Correct.** The endpoint refuses a non-current target week. |
| R3-D6: group names are unvalidated free text and get interpolated into a sentence | **Correct.** Group names are never interpolated. |
| R3-D9: re-roll unmounts the whole body; no Toast exists anywhere in the app; the results step overflows | **Correct.** `isSuggesting` is separated from `suggestionModalStep`; the undo affordance is an inline row, not a toast. |
| R3-B1: REPEAT is slower than "From Cookbook", three FAB items away | **Half right, not fixed.** Search answers "what do I want"; the card answers "what did I forget". But the point stands that the Suggest sheet is the wrong *sole* home. §7 makes the week-builder the named v2 successor with a measured trigger, and §9 keeps this as the top reason the feature may not work. |
| R3-B2: at most one REPEAT ever renders, so the feature has no growth curve | **Correct about the cause, wrong about the constraint.** With CATEGORY demoted out of the card slot (below), both slots are available to REPEAT. Cap stays 2 for sheet height. |
| Merged design: "3 fresh + 1 riff = 4 titles/round, so fix the comment at `:172`" | **Wrong.** The riff *is* one of the three. `recentTitles` still gains 3/round. The comment at `suggest/index.ts:172` is correct; leave it alone. |

**One structural change to the merged design that no reviewer proposed, and that dissolves four separate failures at once:**

> **CATEGORY is not a card.** A CATEGORY card ("Something pasta") has nothing to add to the plan — ticking it is a no-op. It becomes (a) a bias injected into the AI three, replacing one of the existing random draws, and (b) a one-line disclosed note above the Suggest button. This kills R3-B3's dead-slot problem, R1-H's mute-key ambiguity (`form:fish` vs `form:tacos` for fish tacos still matters, but only for the bias, which is invisible when wrong), R1-I's "most weeks" overclaim (no qualitative claim is made in a bias), and the "what does this button do" hole.

> **A REPEAT card requires a majority-bound `recipeId`.** No name-only REPEAT cards. This single rule kills R3-D3 ("Dave's thing"), R3-D1's un-filterable card, R1-L's false receipts, and the "Name only — no ingredients" subnote, at the cost of fewer cards for free-text-heavy users (fact 9). That is the safe direction and it is stated as a deliberate loss in §9.

---

## 1. What ships

Fridgie learns, per household, which saved recipes go on the meal plan on a rhythm, and which *kinds* of dinner show up most weeks. When you open **Suggest Meals**, before any AI call runs, a pinned **YOUR USUALS** section shows up to two dishes you already own that are due this week — each with a plain factual subnote ("You plan this most weeks — nothing on this week's plan yet") and a **Why am I seeing this?** sheet showing the counts behind it. Ticking one adds it in a single tap, with no model call and no wait. Separately and invisibly, the household's strongest dish-form habit ("pasta in 8 of the last 10 planned weeks") biases one of the three AI ideas, disclosed in one line above the button. And when the household has a recipe they demonstrably like, one of the three AI ideas becomes a **riff** on it — a genuinely different dinner that keeps one nameable thing from the original, with a model-written line saying what it kept and what it changed. Every claim the UI makes is either a count the user themselves entered or a sentence the server wrote from one; only the riff's line comes from the model, and it is validated before it renders. Every failure path degrades to exactly today's behaviour: three AI suggestions, no section, no error.

---

## 2. Data shapes

### 2.1 RTDB — new

```
groupStats/{groupId}
  plannedWeeks/{weekKey}: true      // weekKey = canonical yyyy-MM-dd Sunday. One key per week
                                    // that has ever held >=1 named meal. Pruning never happens;
                                    // ~104 keys after two years, ~1.5 KB.
  historyVersion: number            // ServerValue.increment(1) on every committed list mutation
                                    // whose post-state contains >=1 named meal. Memo buster.
  backfilledAt: number | null       // epoch ms. Absent => the lazy backfill has never run.
```

```
groups/{groupId}/joinedAt/{uid}: number   // epoch ms, NEW. Written on member add.
                                          // Absent for pre-existing members => treated as 0.
```

Existing, unchanged: `lists/{groupId}/{listId}` = `{ weekStart, items: Item[], meals?: Meal[], rev, lastClientId }`, `groups/{groupId}/members/{uid}: true`.

### 2.2 Firestore — new

`users/{uid}/mealTrends/{groupId}` — a document in a **new subcollection**. Namespaced per group (R2-3.1); a mute in Flat 3 must not silence the same dish at home.

```ts
{
  muted: {
    [key: string]: {
      kind: 'dish' | 'form'
      label: string                      // display label at mute time, for the undo row
      mutedAt: Timestamp
      expiresAtWeek: string | null        // canonical weekKey; null = permanent
      reason: 'explicit' | 'ignored'
    }
  }
  snoozedUntilWeek: { [key: string]: string }   // canonical weekKey it becomes eligible again
  shown: {
    [key: string]: {
      recentSessions: string[]   // last 5 distinct trend-session ids this key was rendered in
      addedCount: number
      lastShownAt: Timestamp
    }
  }
}
```

**Key format** — `dish:{rootRecipeId}` for REPEAT (always available, because REPEAT requires a bound recipe), `form:{dishForm}` for the category bias. No name-keyed entries exist in v1.

Existing, unchanged and now *read* by this feature: `users/{uid}.preferences`, `users/{uid}.mealSuggestions.recentTitles`, `users/{uid}/cookbook/{rootRecipeId}`, `users/{uid}/recipeFeedback/{rootRecipeId}` (already written by `recipe/feedback/[id].ts`), `recipes/{id}`.

### 2.3 Shared types — added to `packages/shared/types.ts`

```ts
export type DishForm =
  | 'pasta' | 'tacos' | 'curry' | 'stir-fry' | 'soup or stew' | 'roast' | 'pizza'
  | 'salad' | 'burgers or sandwiches' | 'rice bowl' | 'fish' | 'traybake'
  | 'chili' | 'breakfast'

export interface TrendCard {
  /** Stable across sessions. `dish:{rootRecipeId}`. */
  key: string
  kind: 'repeat'
  tier: 'confident' | 'emerging'
  /** Display name, from the most recent occurrence's casing. */
  name: string
  /** Always present. The client MUST send this id back unchanged. */
  recipeId: string
  photoURL?: string | null
  /** Server-templated. Never null on a rendered card, never model-written. */
  subnote: string
  receipts: {
    /** Total planned weeks in which this dish appeared, inside the window. */
    timesPlanned: number
    /** Planned weeks observed in the window — the denominator. */
    weeksObserved: number
    /** Cadence in planned weeks: 1 | 2 | 3 | 4. Absent on `emerging`. */
    everyWeeks?: 1 | 2 | 3 | 4
    /** Canonical weekKeys, most recent first. ONLY present when memberCount === 1. */
    dates?: string[]
    /** ONLY present when memberCount === 1 and the weekday is confidently modal. */
    dayOfWeek?: DayOfWeek
  }
}

export interface TrendsResponse {
  tier: 'none' | 'emerging' | 'confident'
  cards: TrendCard[]                 // 0–2
  /** The disclosed AI bias. Null when no form clears the gate. */
  formBias: { form: DishForm; weeks: number; weeksObserved: number } | null
  /** Echoed verbatim into POST /api/meal/suggest. Carries no authority. */
  echo: {
    sessionId: string
    avoidTitles: string[]            // trend card names, so the AI three don't collide
    riffRecipeId: string | null
    formBias: DishForm | null
  }
}

/** What POST /api/meal/suggest returns. Still a bare array. */
export type MealSuggestion = Omit<Recipe, 'id'> & {
  kind?: 'riff'
  subnote?: string | null
}
```

---

## 3. Algorithms

### 3.1 Read path and gating

```
GET /api/meal/trends?groupId=G&listId=L
```

1. `auth` + `groupAuth` (both read `groupId` from the query — this is a new route, no contract issue).
2. Read `lists/{G}/{L}/weekStart` (one leaf) → `targetWeekRaw`. `targetWeek = snapToSunday(targetWeekRaw)`.
   - If `targetWeek` is null, or `targetWeek < currentWeekKey(serverNow, 'UTC')`, return `{tier:'none', cards:[], formBias:null, echo:{…empty}}`. **This is R3-D4**: `ListContext.tsx:73–75` lands a returning user on the most recent week with content, which is last week. A profile computed against a past week suppresses the freshest candidates and produces negative gaps.
   - A *future* target week (next week, from the auto-created list) is allowed and is the common planning case.
3. Read `groupStats/{G}` (one small node) and `groups/{G}/joinedAt/{uid}` (one leaf).
   - `windowStart = targetWeek − 25 weeks`, clamped: `windowStart = max(windowStart, snapToSunday(joinedAt))`. **This is R2-3.3**: a member who joined 3 weeks ago never sees cadence derived from the year before they arrived.
   - If `groupStats/{G}` is absent → run the **lazy backfill** (§3.9) then continue.
   - Count `plannedWeeks` keys in `[windowStart, targetWeek)`. If `< 6`, return `{tier:'none'}` **without the big scan**. This is the gate that makes the tier-0 majority (fact 9) cost ~2 KB instead of ~359 KB.
4. Memoised history digest, key `${G}:${targetWeek}:${historyVersion}`, TTL 5 min, LRU cap 200. On miss:
   ```ts
   adminRtdb.ref(`lists/${G}`)
     .orderByChild('weekStart')
     .startAt(subDaysKey(windowStart, 1))   // legacy full-ISO keys land one day early
     .endAt(targetWeek)                     // R1-J: future weeks are intent, not evidence
     .once('value')
   ```
   Then filter in code to `windowStart <= weekKey < targetWeek`.
5. Read the target-week overlay **fresh on every request, never memoised** (R2-1.3):
   ```ts
   adminRtdb.ref(`lists/${G}/${L}/meals`).once('value')   // ~560 B, no grocery items
   ```
   → `onTargetWeek: string[]` (dishKeys) and `targetForms: DishForm[]`.

**Why the digest excludes the target week entirely:** the week being planned is in progress. Its absence is not evidence of a skip, and its presence is a suppression, not an observation.

### 3.2 `weekKey` and `dishKey`

```ts
/** Canonical Sunday key. Repairs legacy full-ISO weekStarts AND the tz duplicate-doc case. */
export function snapToSunday(raw: unknown): string | null {
  const bare = String(raw ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bare)) return null
  const t = Date.parse(bare + 'T00:00:00Z')
  if (!Number.isFinite(t)) return null
  const d = new Date(t).getUTCDay()                  // 0 = Sunday
  const shift = d === 0 ? 0 : d <= 3 ? -d : 7 - d    // nearest Sunday, not previous
  return new Date(t + shift * 86_400_000).toISOString().slice(0, 10)
}
```

Verified (§8): `2026-08-16 → 2026-08-16`; `2026-08-15T14:00:00.000Z → 2026-08-16`; and the two real duplicate docs from `list/index.ts`'s legacy path, `2026-02-07T11:00:00.000Z` and `2026-02-08T08:00:00.000Z`, **both → `2026-02-08`**. That is R1-K resolved: the duplicate week merges instead of producing a 6-day cadence.

```ts
const STOP = new Set(['homemade','home','made','easy','quick','simple','night','nights',
                      'dinner','the','a','an','my','our','some','with','and','for'])
const IRREGULAR = new Set(['hummus','couscous','swiss','asparagus','molasses','bolognese'])
const JUNK = new Set(['leftover','usual','same','whatever','something','anything',
                      'takeaway','takeout','delivery','out','tbd','tbc','food','meal','thing'])

export function dishKey(name: unknown): string | null {
  const key = String(name ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]s\b/g, '')          // possessives BEFORE punctuation (R1-G2)
    .replace(/[^a-z0-9\s]+/g, ' ')         // also strips RTDB-illegal . # $ [ ] /
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))   // single chars dropped (R1-G2)
    .map((w) => {
      if (IRREGULAR.has(w)) return w
      if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'   // curries -> curry
      if (w.length > 4 && /(ses|shes|ches|xes)$/.test(w)) return w.slice(0, -2)
      if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
      return w
    })
    .join(' ')
    .trim()
  if (key.length < 3) return null          // R1-G: '' must never become a dish
  if (JUNK.has(key)) return null
  return key
}
```

Verified behaviour (§8): `''`, `'Dinner'`, `'Easy Dinner'` → `null`; `'Leftovers'`, `'Leftover Night'` → `null` (via JUNK); `"Mum's Lasagne"` and `'Mums Lasagne'` → `mum lasagne` (merge); `'Curries'`/`'Curry'` → `curry` (merge); `'Hummus'` → `hummus`; `'Tacos'`/`'Taco'` → `taco`; `"Dave's thing"` → `dave thing` (survives normalisation but produces no card, because REPEAT requires a bound recipe). `'Spag Bol'` and `'Spaghetti Bolognese'` do **not** merge; both resolve to form `pasta`, which is what the bias uses.

**A meal counts as "named" iff `dishKey(meal.name) !== null`.** This is the definition used for `plannedWeeks` and `weeksObserved`, and it is what stops `handleAddMeal`'s `name: ''` rows (`list.tsx:401–408`, persisted by the wholesale save at `:381`) from inflating the denominator.

### 3.3 Occurrence extraction

For each list document in the window:
- `weekKey = snapToSunday(list.weekStart)`; skip if null or outside `[windowStart, targetWeek)`.
- `meals = Array.isArray(list.meals) ? list.meals : Object.values(list.meals ?? {})`.
- For each meal with `dishKey(meal.name) !== null`, group by `(weekKey, dishKey)`.
- **Dedupe to one occurrence per `(weekKey, dishKey)` BEFORE any tally** (R1-M). Survivor: prefer the entry with a `recipeId`; then the earliest `DAY_INDEX[dayOfWeek]` (undefined sorts last); then array order. This is deterministic and pinned by test.

`plannedWeeks` = ascending unique `weekKey`s having ≥1 named meal. `plannedIdx(weekKey)` = index into that array.

**`recipeId` binding, majority rule (R1-L):** for a dishKey with `n` occurrences, resolve each occurrence's `recipeId` to its root (`forkedFromId || id`, from the batched recipe fetch), tally, and bind only if one root id holds `>= Math.ceil(n / 2)` of the occurrences. Otherwise the dish has **no** bound recipe and produces no REPEAT card.

### 3.4 Cadence — planned-week index, bucket snap, inlier fit

```ts
const BUCKETS = [1, 2, 3, 4] as const
const TOL: Record<number, number> = { 1: 0, 2: 1, 3: 1, 4: 1 }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

// occ: deduped occurrences, ascending by weekKey
const weekGaps = occ.slice(1).map((o, i) => plannedIdx(o.weekKey) - plannedIdx(occ[i]!.weekKey))

// Snap to the bucket minimising total absolute deviation; ties -> smaller bucket.
const b = BUCKETS.reduce((best, cand) =>
  weekGaps.reduce((a, g) => a + Math.abs(g - cand), 0) <
  weekGaps.reduce((a, g) => a + Math.abs(g - best), 0) ? cand : best)

const fit      = weekGaps.filter((g) => Math.abs(g - b) <= TOL[b]!).length / weekGaps.length
const maxGapOk = Math.max(...weekGaps) <= 2 * b + 1
const inRange  = median(weekGaps) <= 4

const regular = occ.length >= 4 && inRange && fit >= 0.75 && maxGapOk
```

Then, with `gapToTarget` = (planned weeks strictly between `last` and `targetWeek`) + 1, and `calWeeksSinceLast` = `(Date.parse(targetWeek) − Date.parse(last)) / 604800000`:

```ts
const fresh    = calWeeksSinceLast <= 10                     // R1-B, R3-D1
const notStale = gapToTarget <= b + Math.max(2 * b, 3)       // at most ~3 missed cycles
const due      = gapToTarget >= b
const card     = regular && fresh && notStale && due
                 && !onTargetWeek.includes(key)
```

**Why every gate exists.** `occ >= 4` gives three gaps, so "3 complete observed cycles" is literally true (R1-D). `inRange` stops a 5-weekly dish snapping to bucket 4 and being described as monthly. `fit` is the dispersion test that MAD could not be — it counts inliers rather than taking a median of deviations, so a majority of identical gaps cannot mask an extreme one (R1-A). `maxGapOk` is the second half of that: `[1,1,4,1]` passes `fit` at exactly 0.75 and is killed by `maxGap 4 > 3`. Planned-week index is the sparsity fix: six weeks of not planning anything is not six skipped katsus (R1-C). `fresh` is a *calendar* gate and the only one, because taste and diet drift in calendar time even when planning stops — it is what stops a pre-vegetarian roast chicken rendering under YOUR USUALS (R3-D1).

Executed results, all 17 cases matching expectation, in §8.

### 3.5 Ranking and the emerging tier

REPEAT candidates are ranked by, in order:

```ts
const overdue = Math.max(0, (gapToTarget - b) / b)
const recentCount = occ.filter(o => plannedIdx(o.weekKey) >= plannedWeeks.length - 8).length
const score = (recentCount * fit) / (1 + overdue)
```
Tiebreak: `last` descending, then `n` descending, then `key` ascending. Deterministic across sessions, which is what R1-F3 asked for — the memo boundary must not reshuffle the section.

**Emerging tier** — for groups where nothing clears `regular`:
- `occ.length` is 2 or 3, `calWeeksSinceLast <= 5` (R1-F1), bound recipeId, not on the target week, not muted/snoozed.
- Sort by `last` desc, then `n` desc, then `key` asc (R1-F3).
- Copy makes **no cadence claim**: `You planned this 3 weeks ago.` — "planned", never "made" (R1-F2; the merged design violated its own §6.4 rule 2 here).
- Header is `WORTH A REPEAT`, not `YOUR USUALS`.
- Emerging cards render only when zero confident cards exist. Never mixed.

### 3.6 Dish forms and the AI bias

14 forms, closed union, hand-written, human-checked. A ~140-entry token→form map. **Every lexicon key is passed through `dishKey` at module load** (R1-G3) and a test asserts every key round-trips — otherwise `'tacos'` in the map silently never matches `dishKey('Tacos') === 'taco'`, and the stated failure mode ("no category card, the safe direction") makes the bug permanently invisible.

**Multi-form resolution: head-noun-last** (R1-H). Walk the dishKey's tokens left→right; the last token with a mapping wins. Verified: `fish taco → tacos`; `taco soup → soup or stew`; `pasta salad → salad`; `chicken curry soup → soup or stew`; `salmon traybake → traybake`; `curry fried rice → rice bowl`. No ties are possible by construction. ~30 ambiguous names are pinned in the test file.

Bias gate:
```ts
weeksObserved >= 6 &&
formWeeks    >= 4 &&
formWeeks / weeksObserved >= 0.5 &&
!targetForms.includes(form) &&
formOccursWithin(lastNPlannedWeeks = 4) &&
!muted[`form:${form}`] && !snoozed[`form:${form}`]
```
Highest `formWeeks` wins; tie → alphabetical. **`runLength` is deleted** — R3-B3 is right that it fires precisely on the perfect-habit case the brief names ("this person does pasta once a week"), which had `runLength = 26` and was permanently blocked. The recency guard that actually matters is `!targetForms.includes(form)`: if there's already pasta on this week, don't push pasta.

Unmatched dishKeys are logged at `info` with the group id redacted, so a lexicon gap is visible.

### 3.7 REPEAT card eligibility, in full

All must hold:
1. `regular && fresh && notStale && due` (§3.4), or emerging (§3.5).
2. Majority-bound root `recipeId`, and the recipe document exists.
3. Not on the target week's plan (`onTargetWeek`).
4. Not muted; `snoozedUntilWeek[key] <= targetWeek` if present.
5. No `users/{uid}/recipeFeedback/{rootRecipeId}.rating === 'disliked'`.
6. **Dietary safety (R3-D1).** Against `users/{uid}.preferences`:
   - `dietaryNeeds` containing `vegan` → recipe `tags` must contain `vegan`.
   - `vegetarian` → `tags` must contain `vegetarian` or `vegan`.
   - `pescatarian` → `tags` must contain `pescatarian`, `vegetarian`, or `vegan`.
   - `gluten-free` / `dairy-free` / `nut-free` → `tags` must contain the matching tag.
   - `dislikedIngredients` (string or array) → no ingredient name may contain any listed token (case-insensitive, word-boundary).
   - A recipe that is genuinely compliant but untagged is dropped. That is the safe direction and it is stated in §9.

Max **2** cards. Both may be REPEAT (R3-B2's growth-curve objection is real; the merged design's "never two of the same kind" rule existed to stop two CATEGORY cards, and CATEGORY is no longer a card).

### 3.8 Riff seed selection

Highest-priority eligible dish, all conditions required:
1. Bound root `recipeId` with a recipe document holding ≥3 ingredients.
2. `users/{uid}/recipeFeedback/{rootRecipeId}.rating === 'liked'` **or** in the caller's cookbook **or** `n >= 3` planned occurrences in the window.
3. No `disliked` rating.
4. `calWeeksSinceLast <= 16`.
5. Not muted / snoozed.
6. Passes the same dietary filter as §3.7.6.
7. **Not the same dish as any rendered REPEAT card.**

Priority: explicit `liked` with the highest `timesRated` (already stored — R2 is right that this is free and stronger than "planned ≥3 times"), then cookbook membership, then `n`.

### 3.9 Lazy backfill and the write hook

**Write hook** — in `mutateList`, after a committed write, fire-and-forget:
```ts
const weekKey = snapToSunday(value.weekStart)
const named = (Array.isArray(value.meals) ? value.meals : Object.values(value.meals ?? {}))
  .some((m: any) => dishKey(m?.name) !== null)
if (weekKey && named) {
  adminRtdb.ref(`groupStats/${groupId}`).update({
    [`plannedWeeks/${weekKey}`]: true,
    historyVersion: ServerValue.increment(1),
  }).catch((e) => console.error('groupStats update failed', e))
}
```
Idempotent (it's a set-to-true plus a counter), cannot drift, and never blocks or fails a list write.

**Lazy backfill** — on a trends request where `groupStats/{groupId}/backfilledAt` is absent:
```ts
const ok = await adminRtdb.ref(`groupStats/${groupId}/backfillLock`)
  .transaction((cur) => (cur && Date.now() - cur < 60_000 ? undefined : Date.now()))
if (!ok.committed) return { tier: 'none', … }   // another request is doing it; this one degrades
```
Then run the full windowed scan, write every named `weekKey` plus `backfilledAt: Date.now()` in one `update()`, clear the lock, and continue with the digest already in hand. One scan per group, ever.

---

## 4. File-by-file changes

### Prerequisites (do these first, in order)

**P1. Export the live RTDB rules before writing any rules file.** There is no `firebase.json`, no `database.rules.json`, no `.firebaserc` anywhere in the repo (verified). Writing one from scratch and deploying it would **replace production security rules**. Run `firebase database:get "/.settings/rules" --project <id>` (or download from the console), commit the result verbatim as `/Users/nick/Dev/fridgie-mono/firebase.json` + `/Users/nick/Dev/fridgie-mono/database.rules.json`, confirm a no-op deploy, *then* add:
```json
"lists": { "$groupId": { ".indexOn": ["weekStart"] } }
```
Without it, the Node Admin SDK downloads the whole `lists/{groupId}` node and filters locally (`firebase-admin@13.4.0` vendors `@firebase/database`; `once('value')` is a tagged listen, not `get()`), so the window buys nothing. Add a CI step that deploys rules, and log-scan stderr for `no_index` at startup.

**P2. `/Users/nick/Dev/fridgie-mono/apps/api/Dockerfile`** — **EDIT.** Add `ENV TZ=UTC` in the `release` stage. `localWeekKeys` (`list/index.ts:24–36`) calls `startOfWeek` on a synthetically zone-shifted `Date` and reads local calendar fields; it is safe today only because `oven/bun:1` leaves `TZ` unset. One line, and it protects the only input this feature has.

### New files

| Path | Contents |
|---|---|
| `/Users/nick/Dev/fridgie-mono/apps/api/utils/mealTrends.ts` | `snapToSunday`, `dishKey`, `DISH_FORMS`, `FORM_TOKENS` (normalised at module load), `resolveForm`, `median`, `snapBucket`, `analyseCadence`, `buildHistoryDigest`, `getHistoryDigest` (memo keyed `${groupId}:${targetWeek}:${historyVersion}`, 5-min TTL, LRU 200), `getTrendProfile(groupId, listId, uid)`. No `Set` in any returned shape (R2-1.3) — arrays only, so the type survives JSON. |
| `/Users/nick/Dev/fridgie-mono/apps/api/utils/trendCopy.ts` | `repeatSubnote(card, memberCount)`, `emergingSubnote(...)`, `formBiasNote(...)`, `buildReceipts(dish, memberCount)`. Pure functions, no I/O, unit-tested. Never interpolates a group name (R3-D6). |
| `/Users/nick/Dev/fridgie-mono/apps/api/api/meal/trends/index.ts` | `GET /api/meal/trends?groupId=&listId=`, `auth` + `groupAuth`. Implements §3.1. Every failure path returns `{tier:'none', cards:[], formBias:null, echo:{sessionId:'', avoidTitles:[], riffRecipeId:null, formBias:null}}` with a 200. **Never 500s the sheet.** Fires the `shown` write (fire-and-forget) for every card it returns. File-based routing (`apps/api/index.ts:15–33`) maps this automatically. |
| `/Users/nick/Dev/fridgie-mono/apps/api/api/meal/trends/dismiss.ts` | `POST /api/meal/trends/dismiss?groupId=` body `{ key, action: 'snooze'\|'mute'\|'unmute', targetWeek }`. `auth` + `groupAuth`. Writes `users/{uid}/mealTrends/{groupId}` via `runTransaction` (needed for the `recentSessions` union and `addedCount`). |
| `/Users/nick/Dev/fridgie-mono/apps/api/tests/mealTrends.test.ts` | §8. |
| `/Users/nick/Dev/fridgie-mono/apps/api/tests/trendCopy.test.ts` | Copy templates: no group name ever appears; no "like" without a stored rating; every `everyWeeks` value 1–4 has a template. |
| `/Users/nick/Dev/fridgie-mono/database.rules.json`, `/Users/nick/Dev/fridgie-mono/firebase.json` | Per P1. |

### Backend edits

| Path | Change | Why |
|---|---|---|
| `apps/api/utils/listStore.ts` | After the `status:'ok'` return path (line 62), add the fire-and-forget `groupStats` update from §3.9. Import `snapToSunday`/`dishKey` from `mealTrends.ts`. | `mutateList` is the single choke point for every meal mutation (verified: `list/[id].ts:57` spreads `{...current, ...payload}`, so `value.meals` is the complete post-commit state even on a grocery-only save). This is the 10-line prefix of the v2 projection and it is what makes the tier-0 majority free (R2-1.7). |
| `apps/api/api/meal/suggest/index.ts` | (a) Accept optional `groupId`/`listId` **query** params + a `trend` object in the body. **Do NOT add `groupAuth` middleware** — `apps/mobile/utils/api.ts:451` sends no groupId today and `groupAuth` 400s on a missing one; validate inline with the same single-key read so older builds keep working. (b) Re-validate `trend.riffRecipeId` (recipe exists; in the caller's cookbook OR present in the group digest) and `trend.formBias ∈ DISH_FORMS`. (c) Append `trend.avoidTitles` to `avoid`, and **filter the riff seed's name out of `avoid`** — otherwise line 287 forbids the dish line ~260 asks for a riff on. (d) When a riff is active, replace `composition`'s slot 1 line with the riff instruction and drop that slot's protein assignment (R3-B4). (e) When `formBias` is set, replace the `seeds.cuisine` line's "let one of the three lean X" with the form bias for slot 2. (f) Local `suggestionSchema` (§5.2) — **do not touch the shared `recipeSchema`**, which `importedRecipeSchema` derives from and two import routes plus `scripts/verifyClaudeCalls.ts` depend on. (g) Verify + validate the riff (§5.3, §5.4). (h) Log `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`. Leave the `RECENT_TITLES_CAP` comment at `:172` alone — the riff is one of the three, not a fourth. |
| `apps/api/utils/recipePrompts.ts` | Add `export const riffSlotRules` (§5.1). Nothing else changes. | Additive; the shared schema is untouched. |
| `apps/api/utils/claude.ts` | Return `usage` alongside the parsed body (`completeJson` → `{ data, usage }`), or add a `onUsage?: (u) => void` callback. Update the three existing callers. | Every cost claim about this feature is currently unfalsifiable (R2-2). Log for a week before believing any estimate. |
| `apps/api/api/group/[id].ts` | In `PUT`, alongside `updates['members/${uid}'] = true`, write `updates['joinedAt/${uid}'] = Date.now()`. | The window clamp in §3.1 (R2-3.3). |
| `apps/api/api/group/index.ts` | In the auto-created "Private" group (line 41–46) and `POST` (line 99–104), add `joinedAt: { [uid]: Date.now() }`. | Same. |

**Not changed, deliberately:** `apps/api/api/recipe/feedback/[id].ts` (already complete), `apps/api/api/meal/index.ts`, `apps/api/api/list/[id].ts`, `apps/api/api/cookbook/index.ts`.

### Mobile edits

| Path | Change |
|---|---|
| `apps/mobile/utils/api.ts` | **New** `getMealTrends(groupId, listId): Promise<TrendsResponse>` → `GET /meal/trends?groupId=&listId=`. **New** `dismissTrend(groupId, key, action, targetWeek)`. **Edit** `getMealSuggestions(vetoedTitles?, opts?: {groupId, listId, trend})` at `:450` — query params + `trend` in the body; return type widened to `MealSuggestion[]`. |
| `apps/mobile/components/MealSuggestionsModal.tsx` | The bulk of the work. §6. Key structural changes: `groupId` prop; `isSuggesting` separated from `suggestionModalStep` so a re-roll no longer unmounts the section (R3-D9); two selection maps; **the add path is rewritten to go through `addRecipeToList` only** (R2-1.5 / R3-D8); `···` menu; receipts sheet as an in-component overlay `View`, not a nested `Modal`; inline undo row, because **there is no Toast or Snackbar anywhere in this app** (verified — every notification is `Alert.alert`). |
| `apps/mobile/app/(tabs)/list.tsx` | `:782` — pass `groupId={selectedGroup?.id ?? ''}`; replace `onAddSelectedMeals={handleAddMealsFromSuggestion}` with `onMealsAdded={handleMealsAddedRemotely}`. **New** `handleMealsAddedRemotely()` = `setTimeout(() => { if (sort === 'category') handleAutoCategorize().catch(console.error) }, 1200)`. **Delete** `handleAddMealsFromSuggestion` (lines 358–399) — it is now unreachable and it is the optimistic writer that races. **Edit** `:552`: drop the `dayOfWeek` requirement from the unrated-meal filter and derive the date as `weekStart + DAY_INDEX[dayOfWeek]` when present, else `weekStart + 6` (§6.5). |
| `packages/shared/types.ts` | Add `DishForm`, `TrendCard`, `TrendsResponse`, `MealSuggestion` (§2.3). Type-only, fully erased — Metro never resolves it. |

---

## 5. Prompt and schema changes

Total addition to the cached system prefix: **~190 tokens**. The current `systemPrompt` assembles to ~560 tokens, above Opus 5's 512-token cacheable minimum. Per-request riff detail goes in the user turn, per the discipline the file's own comment at `:184–186` states.

### 5.1 New export in `apps/api/utils/recipePrompts.ts`

```
export const riffSlotRules = `
RIFF SLOT

When the request marks one of the three as a riff, that one is built off a dish
this household already cooks. You are given the source dish's name and its
ingredients.

Produce a DIFFERENT dish that keeps one specific, nameable thing from the
source — a technique, a sauce base, a cuisine, a cooking method — and changes
everything else. Use a different primary protein from the source. Share at most
a third of the source's ingredients; salt, pepper, oil, butter, onion, garlic,
stock and water are free and count for neither side.

The failure that matters is the same dish under a new name. Eggplant Parmesan
from Chicken Parmesan swaps one ingredient and nothing else: same form, same
technique, same cuisine, same sauce, same cheese. It makes the app look like it
isn't paying attention. If your suggestion's name is the source's name with one
word changed, you have failed this slot.

The other failure is drifting so far that someone who cooks the source dish
would not see the family resemblance. Then the line explaining the connection
stops being true.

Give the riff recipe a "subnote": one sentence, under 120 characters, naming the
source dish exactly as given and saying what you kept and what you changed.
Plain and specific. No exclamation marks, no "we thought you'd love", no
second-guessing. If you cannot state a real connection, set it to null — a
missing line is better than an invented one. Every other recipe gets
"subnote": null and "slot": "fresh".
`
```

Appended to `systemPrompt` in `suggest/index.ts` after `${tagVocabulary}`.

### 5.2 Route-local schema (`suggest/index.ts` only)

```ts
const suggestionSchema = {
  ...recipeSchema,
  properties: {
    ...recipeSchema.properties,
    slot:    { type: 'string', enum: ['fresh', 'riff'],
               description: "'riff' for the riff slot, else 'fresh'." },
    subnote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: [...recipeSchema.required, 'slot', 'subnote'],
} as const

const suggestionsSchema = {
  type: 'object',
  properties: { recipes: { type: 'array', items: suggestionSchema } },
  required: ['recipes'],
  additionalProperties: false,
} as const
```

`slot` correlates the subnote deterministically rather than trusting array order. Every property is in `required`, every object keeps `additionalProperties: false`, optionality is `anyOf` with `null` — the exact pattern `importedRecipeSchema` (`recipePrompts.ts:72–95`) already proves against this API in this codebase. `minItems`/`maxLength` are unavailable in structured outputs, so "3 recipes" stays prose and the 120-char cap is enforced server-side. If more than one recipe returns `slot: 'riff'`, keep the first and demote the rest.

### 5.3 User-turn additions

Inserted into `parts` after `composition`:

```
  1. a riff on "Chicken Katsu Curry" (see RIFF SLOT). Its ingredients are:
     chicken thighs, panko, curry powder, onion, carrot, potato, rice, soy sauce.
  2. built around white fish
  3. built around beans or lentils
```
(slot 1's `pick(slot)` protein line is *replaced*, not supplemented — R3-B4.)

And, when a form bias is active, replacing the cuisine lean line for slot 2:
```
Let one of the three be a pasta dish.
```
No count, no "because" — the bias is a nudge, and the user-facing disclosure is written by the server (§6.2), not by the model.

**Line 282's ban gets scoped.** Currently: *"Those two lists are the register to aim for, not a menu to copy — do not suggest any of them."* When a riff is active, append: *"— except the dish the riff slot names, which you are varying, not copying."*

### 5.4 Server-side riff verification and validation

Verification (label-free, no over-generation, no retry):

```ts
const FREE = new Set(['salt','pepper','oil','olive oil','butter','onion','garlic',
                      'stock','broth','water','sugar','flour'])
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g,' ').trim()

// 1. Ingredient novelty
const jaccard = intersect(srcSet, candSet).size / union(srcSet, candSet).size   // FREE removed
if (jaccard > 0.40) fail()

// 2. Name guard — kills "Eggplant Parmesan" from "Chicken Parmesan"
const a = new Set(norm(source.name).split(' ')), b = new Set(norm(cand.name).split(' '))
if (norm(cand.name).includes(norm(source.name)) || norm(source.name).includes(norm(cand.name))) fail()
if (symmetricDifference(a, b).size < 2) fail()

// 3. Signature-ingredient guard (the protein rule, mechanically)
const top3 = srcIngredients.filter(i => !FREE.has(i)).slice(0, 3)
if (top3.filter(i => candSet.has(i)).length > 1) fail()
```

Subnote validation (riff only):
```ts
function validateRiffSubnote(text: string | null, sourceName: string): string | null {
  if (!text) return null
  if (text.length > 120) return null
  if (!text.toLowerCase().includes(sourceName.toLowerCase())) return null
  if (/\d/.test(text)) return null
  if (/we (thought|think)|you'?ll love|perfect for you|!/i.test(text)) return null
  return text
}
```

**On any failure: drop `kind` and `subnote` and return the recipe as an ordinary fresh suggestion.** A failed riff is still a perfectly good dinner; the user sees three suggestions either way. No over-generation (~900 wasted output tokens per call to protect a slot with a free landing spot), no second round trip.

`recentTitles` handling: the riff **is** model output and **is** pushed (line 308 already pushes `recipes.map(r => r.name)` — unchanged). Trend card titles are **never** pushed there — doing so would make the next prompt instruct Claude "do not repeat or closely echo: Chicken Katsu Curry", actively suppressing the dish being promoted.

---

## 6. Mobile UI

### 6.1 Confirm step

```
              Suggest Meals

  YOUR USUALS                                  ⓘ
  ┌───────────────────────────────────────────────┐
  │ [ ]  ⟳  Chicken Katsu Curry              ···  │
  │         You usually plan this every couple    │
  │         of weeks. Not on this one yet.        │
  └───────────────────────────────────────────────┘
  ┌───────────────────────────────────────────────┐
  │ [ ]  ⟳  Sheet-Pan Sausages & Peppers     ···  │
  │         Planned 6 of the last 10 weeks you    │
  │         made a plan. Nothing yet this week.   │
  └───────────────────────────────────────────────┘

  Quick & easy · Italian · no mushrooms          ›

  Leaning one idea toward pasta — you plan it 8
  of the last 10 weeks.                      Not this week

  ┌───────────────────────────────────────────────┐
  │              Suggest 3 meals              ✦   │
  └───────────────────────────────────────────────┘
```

- **Max 2 cards**, both may be REPEAT. On a `maxHeight: '75%'` sheet (`styles.modalContent:337`) a third pushes the AI button below the fold.
- The four-block preferences dump (`:241–258`) collapses to one tappable summary row that opens `/meal-preferences` via the existing `pendingAction` dance (`:153–157`).
- The form-bias line is one sentence with an inline **Not this week** link. It is *disclosure*, not a control surface — it doesn't get a checkbox because it doesn't add anything.
- Once ≥1 usual is ticked, the button pair swaps emphasis: **`Add 1 meal`** primary, **`Suggest 3 more`** secondary. Their intent is now *add*; taxing it with a 20-second model call is the wrong default.
- **Tier 0 renders nothing at all.** No skeleton, no empty state, no "we're still learning". An empty promise box advertises a capability the app can't yet deliver, on the exact day someone is deciding whether the app is any good.

### 6.2 Microcopy — every string, server-templated

Rules enforced in code, not in review:

1. **"Like" appears only where `users/{uid}/recipeFeedback/{root}.rating === 'liked'`.** Everywhere else the copy describes behaviour: *you plan*, *you've planned*, *shows up*. The user's verbatim ask (`Because you like "xyz"`) is honoured exactly where they put it — on the riff — and nowhere it would be a guess. R3-C is right that this branch will be rare until the rating funnel is fixed; §6.5 fixes what can be fixed cheaply.
2. **"Planned", never "cooked" or "ate".** RTDB records what went on a plan, not what came out of a pan. The only exception is a dish with a stored rating.
3. **The group name is never interpolated into a sentence** (R3-D6 — `group/index.ts:94` validates `name` as `typeof name === 'string'` and nothing else). Say "in this group".
4. **Never "you" for a cadence claim in a multi-member group** (R3-D2 — cookbook membership is set by a toggle in `ViewRecipeModal` and by Explore browsing; it is not evidence of ever having planned anything).

| Case | Copy |
|---|---|
| Confident, `everyWeeks: 1`, solo group | `You plan this most weeks. Nothing on this week's plan yet.` |
| Confident, `everyWeeks: 1`, shared group | `Planned most weeks in this group. Nothing yet this week.` |
| Confident, `everyWeeks: 2`, solo | `You usually plan this every couple of weeks. Not on this one yet.` |
| Confident, `everyWeeks: 2`, shared | `Usually about every other week in this group. Not on this one yet.` |
| Confident, `everyWeeks: 3` | `Comes around about every 3 weeks. Nothing yet this week.` |
| Confident, `everyWeeks: 4` | `About once a month. Due around now.` |
| Confident, overdue ≥1 full cycle, solo | `You've made 3 plans since the last one — you usually go every 2.` |
| Confident, weekday modal, **solo group only** | `Usually a Tuesday. Planned 6 times.` |
| Emerging, solo | `You planned this 3 weeks ago.` |
| Emerging, shared | `Planned in this group 3 weeks ago.` |
| Counted fallback (any tier) | `Planned 6 of the last 10 weeks you made a plan.` |
| Form bias | `Leaning one idea toward pasta — you plan it 8 of the last 10 weeks.` |
| Riff, explicit `liked` on record | `Because you liked "Chicken Katsu Curry".` *(model-written, validated)* |
| Riff, behavioural only | `A twist on Chicken Katsu Curry — keeps the curry base, swaps in white fish.` *(model-written, validated)* |
| Riff, validation failed | *(no subnote; card renders as an ordinary suggestion)* |

**The word "most weeks" appears only when `weeks/weeksObserved >= 0.65`** (R1-I). Below that the counted template is used, which is always true. The counted template is the default; the qualitative one is the exception.

### 6.3 Results step

```
              Meal Suggestions

  YOUR USUALS                                  ⓘ
  [✓]  ⟳  Chicken Katsu Curry               ···     ← survives the re-roll
  FRESH IDEAS                      [ 🎲 Re-roll ideas ]
  [ ]  ✦  Crispy Katsu-Spiced Cod with Pickled Slaw
          Panko-crusted and pan-fried, with…
          A twist on Chicken Katsu Curry — keeps the
          panko-and-curry-spice idea, swaps in cod.
  [ ]     Sheet-Pan Harissa Salmon
          Roasted in one tray with…
  [ ]     Beef & Black Bean Chilli
          Slow-simmered, freezes well…

  ┌───────────────────────────────────────────────┐
  │                Add 2 Selected                 │
  └───────────────────────────────────────────────┘
```

- **`isSuggesting` must be split out of `suggestionModalStep`.** Today `handleRerollSuggestions` (`:128`) sets the step to `'loading'`, and `:228–235` replaces the entire modal body with a spinner — everything above unmounts. R3-D9 is right that this, not `setSelectedSuggestions({})` at `:135`, is the actual blocker. New shape: `step: 'confirm' | 'results'` plus a separate `isSuggesting` boolean; on results, the FRESH IDEAS block renders a spinner in place of the three cards while `isSuggesting`, and YOUR USUALS stays mounted with its selection intact.
- **Two selection maps** — `selectedTrends` and `selectedSuggestions`. The re-roll clears only the latter.
- The Re-roll pill moves out of the centred `rerollButtonContainer` (`:386–390`) into the FRESH IDEAS header row, right-aligned, relabelled **`Re-roll ideas`**. Its current centred position visually governs the whole sheet, which becomes a lie once usuals exist.
- **Card anatomy differs by kind, deliberately.** REPEAT: name + subnote, **no description** — they know the dish; the subnote is the payload. AI/riff: name + description + subnote.
- Icons (Ionicons, already imported at `:1`): `repeat` for REPEAT, `sparkles` for the riff.
- `suggestionSubnote`: `{ fontSize: 12, color: '#8a8a8a', marginTop: 4, fontStyle: 'italic' }`. Provenance, not pitch.

### 6.4 Controls, receipts, and the add path

`···` menu (an in-component overlay `View`, not a nested `Modal`):
- **`Not this week`** → `POST /meal/trends/dismiss {action:'snooze'}`, card animates out, an inline undo row appears in its place for 6 seconds: `Snoozed "Chicken Katsu Curry".  Undo`. **There is no Toast library in this app** (verified) and adding one for this is not justified.
- **`Stop suggesting this`** → `{action:'mute'}`, same inline undo row.
- **`Why am I seeing this?`** → receipts overlay.

**Receipts, shared group (`memberCount > 1`):**
> **Why "Chicken Katsu Curry"?**
> It's been on this group's plan 6 of the last 10 weeks someone made a plan — about every other week — and it isn't on this one.
>
> `Not this week` · `Stop suggesting this` · `Got it`

**Receipts, solo group (`memberCount === 1`) — the only place exact dates appear:**
> **Why "Chicken Katsu Curry"?**
> You've put it on the plan 6 times: 12 Jan, 26 Jan, 9 Feb, 23 Feb, 8 Mar, 22 Mar. That's about every other week, usually a Tuesday.
>
> `Not this week` · `Stop suggesting this` · `Got it`

R2-3.2 is right and this is the fix. `lists/{groupId}` is a shared write surface, `Meal` has no `addedBy` (`packages/shared/types.ts:78–85`), and nothing in this app today surfaces historical weeks as a queryable series. Printing four exact dates and a modal weekday hands one housemate a retrospective readout of another's behaviour, *via the transparency control*. Counts and cadence preserve the anti-creepiness function — it is still visibly a reading of data the group owns — without the timeline.

**Silent decay.** A card shown in 3 distinct trend sessions (server-issued `sessionId`, not weeks — R2-3.1's "three groups on a Sunday evening" case is defeated by `groupId` namespacing plus distinct-session counting) with `addedCount === 0` → auto-mute for 8 weeks, `reason: 'ignored'`. A trend-sourced meal removed within 10 minutes counts double.

**The add path — ONE path.** Both R2-1.5 and R3-D8 traced the same fatal race, from opposite ends: `POST /api/meal` calls `mutateList` with no `expectedRev` and `lastClientId: null`, which `list.tsx:183` treats as server-initiated and `:188` applies unconditionally, overwriting `meals` from the server array; meanwhile `handleAddMealsFromSuggestion` (`:381`) posts with `revRef.current` and 409s, and its catch (`:394–398`) does **not** rebase — it fires `Alert.alert("Error", …)`. Whether the user loses meals depends on `Promise.all` scheduling. The comment already in the codebase at `list.tsx:783–784` documents exactly why the two mechanisms were kept apart.

```ts
// MealSuggestionsModal.handleAddSelected — sequential, single writer.
for (const card of selectedTrendCards) {
  await addRecipeToList(groupId, listId, { id: card.recipeId, name: card.name } as Recipe)
  void markTrendAdded(groupId, card.key)          // fire-and-forget
}
for (const s of selectedAiSuggestions) {
  const saved = await saveRecipe(s)               // mints the real recipe id
  await addRecipeToList(groupId, listId, saved)   // server builds items + LexoRanks
}
onMealsAdded()
onClose()
```
`POST /api/meal` (`meal/index.ts:42–80`) builds items server-side with correct ranks via `maxRank`/`sanitizeItems` — better than the client path it replaces. The trend card carries a **real** `recipeId`, so it must never go through `saveRecipe`: `POST /api/recipe` forks on a `createdBy` mismatch (`recipe/index.ts:54–68`) and `MealSuggestionsModal.tsx:110` stamps a fresh uuid on every suggestion, which would mint a new fork every week and leave `DishStat.recipeId` pointing at a churning fork chain.

### 6.5 The rating-funnel unblock (6 lines, `list.tsx:552`)

R3-C is right that the taste layer is built on a table that will be near-empty: `scheduledNotifications` is written at `notification/schedule-rating.ts:35` and read by nothing (grep confirms one hit repo-wide), so `list.tsx:524–578` is the only funnel, and it requires `dayOfWeek` — which is set by exactly one interaction (`MealCard.tsx:124–126`) and by **no** server path.

```ts
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const mealDateOf = (m: Meal) => {
  const d = parseWeekStart(selectedList.weekStart)
  d.setDate(d.getDate() + (m.dayOfWeek ? DAY_NAMES.indexOf(m.dayOfWeek) : 6))
  return d
}
const unratedPastMeals = meals.filter(m =>
  m.recipeId && !ratedMealIds[m.id] && mealDateOf(m) < today)
```
A meal with no weekday is assumed to have happened by the end of its week. `recipeId` is still required — there is nothing to rate without one. This does not fix the "last week's meals become unreachable when the week rolls over" gap; that needs a scan across recent lists and is v2.

### 6.6 Explainer (ⓘ)

> **Where these come from**
>
> Fridgie looks at the meals that have been put on this group's plan — nothing else. If a saved recipe keeps coming back on a rhythm, we offer it when it's about due. If a kind of meal shows up most weeks, we nudge one of the AI ideas that way.
>
> We don't look at your groceries, your messages, or anything outside the app.
>
> What you dismiss here is yours alone, and only applies to this group. Nobody else in the group sees it.

With no history: `Nothing to go on yet. Plan a few weeks of meals and Fridgie will start spotting the ones that keep coming back.`

---

## 7. Deliberately not in v1

| Not building | Trigger that would make us build it |
|---|---|
| **The RTDB projection layer** (`mealHistory/{groupId}/{weekKey}` digests, dirty flags, read-path swap). ~96% of the 26-week read is grocery items (R2-1.1) and there is no projection in RTDB. | p95 trends latency > 800 ms, **or** any group's windowed read exceeding 500 KB. Then: `projectWeek()` fire-and-forget from `listStore.ts` immediately before the `status:'ok'` return, one multi-path `update()`, ship the write hook one release before the read swap so it accumulates against warm data, then a lazy per-group backfill under the lock that already exists in §3.9. The digest is an idempotent projection of one document and cannot drift. |
| **Cross-group cadence** (R1-N, R3-D5). Per-group means a user who alternates households has their occurrences split; the gate that fails first is `occ >= 4`, i.e. a *missed* pattern. | >15% of active users show ≥2 groups with ≥4 planned weeks each in the same 26-week window. Then: union the caller's groups for `DishStat` only, keep `weeksObserved` and the form bias per-group, and never say "you" for a cadence sourced from another group. Needs a `users/{uid}/groups` index — `getCookbook` currently gets this by downloading **every group in the database** (`cookbook/index.ts:98`), which must not be copied onto a hot path. |
| **Five-axis AI dish labelling + a `dishLexicon` collection.** Its only marginal value over the keyword map is mechanical riff verification, which needs a labelled corpus, a tuned threshold, and a hand-labelled held-out set that does not exist. A model-invented category string would also ship to users unreviewed in two UI strings. | >20% of dishKeys hitting the form lexicon's fallback, sustained over two weeks. Then: backfill all ~143 recipes, histogram each axis, and revise the enum before writing labels anywhere if any axis exceeds 15% `other`. |
| **Riff over-generation** (3 candidates in-call, take the first that passes). ~+900 output tokens ≈ +$0.02 every call to protect a slot whose failure mode is "a perfectly good dinner". | Riff verification rejection rate > 25% measured over ≥100 calls. |
| **Analytics SDK.** There is none in this repo. | v1 runs on server logs. Build `POST /api/event` → `analytics/{yyyy-MM-dd}/events/{autoId}` when the §9 kill criteria need percentages rather than counts. |
| **A cron / scheduled recompute.** No scheduler exists; an in-process `setInterval` breaks the moment the container scales past one replica; and the one precedent for scheduled work here (`scheduledNotifications`) is an orphaned queue nothing reads. | Never, in this form. If it's needed, it's a real worker with an RTDB leader lock. |
| **The Sunday week-builder** — a nudge on the meal-plan tab when the user opens an empty week: *"Last week you planned 3 meals. Want your usual four?"*, filling a week from cadence in one tap. R3 is right that this is the honest highest-value version of the brief, and that a user who opens "Suggest Meal" has by that act said they want *new* ideas. | REPEAT add rate ≥ 25% of sessions where the section rendered. That number says the inference works; the week-builder is then where it belongs. If REPEAT's add rate is under 10%, the answer is also the week-builder — move it there rather than tuning it in the sheet. |
| **Fixing `GET /api/list`'s unwindowed `listsRef.transaction()`** on the entire `lists/{groupId}` node, on every app launch, which writes the whole node back on the create path (`list/index.ts:57–111`). R2-1.8 is right that this is strictly worse than anything this feature proposes. | Out of scope here, but it should be its own ticket, and no future argument of the form "the trend scan is affordable because the app already round-trips" should lean on it. |
| **Deleting or redacting `lists/{groupId}` on group delete.** `DELETE /api/group/:id` removes `groups/{groupId}` (`group/[id].ts:65`) and leaves every list orphaned in RTDB permanently, unreachable by `groupAuth`. Pre-existing, but this feature is the first to make 26 weeks of it load-bearing. | Own ticket, and it should be filed with this work. The `joinedAt` clamp handles the member-leaves case; nothing handles group-deleted. |

---

## 8. Test plan

`apps/api/tests/mealTrends.test.ts`, run with `bun test` (the `apps/api/tests/` convention exists — `quantity.test.ts`, `rank.test.ts`).

### 8.1 Cadence — executed, all 17 pass

Each case is `analyseCadence(weekGaps, {calWeeksSinceLast, gapToTarget})`:

```
CASE                                       b  tol  fit   maxGap  reg    fresh  notStale  due    RESULT
weekly then a month off      [1,1,4,1]     1   0   0.75   4      false  true   true      true   no card   ✓
weekly then abandoned  [1,1,1,1,13,13,13]  1   0   0.57  13      false  false  false     true   no card   ✓
fortnightly + 6wk hole       [2,2,2,6]     2   1   0.75   6      false  true   true      true   no card   ✓
clean fortnightly            [2,2,1,2]     2   1   1.00   2      true   true   true      true   CARD /2w  ✓
bimodal weekly/fortnightly   [1,1,2,2]     1   0   0.50   2      false  true   true      true   no card   ✓
favourite, not cadence       [1,6,2]       2   1   0.67   6      false  true   true      true   no card   ✓
3 occurrences only           [1,1]         1   0   1.00   1      false  true   true      true   no card   ✓  (occ<4)
clean weekly                 [1,1,1,1]     1   0   1.00   1      true   true   true      true   CARD /1w  ✓
weekly with one skip         [1,1,2,1,1]   1   0   0.80   2      true   true   true      true   CARD /1w  ✓
weekly, 6wk of NO planning   [1,1,1,1,1]   1   0   1.00   1      true   true   true      true   CARD /1w  ✓  (holiday)
abandoned 5 months ago       [1,1,1,1]     1   0   1.00   1      true   FALSE  true      true   no card   ✓
roast chicken pre-vegetarian [1,1,1,1,1,1] 1   0   1.00   1      true   FALSE  true      true   no card   ✓
3-weekly, due                [3,3,3,3]     3   1   1.00   3      true   true   true      true   CARD /3w  ✓
3-weekly, NOT due            [3,3,3,3]     3   1   1.00   3      true   true   true      FALSE  no card   ✓
monthly                      [4,4,4,4]     4   1   1.00   4      true   true   true      true   CARD /4w  ✓
5-weekly (out of range)      [5,5,5,5]     4   1   1.00   5      FALSE  true   true      true   no card   ✓  (median>4)
duplicate week docs merged   [1,1,1,1,1,1] 1   0   1.00   1      true   true   true      true   CARD /1w  ✓
```

Note `[1,1,4,1]` (R1's required case): `fit` is exactly 0.75 and **passes**; it is `maxGap 4 > 2·1+1` that rejects it. Both gates are load-bearing; neither alone suffices.

Note `[1,1,1,1]` appears twice with opposite verdicts, distinguished only by `calWeeksSinceLast` (1 vs 21). That is the whole point of the freshness gate.

### 8.2 `snapToSunday` — executed, all pass

```
'2026-08-16'                 -> '2026-08-16'   (already Sunday)
'2026-08-15T14:00:00.000Z'   -> '2026-08-16'   (legacy east-of-Greenwich Saturday)
'2026-02-07T11:00:00.000Z'   -> '2026-02-08'   ┐ the two REAL duplicate docs from
'2026-02-08T08:00:00.000Z'   -> '2026-02-08'   ┘ list/index.ts's legacy path — they MERGE
'2026-08-17'                 -> '2026-08-16'   (stray Monday key snaps back)
'garbage'                    -> null
''                           -> null
```
Plus: year boundary `days('2025-12-28','2026-01-04') === 7`; US spring-forward `days('2026-03-01','2026-03-08') === 7`; leap year `days('2028-02-20','2028-02-27') === 7`.

### 8.3 `dishKey` — executed, all pass

```
''                -> null      'Dinner'          -> null      'Easy Dinner'  -> null
'Leftovers'       -> null      'Leftover Night'  -> null      'The Usual'    -> null   (JUNK)
"Mum's Lasagne"   -> 'mum lasagne'      'Mums Lasagne' -> 'mum lasagne'      ← MERGE
"Dad's Chili"     -> 'dad chili'
'Curries'         -> 'curry'            'Curry'        -> 'curry'            ← MERGE
'Fries'           -> 'fry'              'Fry'          -> 'fry'              ← MERGE
'Hummus'          -> 'hummus'           'Couscous'     -> 'couscous'         (irregular, preserved)
'Tacos'           -> 'taco'             'Noodles'      -> 'noodle'
'Spag Bol!!'      -> 'spag bol'         'Spag Bol'     -> 'spag bol'         ← MERGE
'Spaghetti Bolognese' -> 'spaghetti bolognese'                               ← does NOT merge with 'spag bol' (documented)
"Dave's thing"    -> 'dave thing'       (survives, but produces no card — no bound recipeId)
'Chick'           -> 'chick'            (mid-typing prefix; no bound recipe, no card)
```

### 8.4 Form resolution — head-noun-last, executed

```
'fish taco'            -> tacos          'taco soup'         -> soup or stew
'pasta salad'          -> salad          'chicken curry soup'-> soup or stew
'salmon traybake'      -> traybake       'curry fried rice'  -> rice bowl
'chicken katsu curry'  -> curry          'mum lasagne'       -> pasta
'dad chili'            -> chili          'noodle'            -> pasta
'dave thing'           -> null           'fry'               -> null
```
**Round-trip assertion:** every key in `FORM_TOKENS` must satisfy `dishKey(key) === key`. This is the test that stops `'tacos'` sitting in the map, never matching, and failing invisibly (R1-G3).

### 8.5 Digest and window

- **Empty-name meals** (`{id, listId, name: ''}` from `handleAddMeal`, `list.tsx:401–408`) do not create a dishKey, do not appear in any `DishStat`, and do not count the week as planned.
- **Future weeks excluded.** A list at `targetWeek + 7d` holding the dish is absent from `plannedWeeks` and from `occ`, and its dishKeys appear in neither `weeksObserved` nor `receipts.dates`; `gapToTarget` is never negative.
- **Window boundary.** A legacy list stored as `'2026-02-14T13:00:00.000Z'` whose real week is `2026-02-15` is included when `windowStart === '2026-02-15'` (because the query starts one day earlier and the code filters on the canonical key).
- **Duplicate-week merge.** Two list docs canonicalising to the same weekKey, both holding the dish, produce **one** occurrence, not two.
- **Two housemates, same week, same dish** (one from cookbook with `recipeId` + `dayOfWeek: 'Tuesday'`, one typed with `dayOfWeek: 'Friday'`): exactly one occurrence; the survivor is the one with `recipeId`; `dow` tallies one vote, not two.
- **`joinedAt` clamp.** A member with `joinedAt` 3 weeks ago sees `windowStart` clamped; a dish planned 10 weeks ago yields no occurrences for them.
- **`groupStats` gate.** With `plannedWeeks < 6` in window, `getTrendProfile` returns `tier:'none'` and **`adminRtdb.ref('lists/...')` is never called** (assert with a spy).

### 8.6 recipeId binding and eligibility

- 4 free-typed "Chicken Curry" weeks + 1 with recipe B → no majority (1 < ⌈5/2⌉ = 3) → **no card**, no receipts.
- 3 occurrences with recipe A + 2 free-typed → majority (3 ≥ 3) → card bound to A.
- 2 with recipe A, 2 with fork-of-A → both resolve to root A → majority → card bound to A.
- `dietaryNeeds: ['vegetarian']` + a card recipe tagged `['comfort food']` → **dropped**.
- `dislikedIngredients: 'mushrooms'` + a card recipe with an ingredient `chestnut mushrooms` → **dropped**.
- `recipeFeedback/{root}.rating === 'disliked'` → dropped from REPEAT **and** from riff eligibility.

### 8.7 Endpoint / integration

- `GET /meal/trends` with a `listId` whose `weekStart` is a past week → `{tier:'none'}`.
- Every internal throw → 200 with `{tier:'none'}`. The endpoint must never 500.
- `POST /meal/suggest` with **no** `groupId`/`listId`/`trend` → byte-identical response shape to today (older-client regression test).
- `POST /meal/suggest` with `trend.riffRecipeId` pointing at a recipe the caller neither owns in their cookbook nor has in their group digest → riff silently dropped, three fresh suggestions returned.
- The riff seed's name is **absent** from the avoid list, and every trend card name is **present** in it.
- Trend card names are **absent** from `users/{uid}.mealSuggestions.recentTitles` after the call; the riff's returned name is **present**.
- Two `slot:'riff'` recipes in one response → first kept, rest demoted to fresh.
- `validateRiffSubnote`: over 120 chars → null; missing source name → null; contains a digit → null; contains `!` → null; `"Because you liked \"Chicken Katsu Curry\"."` → passes.
- Riff verification: `Chicken Parmesan → Eggplant Parmesan` **rejected** by the name guard (symmetric difference = 2 tokens… assert the substring rule catches "Parmesan" containment: `norm('Eggplant Parmesan')` does not contain `norm('Chicken Parmesan')`, so this is caught by the top-3 signature-ingredient rule and the Jaccard rule — pin the exact ingredient lists in the test).

### 8.8 Mobile (manual, on a real build)

1. Re-roll on the results step: YOUR USUALS stays mounted and a ticked usual stays ticked.
2. Tick one usual **and** two AI cards, tap Add: all three land, no `Alert`, no 409 in the API log, in both orderings.
3. Tap the FAB → Suggest Meal → tick a usual → Add, without ever tapping "Suggest 3 meals": no Claude call is made (assert on the API log).
4. `···` → Not this week → undo row appears → Undo restores the card.
5. Receipts on a 2-member group show **no dates and no weekday**; on a solo group they show both.
6. With a mute set in group A, open the sheet in group B: the same dish still renders.

---

## 9. Reasons this might not work

**REPEAT may simply not earn its slot, and R3-B1's argument is the strongest one against this whole feature.** The FAB in MealPlan view has three items and two are adjacent (`list.tsx:723–745`): "From Cookbook" opens `AddFromCookbookModal`, which searches name *and* tags (`:87–94`) and adds on a single tap with no confirm step (`:96–109`). That's three taps over the whole cookbook. The REPEAT path is five interactions over one server-chosen dish. The card's only defensible value is that it surfaces what you *forgot*, which search cannot do — but if people mostly know what they want, this loses to a search box that already exists. §7's trigger says so explicitly: below 10% add rate, move it to the week-builder rather than tune it.

**The section is invisible for the entire period when a user is deciding whether to keep the app.** It needs 6 planned weeks plus 4 occurrences of one dish — realistically 6–10 weeks of retained use. Accepting an AI suggestion never adds to the cookbook (`handleAddSelectedMeals` calls `saveRecipe` only, never `POST /api/cookbook`), so heavy suggester use doesn't accelerate it either. Every trust and creepiness risk here is borne by the most valuable cohort, and the payoff is invisible to everyone else. That is an argument about priority, not about the gate, and I have not designed it away.

**Requiring a bound `recipeId` for REPEAT costs real coverage.** Fact 9 says free-typed names are frequent and for some users the majority. Those users get a smaller `weeksObserved`-driven form bias and no cards at all. I chose this because it dissolves four separate confidently-wrong-output failures in one line, but it means the feature is weakest for exactly the users whose history is least structured — and there is no metric that will tell us how many people that is until it ships.

**The form lexicon is hand-written and unvalidated against the corpus.** ~140 tokens, 14 forms, no one has histogrammed the actual 143 recipes or the actual free-text meal names. The head-noun-last rule is a linguistic heuristic that will be wrong for some real names; it is only pinned for ~30 cases I chose myself. The failure is silent (no bias) rather than loud (wrong bias), and the unmatched-key log is the only thing that will make a gap visible — so if nobody reads that log, a systematic gap is permanent.

**Per-group is a real limitation, and `GET /api/group` (`group/index.ts:37–48`) auto-creates a "Private" group for everyone**, so nearly every user is in ≥2 groups. If a meaningful number genuinely plan in two, their cadence is split and the honest failure — `occ < 4`, no card — makes the feature look like it isn't learning. Meanwhile the app already answers this question differently elsewhere: `getCookbook` (`cookbook/index.ts:98–149`) computes `lastAte` across *all* the user's groups. Two answers to "when did you last have this" will coexist.

**Cost is asserted, not measured.** `usage.output_tokens` has never been logged on this endpoint. `systemPrompt` assembles to ~2,015 chars ≈ 560 tokens against a 512-token cacheable minimum — a 9% margin — and nobody has verified whether `output_config.format.json_schema` sits inside or outside the cached prefix. `cache_control: {type:'ephemeral'}` has a 5-minute TTL, and at this app's volume consecutive suggest calls are minutes-to-hours apart, so the realistic steady state is a cache **write** on most calls, not a read. Thinking at `effort: 'medium'` is the dominant term and the riff fragment adds a constraint-satisfaction subtask with a numeric budget — precisely the kind of instruction that lengthens it. R2 is right that "flat to +5%" and "we've never logged output tokens" cannot both stand. Hence the instrumentation edit to `claude.ts` in §4: **log for a week before believing anything in this paragraph.**

**The riff is the piece most likely to be cut.** It is the only one of the three kinds that costs tokens, it is disabled for free-text-history users, its subnote is the only model-written string that reaches the UI, and its verification is two heuristics with unmeasured thresholds. If its add rate is under half of REPEAT's, cut it.

**The shared-household semantics remain slightly incoherent, by construction.** History belongs to the group, dismissal state belongs to the user, and the copy says "in this group" rather than "you" whenever there's more than one member — which is honest but flat, and reads as oddly impersonal to the many solo-plus-Private users whose "group" is themselves. The real fix is `addedBy` on `Meal`, which is a data-contract change that yields signal only from the day it ships, and would have made none of this history usable anyway.

**26 weeks cannot learn seasonality.** Chili-in-winter reads as a dish that was regular and then stopped, which is correct behaviour (it drops out on the freshness gate) but means an annual rhythm is unlearnable. 52 weeks doubles an already 96%-wasted read; that trade only becomes affordable after the v2 projection.

**And the two blind spots I know about but cannot close here:** `DELETE /api/group/:id` orphans `lists/{groupId}` forever with no deletion path, and `GET /api/list` runs an unwindowed transaction over the entire `lists/{groupId}` node on every app launch. Neither is caused by this feature. Both are made more consequential by it.