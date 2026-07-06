import 'dotenv/config'
import { prisma } from './prisma.js'
import { apiError } from './http.js'

const REALMS = ['eu', 'na', 'asia', 'ru'] as const
export type Realm = (typeof REALMS)[number]

// Wargaming uses a different host per realm (NA is .com, not .na).
const API_HOSTS: Record<Realm, string> = {
  eu: 'api.worldoftanks.eu',
  na: 'api.worldoftanks.com',
  asia: 'api.worldoftanks.asia',
  ru: 'api.worldoftanks.ru',
}

const resolveRealm = (): Realm => {
  const raw = process.env['WARGAMING_REALM'] ?? 'eu'
  if (!REALMS.includes(raw as Realm)) {
    throw new Error(
      `Invalid WARGAMING_REALM "${raw}". Must be one of: ${REALMS.join(', ')}`
    )
  }
  return raw as Realm
}

export const REALM = resolveRealm()

const rawApplicationId = process.env['WARGAMING_APPLICATION_ID']
if (!rawApplicationId) {
  throw new Error('WARGAMING_APPLICATION_ID environment variable is not set')
}
const APPLICATION_ID: string = rawApplicationId

const CACHE_TTL_SECONDS = Number.parseInt(
  process.env['WARGAMING_CACHE_TTL_SECONDS'] ?? '3600',
  10
)
if (!Number.isFinite(CACHE_TTL_SECONDS) || CACHE_TTL_SECONDS <= 0) {
  throw new Error('WARGAMING_CACHE_TTL_SECONDS must be a positive number')
}

// TTL for the account/info read cache. Separate from the search cache TTL since
// player profiles change slowly and can reasonably live longer.
const INFO_CACHE_TTL_SECONDS = Number.parseInt(
  process.env['WARGAMING_INFO_CACHE_TTL_SECONDS'] ?? '3600',
  10
)
if (!Number.isFinite(INFO_CACHE_TTL_SECONDS) || INFO_CACHE_TTL_SECONDS <= 0) {
  throw new Error('WARGAMING_INFO_CACHE_TTL_SECONDS must be a positive number')
}

// TTL for the tanks/stats read cache. Per-tank stats are needed for WN8 and
// change per battle; the same TTL as account/info is reasonable.
const VEHICLES_CACHE_TTL_SECONDS = Number.parseInt(
  process.env['WARGAMING_VEHICLES_CACHE_TTL_SECONDS'] ?? '3600',
  10
)
if (
  !Number.isFinite(VEHICLES_CACHE_TTL_SECONDS) ||
  VEHICLES_CACHE_TTL_SECONDS <= 0
) {
  throw new Error(
    'WARGAMING_VEHICLES_CACHE_TTL_SECONDS must be a positive number'
  )
}

const API_URL = `https://${API_HOSTS[REALM]}/wot/account/list/`
const INFO_API_URL = `https://${API_HOSTS[REALM]}/wot/account/info/`
const VEHICLES_API_URL = `https://${API_HOSTS[REALM]}/wot/tanks/stats/`
const ENCYCLOPEDIA_API_URL = `https://${API_HOSTS[REALM]}/wot/encyclopedia/vehicles/`

// Public `statistics.*` extras fetchable with just application_id. The
// `private.*` extras require an access_token (auth flow not implemented) and
// are intentionally omitted.
const PUBLIC_EXTRA_FIELDS = [
  'statistics.epic',
  'statistics.fallout',
  'statistics.globalmap_absolute',
  'statistics.globalmap_champion',
  'statistics.globalmap_middle',
  'statistics.random',
  'statistics.ranked_10x10',
  'statistics.ranked_15x15',
  'statistics.ranked_battles',
  'statistics.ranked_battles_current',
  'statistics.ranked_battles_previous',
  'statistics.ranked_season_1',
  'statistics.ranked_season_2',
  'statistics.ranked_season_3',
] as const

export interface PlayerSearchEntry {
  nickname: string
  account_id: number
}

export interface WargamingSearchResponse {
  status: 'ok' | 'error'
  meta?: { count: number }
  data?: PlayerSearchEntry[]
  error?: {
    code: number
    message: string
    field?: string
    value?: string | number
  }
}

export interface SearchPlayersOptions {
  /** Bypass the cache and always re-fetch from Wargaming. */
  forceRefresh?: boolean
}

