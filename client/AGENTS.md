# Frontend Agent Guide — wot-stat-server

Reference for agents building UI against the wot-stat-server REST API.

## Rules

1. Use the existing client in `src/router.ts` (`import { api, ApiError } from './router.ts'`). Add new endpoints there, don't hand-roll `fetch`.
2. All requests go to same-origin `/api/*`. Vite proxies to `WOT_API_TARGET` (default `http://localhost:3001`). Never hardcode the API origin.
3. Every response is a uniform envelope: success `{ status:'ok', ... }`, error `{ status:'error', error:{ code, message, field?, value? } }`. The client unwraps it and throws `ApiError` — catch that, not raw `Error`.
4. Envelope `code` ≠ HTTP status for validation errors (envelope 402, HTTP 400). `isInsufficientHistory` (HTTP 422) means "no past snapshot yet" — show a friendly state, don't retry.
5. `range`/`ranges` only accept `7|14|30`. `:accountId` must be a positive integer.
6. Admin routes need `X-Admin-Token`; 503 when unset. Token from `VITE_ADMIN_TOKEN` or passed as `token` arg.
7. Prefer `summary` endpoints (all three windows in one call).
8. Style: Prettier — no semicolons, single quotes, 2-space indent.

## Endpoints

`:accountId` = positive int. `?range`/`?ranges` = `7|14|30`.

| Method | Path | Query | Client method |
| --- | --- | --- | --- |
| GET | `/health` | — | `api.health()` |
| GET | `/players/search` | `search`(req), `forceRefresh` | `api.searchPlayers(search, forceRefresh?)` |
| GET | `/players/:id` | `forceRefresh` | `api.getPlayer(id, forceRefresh?)` |
| GET | `/players/:id/vehicles` | `forceRefresh` | `api.getVehicles(id, forceRefresh?)` |
| GET | `/players/:id/stats` | `range`(req) | `api.getStats(id, range)` |
| GET | `/players/:id/stats/summary` | `ranges`(def `7,14,30`) | `api.getStatsSummary(id, ranges?)` |
| GET | `/players/:id/wn8` | `range`(opt) | `api.getWn8Current(id)` / `api.getWn8Delta(id, range)` |
| GET | `/players/:id/wn8/summary` | `ranges`(def `7,14,30`) | `api.getWn8Summary(id, ranges?)` |
| POST | `/admin/snapshots/run` | — | `api.runSnapshots(token?)` |
| POST | `/admin/vehicles/refresh` | — | `api.refreshVehicles(token?)` |
| POST | `/admin/wn8/refresh-expected` | — | `api.refreshWn8Expected(token?)` |

`forceRefresh=true` bypasses the WG read cache (proxy routes only).

## Semantics

- **Enrollment is implicit** — querying profile/vehicles upserts a `TrackedAccount` once WG confirms the account. No separate "track" call.
- **Deltas** = `current − nearestPast`; falls back to oldest available snapshot, `window_days` tells the actual anchor age used. 422 only when no past snapshot exists.
- **WN8** is battle-weighted from per-tank deltas; tanks missing expected values are excluded.

## Payload types

Import interfaces (`PlayerProfile`, `StatDelta`, `Wn8Delta`, etc.) from `src/router.ts` rather than redeclaring. Shapes are inferred from the README — adjust if real payloads differ.
