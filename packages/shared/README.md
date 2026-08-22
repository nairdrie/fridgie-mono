# @fridgie/shared

Types and pure logic shared by `apps/api` (Bun) and `apps/mobile` (Expo).

Consumed as **TypeScript source** — there is no build step and nothing is
published. Each app maps it in its own `tsconfig.json`:

```jsonc
"paths": { "@fridgie/shared/*": ["../../packages/shared/*"] }
```

and the mobile app additionally lists it in `metro.config.js` `watchFolders`,
because Metro doesn't watch or resolve files outside the app directory.

## Rules

1. **Environment-neutral only.** No Bun APIs, no Node built-ins (`fs`, `crypto`),
   no `react-native`, no `firebase`. Pure string/number logic. If it can't run in
   both a Bun server and a React Native JS engine, it doesn't belong here.
2. **`types.ts` must stay type-only.** No `enum`, no `const`, no functions — both
   apps re-export it with `export type *`, which is fully erased, so Metro never
   resolves it. `ListView` lives in each app precisely because an `enum` is a
   runtime value.
3. **Dependencies are declared here** (`package.json`) and installed here. Keep
   the list near-empty; today it's just `lexorank`.

## Contents

| File | Runtime? | Notes |
|---|---|---|
| `types.ts` | no — erased | The client/server data contract |
| `quantity.ts` | yes | parse / convert / format / normalize / aggregate |
| `rank.ts` | yes | LexoRank repair and ordering |
| `mergeList.ts` | yes | three-way merge of a list document |
| `servings.ts` | yes | recipe yield, and scaling quantities to a household |
| `itemText.ts` | yes | canonicalizing grocery item text into a stable key |
| `staples.ts` | yes | what the household always has, and what counts as saying so |
| `cookTimers.ts` | yes | durations mentioned in a recipe step |
| `recipeCategory.ts` | yes | the cookbook's shelves, and guessing one from a title |

`quantity.ts` and `rank.ts` exist because both apps previously had their own
copies that drifted: the two rank modules repaired invalid ranks differently
(producing conflicting orderings for the same list), and the two quantity
modules disagreed on plurals, unit aliases, trailing periods, and rounding.

`mergeList.ts` is here for the same reason before it has happened: two copies
of a conflict-resolution rule would resolve the same conflict differently, and
two devices that disagree about who won never converge. It resolves a list per
ROW and per FIELD rather than picking a winning document — see the header
comment for the rules, and `apps/api/tests/mergeList.test.ts` for each of them
pinned as a test. Today only the client calls it; it lives here so that the
server can adopt the identical rules without a second implementation.

`itemText.ts` was `apps/api/utils/itemMatch.ts` until `staples.ts` needed the
client to derive the same key for a row that the server had counted. Its output
is frozen: those keys are RTDB keys, and every category-cache entry ever written
is stored under them.

`cookTimers.ts` has only a client caller today, like `mergeList.ts` — it lives
here because it is pure logic with real edge cases worth pinning in tests
(`"cut into 2 inch pieces"` must never become a timer).

`recipeCategory.ts` is here because THREE parties have to agree on the same
eleven strings: the model assigns one (the list is an enum in the JSON schema),
the server stores it, and the client draws a filter chip per category. A twelfth
category invented on any one side is a recipe nobody can find. `types.ts` pulls
the union from it with `import type`, which is erased like the rest of that
file.

`servings.ts` follows the same rule as the rest: the recipe is
never rewritten, only the rows it puts on a list are, so a shared recipe means
the same thing to everyone who has it. See its header for why a yield that
counts objects ("makes 12 cookies") is rejected rather than scaled.

The canonical/display split in `quantity.ts` matters: `formatQuantity` is the
**stored** form (singular, `"2 cup"`), `formatQuantityDisplay` is for UI only
(`"2 cups"`). Never persist the display form.
