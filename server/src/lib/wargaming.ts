import 'dotenv/config'
import { prisma } from './prisma.js'

const REALMS = ['eu', 'na', 'asia', 'ru'] as const
type Realm = (typeof REALMS)[number]

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

const REALM = resolveRealm()

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

const API_URL = `https://${API_HOSTS[REALM]}/wot/account/list/`
const INFO_API_URL = `https://${API_HOSTS[REALM]}/wot/account/info/`

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
    return {
      status: 'error',
      error: {
        code: 402,
        message: 'SEARCH_NOT_SPECIFIED: Search parameter not specified.',
        field: 'search',
        value: '',
      },
    }
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

  const res = await fetch(url)
  if (!res.ok) {
    return {
      status: 'error',
      error: {
        code: res.status,
        message: `Upstream Wargaming request failed with HTTP ${res.status}`,
      },
    }
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
 * all public statistics.* extras) is fetched once and cached permanently in
 * SQLite keyed by [account_id, realm]; subsequent calls are served from cache.
 * forceRefresh re-fetches and overwrites the cached row. private.* extras are
 * not fetched (they require an access_token we don't have).
 */
export const getPlayerInfo = async (
  accountId: number,
  opts: GetPlayerInfoOptions = {}
): Promise<WargamingInfoResponse> => {
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return {
      status: 'error',
      error: {
        code: 402,
        message:
          'ACCOUNT_ID_NOT_SPECIFIED: account_id must be a positive integer.',
        field: 'account_id',
        value: accountId,
      },
    }
  }

  if (!opts.forceRefresh) {
    const cached = await prisma.playerInfoCache.findUnique({
      where: { accountId_realm: { accountId, realm: REALM } },
    })
    if (cached) {
      return JSON.parse(cached.response) as WargamingInfoResponse
    }
  }

  const url = new URL(INFO_API_URL)
  url.searchParams.set('application_id', APPLICATION_ID)
  url.searchParams.set('account_id', String(accountId))
  url.searchParams.set('extra', PUBLIC_EXTRA_FIELDS.join(','))

  const res = await fetch(url)
  if (!res.ok) {
    return {
      status: 'error',
      error: {
        code: res.status,
        message: `Upstream Wargaming request failed with HTTP ${res.status}`,
      },
    }
  }

  const body = (await res.json()) as WargamingInfoResponse

  if (body.status === 'ok') {
    const response = JSON.stringify(body)
    await prisma.playerInfoCache.upsert({
      where: { accountId_realm: { accountId, realm: REALM } },
      create: { accountId, realm: REALM, response },
      update: { response, fetchedAt: new Date() },
    })
  }

  return body
}
