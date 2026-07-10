# Citadel Development Guide

## Commands
- **Package manager**: bun (`bun.lockb` is the only lockfile). Never install with pnpm/npm — a foreign install rewrites node_modules and corrupts Vite's optimize cache.
- **Production build**: `bun run build` (builds frontend then backend via Tauri)
- **Dev mode**: `bun run dev` (starts Tauri app with hot reload)
- **Format**: `bun format` (formats both frontend & backend). Always use this instead of `cargo fmt`, which only formats the root crate and misses workspace members like `libcalibre`.
- **Lint**: `bun lint` (lints both)
- **Test**: `cargo test` (for Rust), `vitest` or `bun test` (for frontend)
- **Run single test**: `cargo test test_name` or `vitest run path/to/test.ts`

## Architecture
- **Tauri app**: Backend in Rust (src-tauri/), frontend in React/TypeScript (src/)
- **libcalibre**: Internal library for Calibre database operations (SQLite via Diesel ORM)
- **Main binary**: citadel-rs, runs embedded in Tauri
- **Tauri commands**: Tauri commands in `src-tauri/src/libs/calibre/{command,query}.rs` expose API to frontend
- **Tauri state**: Global state managed via CitadelState in `src-tauri/src/state.rs`
- **Database**: SQLite Calibre library, schema in `src-tauri/libcalibre/src/schema.rs`, migrations via diesel_migrations

## Code Style

### Rust

- Follow existing Rust idioms; use `Result<T, String>` for Tauri commands
- Imports: Group std, external crates, then internal modules
- Error handling: Use `thiserror` in libcalibre, map to String in Tauri layer
- Naming: snake_case functions, CamelCase types, prefix commands with `clb_cmd_` or `clb_query_`
- Types: Use specta derive for TS bindings on all Tauri command types
- No comments unless complex; keep code self-documenting

### TypeScript

- Imports: Use `type` keyword for type-only imports; group by `type` imports first, then value imports; use `@/` alias for src imports
- Types: Use `interface` for object shapes, `type` for unions/intersections; make generic names descriptive, e.g. `TDeviceType` instead of `D`
- Naming: camelCase functions/variables, PascalCase components/types, SCREAMING_SNAKE_CASE for const objects used as enums
- Components: Export as named exports (not default); use functional components with destructured props typed via interface
- Enums: Use `as const` objects instead of enums (e.g., `const AuthorSortOrder = { nameAz: "name-asc" } as const`)
- Structure: Organize as atoms/molecules/organisms for components; put hooks in `lib/hooks/`, services in `lib/services/`
- Async: Use `async`/`await`; check Tauri command results for `status === "error"` before accessing `data`
- Strict mode: `strictNullChecks` and `noUncheckedIndexedAccess` enabled; always handle undefined/null cases
- Use functional programming concepts
- Prefer Rust-style safety, utility types like Result and Option
- **Functional core, imperative shell**: Components should be pure renderers. Extract all behavior (API calls, async operations, state machines) into custom hooks or service modules. Components receive state and callbacks, nothing more.

## Driving the app for e2e verification (agents)

Debug builds embed `tauri-plugin-webdriver-automation` (registered debug-only in
`src-tauri/src/main.rs`). When the app runs via `bun run dev`, it prints
`[webdriver] listening on port <N>` (dynamic port, changes on every Rust
rebuild). POST JSON to `http://127.0.0.1:<N>` to drive the live app fully in
the background — no window focus, no macOS permissions:

- `/element/find` `{"using":"css","value":"..."}`, `/element/click`,
  `/element/text`, `/navigate/current`, `/screenshot` (base64 PNG),
  `/script/execute` (runs in the app's main JS world)
- Do NOT use `/element/send-keys` on React controlled inputs — it updates
  React's value tracker without firing onChange. Instead use `/script/execute`
  with the `HTMLInputElement.prototype` value-setter + dispatched `input` event.
- Plugin screenshots are WKWebView snapshots: light-scheme, no vibrancy or
  translucent sidebar — fine for layout/DOM checks, not for visual fidelity.
- Full endpoint list: https://github.com/danielraffel/tauri-webdriver/blob/main/SPEC.md

`tauri-wd` (W3C WebDriver CLI for WebDriverIO suites) launches its own app
instance — never run it while `bun run dev` is up; two instances fight over the
settings store and library database.

Endpoint response shapes differ: `/screenshot` returns `{"data": "<base64>"}`
while `/script/execute` returns `{"value": ...}`.

## Testing first-run / onboarding states (dev build)

The dev build's settings live at `~/Library/Application Support/
software.everydaythings.citadel.dev/settings.json` (separate bundle id from
prod). Back the file up, edit, test, restore byte-exact — and quit the app
before each edit, since the app persists settings on change:

- Fresh run: set `activeLibraryId` to `""` → boot decision runs detection.
- No-detection chooser: also rename `~/Library/Preferences/calibre/
  global.py.json` aside (restore immediately); detection falls back to
  `~/Calibre Library`, so that must not exist either.
- Broken path: add a `libraryPaths` entry pointing at a nonexistent folder and
  make it active.
- A valid throwaway library for adopt/recovery tests: unzip
  `src-tauri/resources/empty_7_2_calibre_lib.zip` into a temp dir.

Vite HMR keeps the first-run flow's in-memory state across frontend edits, so
a running card can be restyled and re-screenshotted without replaying the
flow. Settings changes need an app restart to be picked up.

## macOS permissions (TCC)

Reading `~/Library/Preferences/**` from the app process (e.g. Calibre's
`global.py.json` for library detection) triggers no TCC prompt and needs no
entitlement — Preferences is not a TCC-protected location for non-sandboxed
apps. Verified empirically 2026-07-10 (CDL-19): the read succeeded in a live
debug build with zero `com.apple.TCC` log events at the moment of access.
TCC-protected user folders are Desktop/Documents/Downloads and app data like
Photos or Mail. When checking, use `/usr/bin/log show --predicate 'subsystem ==
"com.apple.TCC"'` — bare `log` is a zsh builtin that silently shadows it.

## SQLite on macOS persists WAL sidecars

Citadel links Apple's system SQLite (`/usr/lib/libsqlite3.dylib`), which
enables `SQLITE_FCNTL_PERSIST_WAL` by default: `-wal`/`-shm` sidecars survive
a clean close of the last connection, for every WAL database and every
connection (verified empirically 2026-07-10, CDL-19 — even `/usr/bin/sqlite3`
leaves them). No connection-level dance (`PRAGMA query_only` off, explicit
`wal_checkpoint`, even `journal_mode=DELETE`) removes both files; a connection
that ever set `query_only=ON` additionally never checkpoints at close. Don't
write tests asserting sidecar deletion — assert the database file's bytes are
unchanged and tolerate the two sidecars. Calibre-managed libraries are
journal-mode and stay fully byte-clean under read-only access.