/**
 * Search Wargaming players by nickname via the account/list endpoint, acting as
 * a caching middleman. Successful responses are cached in SQLite keyed by the
 * normalized search term and realm; error responses are never cached so the
 * client can retry once the underlying problem (e.g. too-short search) is fixed.
 */
export const searchPlayers = async (
  search: string,
  opts: SearchPlayersOptions = {}
): Promise<WargamingSearchResponse> => {
  const normalized = search.trim().toLowerCase()

  if (normalized.length === 0) {
    return apiError({
      code: 402,
      message: 'SEARCH_NOT_SPECIFIED: Search parameter not specified.',
      field: 'search',
      value: '',
    })
  }

  if (!opts.forceRefresh) {
    const cached = await prisma.playerSearchCache.findUnique({
      where: { search_realm: { search: normalized, realm: REALM } },
    })
    if (cached && cached.expiresAt > new Date()) {
      return JSON.parse(cached.response) as WargamingSearchResponse
    }
  }

  const url = new URL(API_URL)
  url.searchParams.set('application_id', APPLICATION_ID)
  url.searchParams.set('search', normalized)

  let res: Response
  try {
    res = await fetch(url)
  } catch {
    return apiError({
      code: 503,
      message:
        'Upstream Wargaming request failed: network error contacting the API.',
    })
  }
  if (!res.ok) {
    return apiError({
      code: res.status,
      message: `Upstream Wargaming request failed with HTTP ${res.status}`,
    })
  }

  const body = (await res.json()) as WargamingSearchResponse

  if (body.status === 'ok') {
    const expiresAt = new Date(Date.now() + CACHE_TTL_SECONDS * 1000)
    const response = JSON.stringify(body)
    await prisma.playerSearchCache.upsert({
      where: { search_realm: { search: normalized, realm: REALM } },
      create: { search: normalized, realm: REALM, response, expiresAt },
      update: { response, expiresAt },
    })
  }

  return body
}

export type PlayerInfo = Record<string, unknown>

export interface WargamingInfoResponse {
  status: 'ok' | 'error'
  meta?: { count: number }
  data?: Record<string, PlayerInfo | null>
  error?: {
    code: number
    message: string
    field?: string
    value?: string | number
  }
}

export interface GetPlayerInfoOptions {
  /** Bypass the cache and always re-fetch from Wargaming. */
  forceRefresh?: boolean
}

/**
 * Fetch a Wargaming player profile by account_id via the account/info endpoint,
 * acting as a caching middleman. The full public profile (default fields plus
 * all public statistics.* extras) is fetched on a cache miss or expiry and
 * stored in SQLite keyed by [account_id, realm] until `expiresAt`; subsequent
 * calls within the TTL are served from cache. forceRefresh re-fetches and
 * overwrites the cached row (bumping `expiresAt`). private.* extras are not
 * fetched (they require an access_token we don't have).
 */
export const getPlayerInfo = async (
  accountId: number,
  opts: GetPlayerInfoOptions = {}
): Promise<WargamingInfoResponse> => {
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return apiError({
      code: 402,
      message:
        'ACCOUNT_ID_NOT_SPECIFIED: account_id must be a positive integer.',
      field: 'account_id',
      value: accountId,
    })
  }

  if (!opts.forceRefresh) {
    const cached = await prisma.playerInfoCache.findUnique({
      where: { accountId_realm: { accountId, realm: REALM } },
    })
    if (cached && cached.expiresAt > new Date()) {
      return JSON.parse(cached.response) as WargamingInfoResponse
    }
  }

  const url = new URL(INFO_API_URL)
  url.searchParams.set('application_id', APPLICATION_ID)
  url.searchParams.set('account_id', String(accountId))
  url.searchParams.set('extra', PUBLIC_EXTRA_FIELDS.join(','))

  let res: Response
  try {
    res = await fetch(url)
  } catch {
    return apiError({
      code: 503,
      message:
        'Upstream Wargaming request failed: network error contacting the API.',
    })
  }
  if (!res.ok) {
    return apiError({
      code: res.status,
      message: `Upstream Wargaming request failed with HTTP ${res.status}`,
    })
  }

  const body = (await res.json()) as WargamingInfoResponse

  if (body.status === 'ok') {
    const response = JSON.stringify(body)
    const expiresAt = new Date(Date.now() + INFO_CACHE_TTL_SECONDS * 1000)
    await prisma.playerInfoCache.upsert({
      where: { accountId_realm: { accountId, realm: REALM } },
      create: { accountId, realm: REALM, response, expiresAt },
      update: { response, fetchedAt: new Date(), expiresAt },
    })

    // Enroll in the daily-capture work list only when WG actually has the
    // account. WG returns status:"ok" with data[accountId] === null for a
    // non-existent account_id; skip those so TrackedAccount stays clean. This
    // is the single enrollment point for /players/info and the stats endpoints
    // (the latter reach here via stats.ts getCurrentStats on a snapshot miss).
    // Not done on the cache-hit path above: a cache row can only exist because
    // a prior fresh fetch already enrolled the account.
    if (body.data?.[String(accountId)] != null) {
      await prisma.trackedAccount.upsert({
        where: { accountId_realm: { accountId, realm: REALM } },
        create: { accountId, realm: REALM },
        update: {},
      })
    }
  }

  return body
}

