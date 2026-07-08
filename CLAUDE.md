# CLAUDE.md

Guidance for Claude Code working in this repo.

## Project shape

Single package in `server/` (no root workspace). **All commands run from `server/`, not the repo root.**

## Commands

```bash
npm run dev      # tsx watch, auto-loads .env (--env-file-if-exists). Default PORT=3001.
npm run build    # tsc --build
npm run sync     # one-shot: fetch vehicle encyclopedia (WG) + WN8 expected values (XVM) into the DB
npm test         # placeholder, no tests yet
npx prisma migrate dev --name <name>   # create+apply migration (reads prisma.config.ts)
npx prisma generate                     # regenerate client into generated/prisma
npx tsc --noEmit                        # typecheck without emitting
npx eslint . | npx prettier --check .   # lint / format check (no npm scripts wired)
```

## Architecture

Express app with routes defined inline in `src/app.ts`; shared infra in `src/lib/`. Responses go through `lib/http.ts` envelope helpers (`sendResult` / `sendApiError`) and errors through `lib/middleware.ts`'s `apiErrorHandler` — **new routes must use these, not hand-rolled `res.status(...).json(...)`**.

Lib modules (role + the non-obvious constraint; read the source for algorithms):

- `prisma.ts` — singleton `PrismaClient` via `@prisma/adapter-better-sqlite3`; imports generated client from `../../generated/prisma/client.js`.
- `http.ts` — envelope helpers. `sendResult` promotes envelope `code` to HTTP status only for 5xx and `INSUFFICIENT_HISTORY` (422); otherwise HTTP 400 (so validation code 402 doesn't become HTTP 402).
- `middleware.ts` — Express 5 error handler; honors `err.status`/`err.statusCode` so client errors aren't mislabeled 5xx, else 500.
- `wargaming.ts` — TTL-cached proxies for WG `account/list`, `account/info`, `tanks/stats`, and `encyclopedia/vehicles`. All exports are arrow-function `const` — **match this for new exports**. **Throws at import time if `WARGAMING_APPLICATION_ID` is unset** (server won't boot). **NA realm → `api.worldoftanks.com`, not `.na`.** Two enrollment points: `getPlayerInfo` upserts `TrackedAccount` only when WG has the account (`data[accountId]` non-null); `getPlayerVehicles` upserts only on a non-empty tanks/stats array (an empty array is ambiguous: unknown id vs. brand-new account). Cache hits don't re-upsert.
- `stats.ts` / `wn8.ts` — trailing-window deltas (7/14/30 only, `VALID_RANGES`). Capture-on-query with `CAPTURE_DEDUP_MS` (5 min) throttle; reuse a fresh snapshot as "current" else force-refresh + capture. Snapshots older than `SNAPSHOT_GC_DAYS` (45) are GC'd. Delta falls back to the oldest past snapshot when none is `>= days` ago; `INSUFFICIENT_HISTORY` (422) only when **no** past snapshot exists. `wn8.ts` stores per-tank counters as one JSON blob per capture and excludes tanks missing from `VehicleExpectedValue` entirely. Both reuse `CAPTURE_DEDUP_MS` / `SNAPSHOT_GC_DAYS` / `isValidRange` from `stats.ts`.
- `vehicles.ts` — reference-data ingestion (not a request path): `Vehicle` table from WG encyclopedia, `VehicleExpectedValue` from **XVM** (`static.modxvm.com`, not WG — WG doesn't expose expected values).
- `scheduler.ts` — daily capture job, **off by default** (`SNAPSHOT_JOB_ENABLED=true`).

Routes are defined inline in `src/app.ts` — read it for the full list. `:accountId` parsing is shared via `parseAccountIdParam`. Admin endpoints: `POST /admin/snapshots/run`, `/admin/vehicles/refresh`, `/admin/wn8/refresh-expected`.

### Prisma setup (non-default)

- Prisma **7** with `prisma.config.ts` (not just a schema); it loads `dotenv/config` so CLI commands pick up `DATABASE_URL` from `.env`.
- Generator output is `generated/prisma` (gitignored). The app imports the generated client directly — a stale dir breaks build/runtime. **Gotcha:** `prisma migrate dev` doesn't always regenerate the client here — if a new model isn't visible to TS after migrating, run `npx prisma generate` explicitly.
- SQLite (`file:./dev.db`); `*.db` gitignored.

### Environment

`.env` loaded via `dotenv/config` at the top of each entrypoint. Required: `DATABASE_URL`, `WARGAMING_APPLICATION_ID`, `WARGAMING_REALM` (default `eu`), `WARGAMING_CACHE_TTL_SECONDS` / `WARGAMING_INFO_CACHE_TTL_SECONDS` / `WARGAMING_VEHICLES_CACHE_TTL_SECONDS` (default `3600`). Optional: `SNAPSHOT_JOB_ENABLED` (`true` to enable the daily capture interval).

## TypeScript conventions (strict, easy to trip on)

`tsconfig.json` enables `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`:

- **`verbatimModuleSyntax`**: use `import type` for type-only imports; never mix a value and type in one import without the `type` modifier on the type.
- **`noUncheckedIndexedAccess`**: indexing an array/record yields `T | undefined`; guard or narrow.
- **`exactOptionalPropertyTypes`**: don't assign `undefined` to an optional property — omit the key or provide a real value.
- **`noUncheckedSideEffectImports`**: bare side-effect imports (`import 'dotenv/config'`) must resolve to a real module — a missing/misnamed module breaks the build.
- ESM (`"type": "module"`, `moduleResolution: "bundler"`): relative imports use explicit `.js` extensions (e.g. `import { prisma } from "./lib/prisma.js"`).

## Style

Prettier: no semicolons, single quotes, 2-space indent, trailing commas (es5). ESLint only enforces `prefer-const: 'error'` (plus `eslint-config-prettier`); the no-semicolon style comes from Prettier. Match the surrounding no-semicolon style.