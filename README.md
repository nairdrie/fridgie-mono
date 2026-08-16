# Fridgie

Monorepo for the Fridgie mobile app and its API.

```
apps/
  api/      Bun + Hono API      → deployed via Docker (api.fridgie.ca)
  mobile/   Expo / React Native → built via EAS
packages/
  shared/   The client/server contract, plus the logic both sides need
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
make setup
```

Then add Firebase credentials — **the API exits at startup without them**, since
it loads the service account at import time. Either drop the service-account
JSON at `apps/api/utils/firebase-service-account.json`, or:

```bash
cp apps/api/.env.example apps/api/.env
```

Then run both with live reload:

```bash
make dev
```

That starts the API on `:3000` (prefixed `[api]` output) and Metro in the
foreground so its interactive keys still work. `EXPO_PUBLIC_API_URL` is wired to
your current LAN IP automatically, which is what a physical device needs — pass
`API_URL=...` to override. `make` on its own lists every target, and
`make doctor` reports on your toolchain.

### iOS

```bash
make ios
```

Builds and launches the dev client in the simulator. It needs full Xcode (not
just Command Line Tools) and CocoaPods:

```bash
brew install cocoapods
```

If `xcode-select` points at the Command Line Tools — the default on many
machines, and it makes `xcodebuild` refuse to run — the Makefile aims
`DEVELOPER_DIR` at `/Applications/Xcode.app` on its own and prints a note, so
you don't *need* to do anything. To fix it properly:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

`ios/` is not committed (unlike `android/`); `make ios` generates it via prebuild
on first run, which also means the first build is slow — prebuild, then
`pod install`, then a full compile. After that `make dev` alone is enough: Fast
Refresh handles JS, and you only need to rebuild natively when a native
dependency or `app.json` changes.

Run `make doctor` if any of this looks wrong — it reports what's actually
resolvable rather than what's installed.

Without Xcode, `make ios-build-cloud` builds a dev client through EAS that you
install on a physical iPhone; `make dev` then live-reloads it over the LAN. Note
that Expo Go (`make mobile-go`) will not work for the full app — Google Sign-In
and the other custom native modules need a dev build.

## packages/shared

Consumed as TypeScript **source** — no build step, nothing published. See
[packages/shared/README.md](packages/shared/README.md) for the full rules.

| File | Reaches the bundler? |
|---|---|
| `types.ts` | No — re-exported via `export type *`, fully erased |
| `quantity.ts` | Yes |
| `rank.ts` | Yes |

`types.ts` must stay **type-only** (no `enum`, no `const`, no functions), which
is why `ListView` lives in each app rather than here.

Because `quantity.ts` and `rank.ts` are real runtime modules, the mobile app
lists `packages/shared` in `metro.config.js` `watchFolders` — Metro does not
watch or resolve anything outside the app directory. Everything here must be
environment-neutral: no Bun APIs, no Node built-ins, no `react-native`, no
`firebase`.

These exist because both apps previously had their own copies that drifted: the
two rank modules repaired invalid ranks differently, producing conflicting
orderings for the same list, and the two quantity modules disagreed on plurals,
unit aliases, trailing periods, and rounding.

## Deploying

- **API** — build with Docker using `apps/api` as the build context
  (`docker build apps/api`). The Dockerfile's paths are relative to that context
  and are unchanged from the pre-monorepo layout.
- **Mobile** — run `eas build` from inside `apps/mobile`.