export interface VehicleStat {
  tank_id: number
  all?: Record<string, number>
  random?: Record<string, number>
}

export interface WargamingVehicleStatsResponse {
  status: 'ok' | 'error'
  meta?: { count: number }
  data?: Record<string, VehicleStat[] | null>
  error?: {
    code: number
    message: string
    field?: string
    value?: string | number
  }
}

export interface GetPlayerVehiclesOptions {
  /** Bypass the cache and always re-fetch from Wargaming. */
  forceRefresh?: boolean
}

/**
 * Fetch a player's per-vehicle statistics via the tanks/stats endpoint, acting
 * as a caching middleman. The full public per-tank stats (default `all` group
 * plus the `random` extra) are fetched on a cache miss or expiry and stored in
 * SQLite keyed by [account_id, realm] until `expiresAt`; subsequent calls
 * within the TTL are served from cache. forceRefresh re-fetches and overwrites
 * the cached row (bumping `expiresAt`). The `in_garage` field is not fetched
 * (it requires an access_token). On a successful fresh fetch it also upserts
 * the account into `TrackedAccount` — but only when WG returns a non-empty
 * tanks/stats array (the player has played at least one tank → the account
 * exists); this is the second enrollment point (the first is `getPlayerInfo`),
 * so `/players/:id/vehicles` and `/wn8` build history without a prior
 * `/players/info`. The cache-hit path does not re-upsert.
 */
export const getPlayerVehicles = async (
  accountId: number,
  opts: GetPlayerVehiclesOptions = {}
): Promise<WargamingVehicleStatsResponse> => {
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return apiError({
      code: 402,
      message:
        'ACCOUNT_ID_NOT_SPECIFIED: account_id must be a positive integer.',
      field: 'account_id',
      value: accountId,
    })
  }

  if (!opts.forceRefresh) {
    const cached = await prisma.playerVehicleStatsCache.findUnique({
      where: { accountId_realm: { accountId, realm: REALM } },
    })
    if (cached && cached.expiresAt > new Date()) {
      return JSON.parse(cached.response) as WargamingVehicleStatsResponse
    }
  }

  const url = new URL(VEHICLES_API_URL)
  url.searchParams.set('application_id', APPLICATION_ID)
  url.searchParams.set('account_id', String(accountId))
  url.searchParams.set('extra', 'random')

  let res: Response
  try {
    res = await fetch(url)
  } catch {
    return apiError({
      code: 503,
      message:
        'Upstream Wargaming request failed: network error contacting the API.',
    })
  }
  if (!res.ok) {
    return apiError({
      code: res.status,
      message: `Upstream Wargaming request failed with HTTP ${res.status}`,
    })
  }

  const body = (await res.json()) as WargamingVehicleStatsResponse

  if (body.status === 'ok') {
    const response = JSON.stringify(body)
    const expiresAt = new Date(Date.now() + VEHICLES_CACHE_TTL_SECONDS * 1000)
    await prisma.playerVehicleStatsCache.upsert({
      where: { accountId_realm: { accountId, realm: REALM } },
      create: { accountId, realm: REALM, response, expiresAt },
      update: { response, fetchedAt: new Date(), expiresAt },
    })

    // Enroll in the capture work list only when the player has actually played
    // at least one tank (a non-empty tanks/stats array). WG returns an empty
    // array both for a brand-new account and for an unknown account_id; an
    // empty array is not a reliable existence signal, so it is not enrolled.
    const tanks = body.data?.[String(accountId)]
    if (Array.isArray(tanks) && tanks.length > 0) {
      await prisma.trackedAccount.upsert({
        where: { accountId_realm: { accountId, realm: REALM } },
        create: { accountId, realm: REALM },
        update: {},
      })
    }
  }

  return body
}

