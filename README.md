# Fridgie

Monorepo for the Fridgie mobile app and its API.

```
apps/
  api/      Bun + Hono API      → deployed via Docker (api.fridgie.ca)
  mobile/   Expo / React Native → built via EAS
packages/
  shared/   Types shared across both apps (compile-time only)
```

## Layout notes

Each app installs its **own** dependencies and keeps its **own** lockfile — this is
deliberately *not* a hoisted npm/bun workspace:

- `apps/api` uses **bun** (`bun.lock`)
- `apps/mobile` uses **npm** (`package-lock.json`)

Hoisting was avoided because the two apps are on different `firebase` majors, and
because Expo/Metro + a committed `android/` prebuild makes hoisted resolution
fragile. `packages/shared` is shared via TypeScript `paths` rather than package
resolution, so Metro and EAS never need to resolve it.

## Getting started

```bash
# API
cd apps/api && bun install && bun dev

# Mobile
cd apps/mobile && npm install && npx expo start
```

## packages/shared

Holds the request/response contract used by both sides. It is imported with
`import type` **only**, so the whole thing is erased at compile time and never
becomes a runtime dependency:

```ts
import type { List, Item, Meal } from '@fridgie/shared';
```

Because of that, `packages/shared` must not contain runtime values — no `enum`,
no `const`, no functions. Use `as const` objects declared locally in the app that
needs them, or a plain union type.

## Deploying

- **API** — build with Docker using `apps/api` as the build context
  (`docker build apps/api`). The Dockerfile's paths are relative to that context
  and are unchanged from the pre-monorepo layout.
- **Mobile** — run `eas build` from inside `apps/mobile`.
