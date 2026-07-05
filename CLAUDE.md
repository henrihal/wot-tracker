# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

Single package in `server/` (no root workspace). All commands below run from `server/`, not the repo root.

## Commands

```bash
npm run dev      # tsx watch, auto-loads .env (--env-file-if-exists). Default PORT=3001.
npm run build    # tsc --build
npm test         # placeholder, no tests yet
npx prisma migrate dev --name <name>   # create+apply migration (reads prisma.config.ts)
npx prisma generate                     # regenerate client into generated/prisma
npx tsc --noEmit                        # typecheck without emitting
npx eslint .        # lint (no npm script wired)
npx prettier --check .   # format check (no npm script wired)
```

## Architecture

Express app (`src/app.ts`) with routes defined inline; shared infrastructure lives in `src/lib/`. Four lib clients today:

- `lib/prisma.ts` — singleton `PrismaClient` using the `@prisma/adapter-better-sqlite3` adapter. Imports the generated client from `../../generated/prisma/client.js`.
- `lib/wargaming.ts` — caching middleman for Wargaming APIs. Two endpoints today:
  - `searchPlayers(search, { forceRefresh })` — proxies `account/list`. TTL cache via `PlayerSearchCache` keyed by `[search, realm]`; only `status: "ok"` responses are cached, errors are always re-fetched. TTL comes from `WARGAMING_CACHE_TTL_SECONDS`.
  - `getPlayerInfo(accountId, { forceRefresh })` — proxies `account/info`. TTL cache via `PlayerInfoCache` keyed by `[accountId, realm]` (has `expiresAt`); on a miss/expiry it requests all public `statistics.*` extras (see `PUBLIC_EXTRA_FIELDS`) so the cached row is complete. `private.*` extras require an access_token and are not fetched (no auth flow). `forceRefresh` re-fetches and overwrites the row (bumping `fetchedAt` and `expiresAt`). TTL comes from `WARGAMING_INFO_CACHE_TTL_SECONDS`.
  - Both follow arrow-function `const` style (no `function` declarations) — match this when adding new exports. Realm/app id are resolved once at module load; `WARGAMING_APPLICATION_ID` unset throws at import time. `REALM` and `Realm` type are exported for reuse by `lib/stats.ts`.
- `lib/stats.ts` — trailing-window stat deltas. `getStatsDelta(accountId, days)` reuses a `PlayerStatsSnapshot` captured within the last `CAPTURE_DEDUP_MS` (5 min) as "current"; only when no fresh snapshot exists does it force-refresh `account/info` and capture a new snapshot (via `captureSnapshotIfStale`). This throttles Wargaming API calls to one per 5 min per account. Then GCs this account's snapshots older than `SNAPSHOT_GC_DAYS` (45) and subtracts a past snapshot (`computeDelta`, negatives clamped to 0): prefers the nearest one at `>= days` ago, else falls back to the oldest available past snapshot so a best-available diff is always returned when any history exists (`from` records the anchor actually used). Returns `INSUFFICIENT_HISTORY` (422) only when no past snapshot exists at all. Snapshots store a fixed allowlist (`CORE_FIELDS`) of `statistics.all.*` + `statistics.random.*` counters as JSON. `lastBattleTime` (WG `last_battle_time`) is captured alongside; when unchanged vs. the previous snapshot the row is skipped to avoid storing identical counters. Also exports `getStatsSummary(accountId, days[])` (one shared "current" snapshot fanned out to multiple windows) and `isValidRange` against `VALID_RANGES = [7, 14, 30]`.

### Routes

Defined inline in `src/app.ts`. `GET /health` pings the DB; `GET /players/search` and `GET /players/info` proxy the WG middleman; `GET /players/:accountId/stats?range=` and `GET /players/:accountId/stats/summary?ranges=` compute trailing-window deltas (ranges constrained to 7/14/30). `/players/info` and both stats endpoints upsert the account into `TrackedAccount`, which is the work list the daily capture job iterates — so queried accounts are auto-enrolled. `POST /admin/snapshots/run` triggers `runCaptureJob()` out of band.
- `lib/scheduler.ts` — optional daily snapshot capture, **disabled by default** (`SNAPSHOT_JOB_ENABLED=true` to enable). `runCaptureJob()` iterates `TrackedAccount`, force-refreshes each, captures a snapshot, then globally GCs; also exposed via `POST /admin/snapshots/run`. `startScheduler()` is a no-op unless enabled.

### Prisma setup (non-default)

- Prisma **7** with a TypeScript config file `prisma.config.ts` (not just a schema). The datasource URL is read from there, which itself loads `dotenv/config` — so Prisma CLI commands pick up `DATABASE_URL` from `.env` automatically.
- Generator output is `generated/prisma` (gitignored). After any schema change, run `prisma migrate dev` (which applies + generates) or `prisma generate` to regenerate; the app imports the generated client directly, so a stale `generated/` dir causes build/runtime errors. **Gotcha:** `prisma migrate dev` does not always regenerate the client in this setup — if a new model isn't visible to TypeScript after migrating, run `npx prisma generate` explicitly.
- Datasource is SQLite (`file:./dev.db`); `*.db` files are gitignored.

### Environment

`.env` is loaded via `dotenv/config` imported at the top of `app.ts`, `lib/prisma.ts`, `lib/wargaming.ts`, `lib/stats.ts`, and `lib/scheduler.ts`. Required vars: `DATABASE_URL`, `WARGAMING_APPLICATION_ID`, `WARGAMING_REALM` (default `eu`), `WARGAMING_CACHE_TTL_SECONDS` (default `3600`), `WARGAMING_INFO_CACHE_TTL_SECONDS` (default `3600`). Optional: `SNAPSHOT_JOB_ENABLED` (`true` to enable the daily capture interval; default off — on-demand capture-on-query is the active path). `lib/wargaming.ts` **throws at import time** if `WARGAMING_APPLICATION_ID` is unset, so the server won't boot without it. Note NA realm maps to `api.worldoftanks.com` (not `.na`).

## TypeScript conventions (strict, easy to trip on)

`tsconfig.json` enables `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax`:

- **`verbatimModuleSyntax`**: use `import type` for type-only imports; never mix a value and type in one import without the `type` modifier on the type.
- **`noUncheckedIndexedAccess`**: indexing an array/record yields `T | undefined`; guard or narrow.
- **`exactOptionalPropertyTypes`**: don't assign `undefined` to an optional property expecting a value — either omit the key or provide a real value.
- ESM (`"type": "module"`, `moduleResolution: "bundler"`): relative imports use explicit `.js` extensions (see existing `import { prisma } from "./lib/prisma.js"`).

## Style

Prettier: no semicolons, single quotes, 2-space indent, trailing commas (es5). ESLint only enforces `prefer-const: 'error'` (plus `eslint-config-prettier` to turn off formatting rules); the no-semicolon style comes entirely from Prettier. Match the surrounding no-semicolon style.