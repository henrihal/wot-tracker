# CLAUDE.md

Guidance for Claude Code working in this repo.

## Project shape

Single package in `server/` (no root workspace). **Run all commands from `server/`, not the repo root.**

## Commands

```bash
npm run dev      # tsx watch, auto-loads .env. PORT=3001 default.
npm run build    # tsc --build
npm run sync     # one-shot: fetch WG vehicle encyclopedia + XVM WN8 expected values into DB
npm test         # placeholder, no tests yet
npx prisma migrate dev --name <name>   # create+apply migration (reads prisma.config.ts)
npx prisma generate                     # regenerate client into generated/prisma
npx tsc --noEmit                        # typecheck
npx eslint . | npx prettier --check .   # lint / format check (no npm scripts wired)
```

## Architecture

Express app: routes inline in `src/app.ts`, infra in `src/lib/`, one-shot scripts in `src/scripts/` (`sync.ts` is the `npm run sync` target). All responses use `lib/http.ts` (`sendResult`/`sendApiError`) and errors flow through `lib/middleware.ts`'s `apiErrorHandler` — **no hand-rolled `res.status(...).json(...)`**. Exception: `/health` returns raw `res.json` on success (liveness probe); leave it.

Lib modules (role + non-obvious constraint; read source for algorithms):

- `prisma.ts` — singleton `PrismaClient` via `@prisma/adapter-pg`, imports generated client from `../../generated/prisma/client.js`. Throws at import if `DATABASE_URL` unset.
- `http.ts` — `sendResult` maps envelope `code` → HTTP status only for 5xx and `INSUFFICIENT_HISTORY` (422); else 400 (so validation code 402 stays 400, not 402).
- `middleware.ts` — Express 5 error handler; honors `err.status`/`err.statusCode`, else 500.
- `adminAuth.ts` — guards `/admin/*` via `X-Admin-Token` vs `ADMIN_TOKEN`. **Fail-closed:** unset `ADMIN_TOKEN` → 503 on every admin route. Timing-safe compare.
- `wargaming.ts` — TTL-cached WG proxies (`account/list`, `account/info`, `tanks/stats`, `encyclopedia/vehicles`). All exports are arrow-function `const` — **match this**. **Throws at import if `WARGAMING_APPLICATION_ID` unset**. **NA realm → `api.worldoftanks.com`, not `.na`.** Enrollment: `getPlayerInfo` upserts `TrackedAccount` only when WG has the account (`data[accountId]` non-null); `getPlayerVehicles` upserts only on a non-empty tanks/stats array. Cache hits don't re-upsert.
- `stats.ts` / `wn8.ts` — trailing-window deltas (7/14/30, `VALID_RANGES`). Capture-on-query with `CAPTURE_DEDUP_MS` (5 min) throttle; reuse a fresh snapshot as "current" else force-refresh + capture. Snapshots older than `SNAPSHOT_GC_DAYS` (45) GC'd. Delta falls back to oldest past snapshot when none is `>= days` ago; `INSUFFICIENT_HISTORY` (422) only when **no** past snapshot exists. `wn8.ts` stores per-tank counters as one JSON blob per capture and excludes tanks missing from `VehicleExpectedValue`. Both reuse `CAPTURE_DEDUP_MS`/`SNAPSHOT_GC_DAYS`/`isValidRange` from `stats.ts`.
- `vehicles.ts` — reference-data ingestion (not a request path): `Vehicle` from WG encyclopedia, `VehicleExpectedValue` from **XVM** (`static.modxvm.com` — WG doesn't expose expected values).
- `scheduler.ts` — daily capture job, **off by default** (`SNAPSHOT_JOB_ENABLED=true`).

Routes (`src/app.ts`): `GET /health`; `/players/search?search=`; `/players/:accountId` (WG `account/info`); `/players/:accountId/stats?range=7|14|30`; `/players/:accountId/stats/summary?ranges=7,14,30`; `/players/:accountId/vehicles`; `/players/:accountId/wn8[?range=]` (current WN8 if no range, else delta); `/players/:accountId/wn8/summary?ranges=`. Admin: `POST /admin/snapshots/run`, `/admin/vehicles/refresh`, `/admin/wn8/refresh-expected` (gated by `X-Admin-Token`). Several player routes accept `?forceRefresh=true` to bypass WG cache.

Helpers: `:accountId` via `parseAccountIdParam`; `?range`/`?ranges` via `parseRange`/`parseRanges` (deduped, order-preserving subset of 7/14/30; `?ranges` defaults to all three).

### Prisma setup (non-default)

- Prisma **7** with `prisma.config.ts` (loads `dotenv/config` so CLI picks up `.env`). CLI uses `DIRECT_DATABASE_URL` if set, else `DATABASE_URL` — set `DIRECT_DATABASE_URL` when `DATABASE_URL` is pooled/PgBouncer (no migrations over pooling).
- Generator output `generated/prisma` (gitignored); app imports the client directly — stale dir breaks build/runtime. **Gotcha:** `prisma migrate dev` doesn't always regenerate the client — if a new model isn't visible to TS, run `npx prisma generate`.
- **Postgres**, adapter `@prisma/adapter-pg`. Migrations squashed into one `20260718140129_init`; don't recreate old per-model migrations.

### Environment

`.env` loaded via `dotenv/config` at top of each entrypoint. Required: `DATABASE_URL`, `WARGAMING_APPLICATION_ID`, `WARGAMING_REALM` (default `eu`), `WARGAMING_CACHE_TTL_SECONDS` / `WARGAMING_INFO_CACHE_TTL_SECONDS` / `WARGAMING_VEHICLES_CACHE_TTL_SECONDS` (default `3600`). Optional: `DIRECT_DATABASE_URL`, `SNAPSHOT_JOB_ENABLED` (`true` → daily capture), `ADMIN_TOKEN` (**unset → all admin routes 503**). See `.env.example` for the two DB modes.

### Docker

`server/Dockerfile`, multi-stage `node:22-alpine`: build runs `prisma generate` + `tsc --build` → `dist/`; runtime installs prod deps + `prisma` + `tsx`, runs `prisma migrate deploy` (retry loop) then `node --import tsx dist/src/app.js`. **`tsx` required at runtime** — Prisma 7's generated client is TS with extensionless ESM imports plain `node` can't resolve. `EXPOSE 3001`. `.dockerignore` excludes `generated/`, `dist/`, `.env*`, `*.db`.

## TypeScript conventions (strict, easy to trip on)

`tsconfig.json`: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`:

- **`verbatimModuleSyntax`**: `import type` for type-only imports; never mix value + type without `type` on the type.
- **`noUncheckedIndexedAccess`**: indexing yields `T | undefined`; guard or narrow.
- **`exactOptionalPropertyTypes`**: don't assign `undefined` to optional props — omit the key or give a real value.
- **`noUncheckedSideEffectImports`**: `import 'dotenv/config'` must resolve to a real module or the build breaks.
- ESM (`"type": "module"`, `moduleResolution: "bundler"`): relative imports use `.js` extensions (e.g. `./lib/prisma.js`).

## Style

Prettier: no semicolons, single quotes, 2-space indent, trailing commas (es5). ESLint enforces only `prefer-const: 'error'` (+ `eslint-config-prettier`); no-semicolon style comes from Prettier. Match surrounding no-semicolon style.