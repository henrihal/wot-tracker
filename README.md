# wot-stat-server

A self-hosted REST API that tracks World of Tanks player statistics over time. It proxies [Wargaming's public API](https://developers.wargaming.net/) for live profile/vehicle data and adds a local snapshot history so you can compute **trailing-window deltas** (7/14/30 days) for battle stats and the **WN8** efficiency rating. The repo also contains a React web client in `client/` that talks to the API via same-origin `/api/*`.

Built with Express 5, TypeScript, Prisma 7, and PostgreSQL; the client is React 19, react-router 8, and Vite 8.

## Features

- **Player search & profile:** proxy `account/list` and `account/info` with a TTL read cache.
- **Trailing-window stat deltas:** `current − nearestPast` over 7/14/30 days from locally captured snapshots, with a capture-on-query booster (5-min dedup).
- **WN8 rating:** overall current WN8 plus 7/14/30-day deltas, computed from per-tank counters vs. XVM expected values.
- **Vehicle encyclopedia:** reference data ingested from the WG encyclopedia.
- **Daily capture scheduler:** optional job that snapshots all tracked accounts (off by default).
- **Uniform JSON envelope:** every response (success or error) uses the same `{ status, ... }` shape.
- **Web client:** the React dashboard in `client/` covers player search, profile, trailing-window stats, WN8, and an admin page.

## Quick start

Server commands run from `server/`; client commands from `client/`.

```bash
cd server
cp .env.example .env        # fill in DATABASE_URL + WARGAMING_APPLICATION_ID
npm install
npx prisma migrate dev      # apply the schema
npm run sync                # one-shot: ingest vehicle encyclopedia + WN8 expected values
npm run dev                 # start dev server (default PORT=3001)
```

```bash
# in a second terminal, start the web client
cd client
npm install
npm run dev                 # http://localhost:5173, proxies /api -> localhost:3001
```

Get a Wargaming application ID at <https://developers.wargaming.net/applications/>.

## API reference

`?forceRefresh=true` bypasses the Wargaming read cache on proxy routes.

### Players

| Method | Path                                | Query                          | Purpose                                             |
| ------ | ----------------------------------- | ------------------------------ | --------------------------------------------------- |
| `GET`  | `/health`                           | -                              | DB connectivity probe; 503 if unreachable           |
| `GET`  | `/players/search`                   | `search` (req), `forceRefresh` | Search accounts by nickname                         |
| `GET`  | `/players/:accountId`               | `forceRefresh`                 | Player profile; enrolls the account for capture     |
| `GET`  | `/players/:accountId/vehicles`      | `forceRefresh`                 | Per-tank stats; enrolls on a non-empty result       |
| `GET`  | `/players/:accountId/stats`         | `range` (req, `7\|14\|30`)     | Trailing-window stat delta                          |
| `GET`  | `/players/:accountId/stats/summary` | `ranges` (default `7,14,30`)   | All three windows in one call                       |
| `GET`  | `/players/:accountId/wn8`           | `range` (opt, `7\|14\|30`)     | Overall current WN8 (no `range`), or a window delta |
| `GET`  | `/players/:accountId/wn8/summary`   | `ranges` (default `7,14,30`)   | All three WN8 windows in one call                   |

`:accountId` must be a positive integer. `?range`/`?ranges` accept only `7`, `14`, `30`.

### Admin (gated by `X-Admin-Token`)

| Method | Path                          | Purpose                                      |
| ------ | ----------------------------- | -------------------------------------------- |
| `POST` | `/admin/snapshots/run`        | Run a manual capture of all tracked accounts |
| `POST` | `/admin/vehicles/refresh`     | Re-ingest the WG vehicle encyclopedia        |
| `POST` | `/admin/wn8/refresh-expected` | Re-ingest XVM WN8 expected values            |

Fail-closed: if `ADMIN_TOKEN` is unset, every `/admin/*` route returns `503`.

### Response envelope

```jsonc
// Success
{ "status": "ok", /* route-specific fields */ }
// Error
{ "status": "error", "error": { "code": 402, "message": "...", "field": "range", "value": "3" } }
```

The envelope `code` becomes the HTTP status **only** for 5xx and `INSUFFICIENT_HISTORY` (422); validation errors keep envelope `code` 402 but stay HTTP 400. `field`/`value` appear on validation errors only.

## Client

The web client (`client/`) is a React 19 + react-router 8 + Vite 8 + TypeScript app: player search, profile, trailing-window stats, WN8, and an admin page.

- **Dev:** `npm run dev` from `client/` serves on port 5173. Vite proxies same-origin `/api/*` to `WOT_API_TARGET` (default `http://localhost:3001`) and strips the `/api` prefix, so no CORS setup is needed in dev.
- **Prod:** serve the built UI from the API's origin, or put a reverse proxy in front that maps `/api/*` to the API. Set `VITE_API_BASE_URL` to an absolute URL only if you're not using the proxy (e.g. prod with CORS enabled).
- `VITE_ADMIN_TOKEN` supplies the admin page's `X-Admin-Token`.
- All API access goes through `client/src/router.ts` (`api`, `ApiError`, payload types). See `client/AGENTS.md` for frontend agent guidance.

## Configuration

Copy `server/.env.example` to `server/.env`. See `server/AGENTS.md` for agent guidance.

| Variable                               | Required | Default | Purpose                                                              |
| -------------------------------------- | -------- | ------- | -------------------------------------------------------------------- |
| `DATABASE_URL`                         | yes      | -       | Postgres connection string                                           |
| `DIRECT_DATABASE_URL`                  | no       | unset   | Direct (non-pooled) URL for migrations; falls back to `DATABASE_URL` |
| `WARGAMING_APPLICATION_ID`             | yes      | -       | WG API application ID; server won't boot without it                  |
| `WARGAMING_REALM`                      | no       | `eu`    | One of `eu`, `na`, `asia`, `ru`                                      |
| `WARGAMING_CACHE_TTL_SECONDS`          | no       | `3600`  | TTL for `account/list` cache                                         |
| `WARGAMING_INFO_CACHE_TTL_SECONDS`     | no       | `3600`  | TTL for `account/info` cache                                         |
| `WARGAMING_VEHICLES_CACHE_TTL_SECONDS` | no       | `3600`  | TTL for `tanks/stats` cache                                          |
| `PORT`                                 | no       | `3001`  | HTTP listen port                                                     |
| `SNAPSHOT_JOB_ENABLED`                 | no       | off     | `true` enables the daily capture interval                            |
| `ADMIN_TOKEN`                          | no       | unset   | Shared secret for `/admin/*`; unset → all admin routes return 503    |

Realms: `eu` → `api.worldoftanks.eu`, `na` → `api.worldoftanks.com`, `asia` → `api.worldoftanks.asia`, `ru` → `api.worldoftanks.ru`.

## Commands

Server (from `server/`):

```bash
npm run dev      # tsx watch, auto-loads .env; default PORT=3001
npm run build    # tsc --build
npm run sync     # one-shot: WG vehicle encyclopedia + XVM WN8 expected values
npx prisma migrate dev --name <name>   # create+apply a migration
npx prisma generate                     # regenerate client into generated/prisma
npx tsc --noEmit                        # typecheck
npx eslint . | npx prettier --check .   # lint / format check
```

Client (from `client/`):

```bash
npm run dev      # vite dev server on :5173
npm run build    # tsc + vite build
npm run preview  # preview the production build
```

## How it works

**Snapshots & deltas.** Enrollment is implicit: querying a player's profile or vehicles upserts a `TrackedAccount` once Wargaming confirms the account exists. The daily capture job (and the capture-on-query booster) write snapshot rows. A 7/14/30-day delta is `current − nearestPast`; when no snapshot is old enough it falls back to the oldest available, and `INSUFFICIENT_HISTORY` (422) is returned only when **no** past snapshot exists. Snapshots older than 45 days are GC'd; identical counters are skipped.

**WN8.** Per-tank counters are stored as one JSON blob per capture. Trailing-window WN8 is computed from per-tank `current − nearestPast` deltas, then battle-weighted. Tanks missing from `VehicleExpectedValue` are excluded. Expected values come from the [XVM dataset](https://static.modxvm.com/wn8-data-exp/json/wg/wn8exp.json).

## Project layout

```
server/
  src/
    app.ts            # Express app, all routes inline
    lib/
      prisma.ts       # singleton PrismaClient (@prisma/adapter-pg)
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
  Dockerfile          # multi-stage build, runs compiled JS (no tsx at runtime), EXPOSE 5001
client/
  src/
    router.ts        # typed API client (api, ApiError, payload types)
    pages/           # IndexPage (search), PlayerPage (stats/WN8), AdminPage
    main.tsx, style.css
  vite.config.ts     # dev proxy /api -> WOT_API_TARGET (default :3001)
  AGENTS.md          # frontend agent guide
```

Prisma 7 with `prisma.config.ts` (loads `dotenv/config` so the CLI picks up `.env`). Generator output `generated/prisma` is gitignored; the app imports the generated client directly. Stale dir breaks the build. If `prisma migrate dev` doesn't regenerate the client, run `npx prisma generate`.

## Tech stack

Express 5, TypeScript 5 (strict, ESM), Prisma 7 with `@prisma/adapter-pg`, PostgreSQL. `tsx` for dev, `tsc` for build. Prettier (no semicolons, single quotes, 2-space indent), ESLint with `prefer-const`.
