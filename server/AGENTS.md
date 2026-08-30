# Server Agent Guide — wot-stat-server

Express 5 + TypeScript (strict ESM) + Prisma 7 (`@prisma/adapter-pg`) + PostgreSQL REST API that proxies Wargaming and keeps local snapshot history for 7/14/30-day stat and WN8 deltas. Single package — **run all commands from `server/`**, not the repo root.

## Commands

```bash
npm run dev      # tsx watch, auto-loads .env; PORT=3001 default
npm run build    # tsc --build
npm run sync     # one-shot: WG vehicle encyclopedia + XVM WN8 expected values
npx prisma migrate dev --name <name>   # create+apply migration
npx prisma generate                     # regenerate client into generated/prisma
npx tsc --noEmit                        # typecheck — run after any change
npx eslint . && npx prettier --check .  # lint / format (no npm scripts wired)
```

`npm test` is a placeholder (no tests). Migrations are squashed into one `20260718140129_init` — add new ones, don't recreate old per-model migrations.

## Hard rules

1. All responses go through `lib/http.ts` (`sendResult`/`sendApiError`); thrown errors flow to `lib/middleware.ts`'s `apiErrorHandler`. **No hand-rolled `res.status(...).json(...)`** — sole exception: `/health` returns raw `res.json` on success (liveness probe).
2. `lib/wargaming.ts` exports are arrow-function `const`s — match that style.
3. Envelope `code` ≠ HTTP status: `sendResult` promotes it only for 5xx and `INSUFFICIENT_HISTORY` (422); validation stays envelope 402 / HTTP 400.
4. Admin is fail-closed: unset `ADMIN_TOKEN` → 503 on every `/admin/*` (timing-safe compare in `lib/adminAuth.ts`).
5. After any `prisma/schema.prisma` change run `npx prisma generate` — `generated/prisma` is gitignored; a stale dir breaks build/runtime, and `migrate dev` doesn't always regenerate. The app imports the client from `../../generated/prisma/client.js`.

## TypeScript conventions (strict — easy to trip on)

- ESM: relative imports need `.js` extensions. `verbatimModuleSyntax`: `import type` for type-only imports.
- `noUncheckedIndexedAccess`: indexing yields `T | undefined` — guard or narrow.
- `exactOptionalPropertyTypes`: omit optional keys, never pass `undefined`.
- `noUncheckedSideEffectImports`: `import 'dotenv/config'` sits at the top of every entrypoint and must resolve.

## Architecture

Routes inline in `src/app.ts`; infra in `src/lib/`; one-shot scripts in `src/scripts/` (`sync.ts` = `npm run sync`). Helpers: `parseAccountIdParam` (positive int), `parseRange`/`parseRanges` (deduped, order-preserving subset of 7/14/30; `?ranges` defaults to all three). Route tables live in the root README.

- `prisma.ts` — singleton client; throws at import if `DATABASE_URL` unset.
- `http.ts` / `middleware.ts` — envelope helpers; Express 5 error handler (honors `err.status`/`err.statusCode`, else 500).
- `adminAuth.ts` — `X-Admin-Token` guard.
- `wargaming.ts` — TTL-cached WG proxies; throws at import if `WARGAMING_APPLICATION_ID` unset. NA realm → `api.worldoftanks.com`, not `.na`.
- `stats.ts` / `wn8.ts` — trailing-window deltas; share `CAPTURE_DEDUP_MS` (5 min), `SNAPSHOT_GC_DAYS` (45), `isValidRange` from `stats.ts`.
- `vehicles.ts` — reference-data ingestion: `Vehicle` from WG encyclopedia, `VehicleExpectedValue` from XVM (`static.modxvm.com` — WG doesn't expose expected values).
- `scheduler.ts` — daily capture job, off unless `SNAPSHOT_JOB_ENABLED=true`.

## Non-obvious semantics

- **Enrollment is implicit:** `getPlayerInfo` upserts `TrackedAccount` only when WG has the account; `getPlayerVehicles` only on a non-empty tanks array. Cache hits don't re-upsert.
- **Deltas** = `current − nearestPast`; falls back to the oldest past snapshot when none is old enough; `INSUFFICIENT_HISTORY` (422) only when **no** past snapshot exists. The read path reuses a snapshot < 5 min old as "current", else force-refreshes WG and captures.
- **WN8:** per-tank counters stored as one JSON blob per capture; account WN8 applies the formula **once to aggregates** (not a mean of per-tank scores); tanks missing from `VehicleExpectedValue` are excluded.

## Environment

Required: `DATABASE_URL`, `WARGAMING_APPLICATION_ID`. Optional: `WARGAMING_REALM` (default `eu`), three `WARGAMING_*_CACHE_TTL_SECONDS` (default 3600), `DIRECT_DATABASE_URL` (set when `DATABASE_URL` is pooled/PgBouncer — no migrations over pooling), `SNAPSHOT_JOB_ENABLED`, `ADMIN_TOKEN`, `PORT`. Full table in the root README.

## Docker

Multi-stage `node:22-alpine`: build = `prisma generate` + `tsc --build` → `dist/`; runtime = prod deps + `prisma` CLI, retry-loop `prisma migrate deploy`, then plain `node dist/src/app.js` (no tsx at runtime). `ENV PORT=5001`, `EXPOSE 5001`.
