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

`quantity.ts` and `rank.ts` exist because both apps previously had their own
copies that drifted: the two rank modules repaired invalid ranks differently
(producing conflicting orderings for the same list), and the two quantity
modules disagreed on plurals, unit aliases, trailing periods, and rounding.

The canonical/display split in `quantity.ts` matters: `formatQuantity` is the
**stored** form (singular, `"2 cup"`), `formatQuantityDisplay` is for UI only
(`"2 cups"`). Never persist the display form.
