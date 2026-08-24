// API client for the wot-stat-server REST API.
//
// Every server response uses a uniform envelope:
//   success: { status: 'ok', ...routeFields }
//   error:   { status: 'error', error: { code, message, field?, value? } }
//
// Note on status codes: the envelope `code` is NOT always the HTTP status.
// Validation errors keep envelope `code` 402 but return HTTP 400, while
// 5xx and INSUFFICIENT_HISTORY (422) pass through. The client therefore
// reads the body, not just `response.ok`.
//
// Response payload shapes below are inferred from the README; they may need
// small adjustments once real payloads are confirmed against the server.

// Relative base: requests go to same-origin `/api/*`, which Vite proxies to
// the API in dev (see vite.config.ts). Set VITE_API_BASE_URL to an absolute
// URL only if you are NOT using the proxy (e.g. prod with CORS enabled).
const DEFAULT_API_BASE = '/api'

export type Range = 7 | 14 | 30
export const RANGES = [7, 14, 30] as const
export const RANGES_CSV = '7,14,30'

const apiBase: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ??
  DEFAULT_API_BASE

const adminToken: string | undefined = import.meta.env.VITE_ADMIN_TOKEN as
  | string
  | undefined

// --- Errors ---------------------------------------------------------------

export class ApiError extends Error {
  readonly code: number
  readonly field?: string
  readonly value?: string
  readonly httpStatus: number

  constructor(
    code: number,
    message: string,
    httpStatus: number,
    field?: string,
    value?: string,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.httpStatus = httpStatus
    this.field = field
    this.value = value
  }

  /** True for the "not enough captured history yet" case (envelope 422). */
  get isInsufficientHistory(): boolean {
    return this.httpStatus === 422
  }
}

// --- Response types -------------------------------------------------------
// Assumed shapes — adjust once real payloads are confirmed.

export interface Health {
  status: 'ok'
  database: 'ok' | 'error'
}

export interface PlayerSummary {
  account_id: number
  nickname: string
}

export interface SearchMeta {
  count: number
}

export interface SearchResponse {
  status: 'ok'
  meta: SearchMeta
  data: PlayerSummary[]
}

export interface PlayerStatistics {
  spotted?: number
  battles?: number
  wins?: number
  losses?: number
  draws?: number
  damage_dealt?: number
  damage_received?: number
  frags?: number
  xp?: number
  survived_battles?: number
  hits?: number
  shots?: number
  capture_points?: number
  dropped_capture_points?: number
  battle_avg_xp?: number
  hits_percents?: number
  max_xp?: number
  max_damage?: number
  max_frags?: number
  avg_damage_blocked?: number
  avg_damage_assisted?: number
  avg_damage_assisted_radio?: number
  avg_damage_assisted_track?: number
  tanking_factor?: number
  [k: string]: unknown
}

/** One WG account record (the value of `data[<accountId>]`). */
export interface PlayerAccount {
  account_id: number
  nickname: string
  created_at: number
  last_battle_time: number
  logout_at?: number
  global_rating?: number
  client_language?: string
  clan_id?: number | null
  statistics: {
    all?: PlayerStatistics
    random?: PlayerStatistics
    [k: string]: unknown
  }
  [k: string]: unknown
}

/** Raw envelope for GET /players/:id. The account is keyed by id in `data`. */
export interface PlayerProfile {
  status: 'ok'
  meta: { count: number }
  data: Record<string, PlayerAccount>
}

export interface VehicleStat {
  tank_id: number
  battles: number
  wins: number
  damage_dealt: number
  frags: number
  spotted: number
  damage_blocked?: number
  base_capture_points?: number
  base_defense_points?: number
  wn8?: number
}

export interface VehiclesResponse {
  status: 'ok'
  vehicles: VehicleStat[]
}

/** Trailing-window delta = current - nearestPast for one window. */
export interface StatDelta {
  battles: number
  wins: number
  losses: number
  damage_dealt: number
  frags: number
  spotted: number
  damage_blocked?: number
  base_capture_points?: number
  base_defense_points?: number
  xp?: number
  survived_battles?: number
  /** Anchor snapshot age in days actually used (may be < range when falling back). */
  window_days?: number
}

export interface StatsResponse {
  status: 'ok'
  range: Range
  delta: StatDelta
}

export interface StatsSummaryResponse {
  status: 'ok'
  ranges: Record<Range, StatDelta>
}

export interface Wn8PerTank {
  tankId: number
  battles: number
  wins: number
  damage_dealt: number
  spotted: number
  frags: number
  dropped_capture_points: number
  name: string
  tier: number
  type: string
  wn8: number
}

