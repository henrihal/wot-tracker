# wot-stat-server

A self-hosted REST API that tracks World of Tanks player statistics over time. It proxies [Wargaming's public API](https://developers.wargaming.net/) for live profile/vehicle data and adds a local snapshot history so you can compute **trailing-window deltas** (7/14/30 days) for battle stats and the **WN8** efficiency rating — things Wargaming's API doesn't expose directly.

Built with Express 5, TypeScript, and SQLite with prisma 7.

## Features

- **Player search & profile:** proxy `account/list` and `account/info` with a TTL read cache.
- **Trailing-window stat deltas:** `current − nearestPast` over 7/14/30 days from locally captured snapshots, with a capture-on-query freshness booster (5-min dedup).
- **WN8 rating:** overall current WN8 plus 7/14/30-day deltas, computed from per-tank counters vs. XVM expected values.
- **Vehicle encyclopedia:** reference data (name, tier, type, nation, premium flag) ingested from the WG encyclopedia.
- **Daily capture scheduler:** optional cron-style job that snapshots all tracked accounts (off by default).
- **Uniform JSON envelope:** every response (success or error) uses the same `{ status, ... }` shape, including 404s.

## Quick start

All commands run from `server/`, not the repo root.

```bash
cd server
cp .env.example .env        # then fill in WARGAMING_APPLICATION_ID
npm install
npx prisma migrate dev      # create the SQLite DB + apply schema
npm run sync                # one-shot: ingest vehicle encyclopedia + WN8 expected values
npm run dev                 # start the dev server (default PORT=3001)
```

You need a Wargaming application ID. You can get one from <https://developers.wargaming.net/applications/>.

## API reference

All routes return a uniform envelope. `?forceRefresh=true` bypasses the Wargaming read cache on the relevant proxy routes.

### Health

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | DB connectivity probe (`{ status, database }`); 503 if unreachable |

### Players

| Method | Path | Query | Purpose |
| --- | --- | --- | --- |
| `GET` | `/players/search` | `search` (req), `forceRefresh` | Search accounts by nickname (WG `account/list`) |
| `GET` | `/players/:accountId` | `forceRefresh` | Player profile (WG `account/info`); enrolls the account for capture |
| `GET` | `/players/:accountId/vehicles` | `forceRefresh` | Per-tank stats (WG `tanks/stats`); enrolls on a non-empty result |
| `GET` | `/players/:accountId/stats` | `range` (req, `7\|14\|30`) | Trailing-window stat delta |
| `GET` | `/players/:accountId/stats/summary` | `ranges` (`7,14,30`, default all) | All three windows in one call |
| `GET` | `/players/:accountId/wn8` | `range` (opt, `7\|14\|30`) | Overall current WN8 (no `range`), or a trailing-window delta |
| `GET` | `/players/:accountId/wn8/summary` | `ranges` (`7,14,30`, default all) | All three WN8 windows in one call |

`:accountId` must be a positive integer. `?range`/`?ranges` accept only `7`, `14`, `30`.

### Admin (gated by `X-Admin-Token`)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/admin/snapshots/run` | Run a manual capture of all tracked accounts |
| `POST` | `/admin/vehicles/refresh` | Re-ingest the WG vehicle encyclopedia |
| `POST` | `/admin/wn8/refresh-expected` | Re-ingest XVM WN8 expected values |

Admin routes are fail-closed: if `ADMIN_TOKEN` is unset, every `/admin/*` route returns `503` (admin disabled), so an unconfigured server never exposes capture/refresh ops.

### Response envelope

```jsonc
// Success
{ "status": "ok", /* route-specific fields */ }

// Error
{ "status": "error", "error": { "code": 402, "message": "...", "field": "range", "value": "3" } }
```

The envelope `code` is promoted to the HTTP status **only** for 5xx and `INSUFFICIENT_HISTORY` (422). Validation errors carry envelope `code` 402 but stay HTTP 400, so a client-side code never becomes an HTTP status. `field`/`value` are present on validation errors and omitted on upstream/server errors.

## Configuration

Copy `server/.env.example` to `server/.env`. See `CLAUDE.md` for full detail.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | SQLite path, e.g. `file:./dev.db` |
| `WARGAMING_APPLICATION_ID` | yes | — | WG API application ID; the server won't boot without it |
| `WARGAMING_REALM` | no | `eu` | One of `eu`, `na`, `asia`, `ru` |
| `WARGAMING_CACHE_TTL_SECONDS` | no | `3600` | TTL for `account/list` cache |
| `WARGAMING_INFO_CACHE_TTL_SECONDS` | no | `3600` | TTL for `account/info` cache |
| `WARGAMING_VEHICLES_CACHE_TTL_SECONDS` | no | `3600` | TTL for `tanks/stats` cache |
| `PORT` | no | `3001` | HTTP listen port |
| `SNAPSHOT_JOB_ENABLED` | no | off | `true` enables the daily capture interval |
| `ADMIN_TOKEN` | no | unset | Shared secret for `/admin/*`; unset → all admin routes return 503 |

### Realms

| Realm | Host |
| --- | --- |
| `eu` | `api.worldoftanks.eu` |
| `na` | `api.worldoftanks.com` |
| `asia` | `api.worldoftanks.asia` |
| `ru` | `api.worldoftanks.ru` |

## Commands

```bash
npm run dev      # tsx watch, auto-loads .env; default PORT=3001
npm run build    # tsc --build
npm run sync     # one-shot: fetch vehicle encyclopedia (WG) + WN8 expected values (XVM)
npx prisma migrate dev --name <name>   # create+apply a migration
npx prisma generate                     # regenerate client into generated/prisma
npx tsc --noEmit                        # typecheck without emitting
npx eslint . | npx prettier --check .   # lint / format check
```

## How it works

**Snapshots & deltas.** Account enrollment is implicit: querying a player's profile or vehicles upserts a `TrackedAccount` once Wargaming confirms the account exists. The daily capture job (and the capture-on-query booster) write `PlayerStatsSnapshot` / `PlayerVehicleSnapshot` rows. A 7/14/30-day delta is `current − nearestPast`; when no snapshot is old enough it falls back to the oldest available, and `INSUFFICIENT_HISTORY` (422) is returned only when **no** past snapshot exists. Snapshots older than 45 days are garbage-collected; identical counters (unchanged `last_battle_time` / vehicle blob) are skipped.

**WN8.** Per-tank WN8 input counters are stored as one JSON blob per capture. Trailing-window WN8 is computed from per-tank `current − nearestPast` deltas, then battle-weighted. Tanks missing from `VehicleExpectedValue` are excluded entirely. Expected values come from the [XVM dataset](https://static.modxvm.com/wn8-data-exp/json/wg/wn8exp.json). Wargaming themselves don't provide these values.

**External data sources.**

- Wargaming: `account/list`, `account/info`, `tanks/stats`, `encyclopedia/vehicles`.
- XVM: `https://static.modxvm.com/wn8-data-exp/json/wg/wn8exp.json` (expected values).

## Project layout

```
server/
  src/
    app.ts            # Express app, all routes defined inline
    lib/
      prisma.ts       # singleton PrismaClient (better-sqlite3 adapter)
      http.ts         # envelope helpers: sendResult / sendApiError
      middleware.ts   # Express 5 error handler -> JSON envelope
      adminAuth.ts    # X-Admin-Token guard (fail-closed)
      wargaming.ts    # TTL-cached proxies for WG account/tanks/encyclopedia
      stats.ts        # trailing-window stat deltas + snapshots
      wn8.ts          # WN8 current/delta/summary
      vehicles.ts     # vehicle encyclopedia + XVM expected-value ingestion
      scheduler.ts    # daily capture job (off by default)
    scripts/sync.ts   # npm run sync entrypoint
  prisma/schema.prisma
  generated/prisma/   # gitignored; generated by `prisma generate`
```

### Prisma notes

- Prisma **7** with a `prisma.config.ts` (loads `dotenv/config` so CLI commands pick up `DATABASE_URL`).
- Generator output is `generated/prisma` (gitignored); the app imports the generated client directly — a stale dir breaks the build.
- `prisma migrate dev` doesn't always regenerate the client here — run `npx prisma generate` explicitly if a new model isn't visible to TypeScript after migrating.

## Tech stack

- Express 5, TypeScript 5 (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), ESM
- Prisma 7 with `@prisma/adapter-better-sqlite3`, SQLite
- `tsx` for dev, `tsc` for build
- Prettier (no semicolons, single quotes, 2-space indent), ESLint with `prefer-const`