export interface EncyclopediaVehicle {
  tank_id: number
  name: string
  short_name: string
  nation: string
  tier: number
  type: string
  is_premium: boolean
  tag: string
}

export interface WargamingEncyclopediaResponse {
  status: 'ok' | 'error'
  meta?: { count: number; total: number; page: number; page_total: number }
  data?: Record<string, EncyclopediaVehicle>
  error?: {
    code: number
    message: string
    field?: string
    value?: string | number
  }
}

export interface GetVehicleEncyclopediaOptions {
  /** Bypass any local freshness guard and re-fetch all pages from Wargaming. */
  forceRefresh?: boolean
}

const ENCYCLOPEDIA_LIMIT = 100
const ENCYCLOPEDIA_FIELDS = [
  'tank_id',
  'name',
  'short_name',
  'nation',
  'tier',
  'type',
  'is_premium',
  'tag',
].join(',')

/**
 * Fetch the full vehicle encyclopedia from `wot/encyclopedia/vehicles/`,
 * paginating `page_no` (limit 100). The page count is taken from the first
 * page's `meta.page_total` (WG also returns `meta.page` for the current page
 * and `meta.total` for the total tank count), so the loop requests exactly
 * the pages that exist — never `page_no` past the last page, which is what
 * triggers WG's `PAGE_NO_NOT_FOUND` error. Merges every page's `data` map
 * into a single `{ [tank_id]: vehicle }` map (the caller upserts rows into
 * the `Vehicle` table). The encyclopedia changes rarely (new tanks), so it is
 * not TTL-cached as a blob — normalized storage in `Vehicle` is the cache.
 * `forceRefresh` is accepted for API symmetry but has no effect here (every
 * call re-fetches all pages).
 */
export const getVehicleEncyclopedia = async (
  _opts: GetVehicleEncyclopediaOptions = {}
): Promise<{
  status: 'ok' | 'error'
  vehicles: Record<string, EncyclopediaVehicle>
  pages: number
  error?: { code: number; message: string }
}> => {
  const vehicles: Record<string, EncyclopediaVehicle> = {}
  let page = 1
  let pages = 0
  // Learned from the first response's `meta.page_total`; until then unbounded
  // (a single-page encyclopedia still works via the page_total==1 stop).
  let pageTotal = Number.POSITIVE_INFINITY

  while (page <= pageTotal) {
    const url = new URL(ENCYCLOPEDIA_API_URL)
    url.searchParams.set('application_id', APPLICATION_ID)
    url.searchParams.set('limit', String(ENCYCLOPEDIA_LIMIT))
    url.searchParams.set('page_no', String(page))
    url.searchParams.set('fields', ENCYCLOPEDIA_FIELDS)

    let res: Response
    try {
      res = await fetch(url)
    } catch {
      return {
        status: 'error',
        vehicles,
        pages,
        error: {
          code: 503,
          message:
            'Upstream Wargaming request failed: network error contacting the API.',
        },
      }
    }
    if (!res.ok) {
      return {
        status: 'error',
        vehicles,
        pages,
        error: {
          code: res.status,
          message: `Upstream Wargaming request failed with HTTP ${res.status}`,
        },
      }
    }

    const body = (await res.json()) as WargamingEncyclopediaResponse
    if (body.status !== 'ok') {
      return {
        status: 'error',
        vehicles,
        pages,
        error: body.error ?? { code: 502, message: 'Upstream Wargaming error' },
      }
    }

    pages += 1
    if (!Number.isFinite(pageTotal)) {
      pageTotal = body.meta?.page_total ?? 1
    }

    const data = body.data ?? {}
    for (const [id, vehicle] of Object.entries(data)) {
      if (vehicle) vehicles[id] = vehicle
    }

    page += 1
  }

  return { status: 'ok', vehicles, pages }
}