export interface Wn8CurrentResponse {
  status: 'ok'
  wn8: number
  battles: number
  perTank: Wn8PerTank[]
}

export interface Wn8Delta {
  wn8: number
  delta: number
  window_days?: number
}

export interface Wn8DeltaResponse {
  status: 'ok'
  range: Range
  delta: Wn8Delta
}

export interface Wn8SummaryResponse {
  status: 'ok'
  current: number
  ranges: Record<Range, Wn8Delta>
}

// --- Core fetch + envelope unwrap ----------------------------------------

type QueryValue = string | number | boolean | readonly (string | number)[] | undefined

function buildQuery(params: Record<string, QueryValue>): string {
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      sp.set(key, value.join(','))
    } else if (typeof value === 'boolean') {
      if (value) sp.set(key, 'true')
    } else {
      sp.set(key, String(value))
    }
  }
  const qs = sp.toString()
  return qs ? `?${qs}` : ''
}

interface ErrorEnvelope {
  status: 'error'
  error: { code: number; message: string; field?: string; value?: string }
}

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { status?: unknown }).status === 'error' &&
    typeof (body as ErrorEnvelope).error?.message === 'string'
  )
}

async function request<T>(
  path: string,
  opts: {
    method?: 'GET' | 'POST'
    query?: Record<string, QueryValue>
    admin?: boolean
    token?: string
  } = {},
): Promise<T> {
  const { method = 'GET', query = {}, admin = false, token } = opts
  const url = `${apiBase}${path}${buildQuery(query)}`

  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (admin) {
    const effectiveToken = token || adminToken
    if (!effectiveToken) {
      // Fail-closed locally too: matches server behaviour when ADMIN_TOKEN unset.
      throw new ApiError(503, 'Admin token not configured', 503)
    }
    headers['X-Admin-Token'] = effectiveToken
  }

  let res: Response
  try {
    res = await fetch(url, { method, headers })
  } catch {
    throw new ApiError(0, `Network error contacting ${url}`, 0)
  }

  const text = await res.text()
  const body = text ? safeParse(text) : null

  if (body !== null && isErrorEnvelope(body)) {
    const { code, message, field, value } = body.error
    throw new ApiError(code, message, res.status, field, value)
  }

  if (!res.ok && body === null) {
    throw new ApiError(res.status, `HTTP ${res.status} ${res.statusText}`, res.status)
  }

  // Treat anything that isn't an explicit error envelope as success payload.
  return body as T
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// --- Endpoint functions ---------------------------------------------------

export const api = {
  health: () => request<Health>('/health'),

  searchPlayers: (search: string, forceRefresh = false) =>
    request<SearchResponse>('/players/search', {
      query: { search, forceRefresh },
    }),

  getPlayer: (accountId: number, forceRefresh = false) =>
    request<PlayerProfile>(`/players/${accountId}`, {
      query: { forceRefresh },
    }),

  getVehicles: (accountId: number, forceRefresh = false) =>
    request<VehiclesResponse>(`/players/${accountId}/vehicles`, {
      query: { forceRefresh },
    }),

  getStats: (accountId: number, range: Range) =>
    request<StatsResponse>(`/players/${accountId}/stats`, {
      query: { range },
    }),

  getStatsSummary: (accountId: number, ranges: readonly Range[] = RANGES) =>
    request<StatsSummaryResponse>(`/players/${accountId}/stats/summary`, {
      query: { ranges: ranges.join(',') },
    }),

  getWn8Current: (accountId: number) =>
    request<Wn8CurrentResponse>(`/players/${accountId}/wn8`),

  getWn8Delta: (accountId: number, range: Range) =>
    request<Wn8DeltaResponse>(`/players/${accountId}/wn8`, {
      query: { range },
    }),

  getWn8Summary: (accountId: number, ranges: readonly Range[] = RANGES) =>
    request<Wn8SummaryResponse>(`/players/${accountId}/wn8/summary`, {
      query: { ranges: ranges.join(',') },
    }),

  // Admin (X-Admin-Token gated; fail-closed when token unset).
  // Pass `token` to override the env VITE_ADMIN_TOKEN at runtime (e.g. from UI).
  runSnapshots: (token?: string) =>
    request<{ status: 'ok' }>('/admin/snapshots/run', { method: 'POST', admin: true, token }),
  refreshVehicles: (token?: string) =>
    request<{ status: 'ok' }>('/admin/vehicles/refresh', { method: 'POST', admin: true, token }),
  refreshWn8Expected: (token?: string) =>
    request<{ status: 'ok' }>('/admin/wn8/refresh-expected', { method: 'POST', admin: true, token }),
}

export { apiBase, adminToken }
