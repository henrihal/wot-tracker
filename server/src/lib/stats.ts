import 'dotenv/config'
import { prisma } from './prisma.js'
import { getPlayerInfo, REALM } from './wargaming.js'
import type { WargamingInfoResponse } from './wargaming.js'

// Core numeric counters snapshotted from `statistics.all.*` and
// `statistics.random.*`. A fixed allowlist (not the whole response) keeps
// deltas clean and the snapshot table small.
const CORE_FIELDS = [
  'battles',
  'wins',
  'losses',
  'draws',
  'damage_dealt',
  'xp',
  'frags',
  'spotted',
  'hits',
  'shots',
  'survived_battles',
  'max_xp',
] as const

const SNAPSHOT_GROUPS = ['all', 'random'] as const

type SnapshotGroup = (typeof SNAPSHOT_GROUPS)[number]

export type SnapshotData = Record<SnapshotGroup, Record<string, number>>

/// Trailing-window retention. Snapshots older than this are GC'd by the daily
/// capture job (not on the read path). Kept well above the max delta window
/// (30 days) so the sliding anchor always has a usable past point.
const DAY_MS = 86_400_000
export const SNAPSHOT_GC_DAYS = 45

// Skip writing a new snapshot if one was captured for this account within the
// last 5 minutes, so repeated stats queries don't spam rows.
const CAPTURE_DEDUP_MS = 5 * 60 * 1000

// Valid trailing-window ranges (days) exposed by the stats endpoints.
const VALID_RANGES = [7, 14, 30] as const
export type StatsRange = (typeof VALID_RANGES)[number]

export const isValidRange = (days: number): days is StatsRange =>
  (VALID_RANGES as readonly number[]).includes(days)

const isNumericRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const pickNumeric = (
  obj: unknown,
  fields: readonly string[]
): Record<string, number> => {
  const out: Record<string, number> = {}
  if (!isNumericRecord(obj)) return out
  for (const field of fields) {
    const v = obj[field]
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[field] = v
    }
  }
  return out
}

/**
 * Extract the allowlist of numeric counters from a Wargaming account/info
 * response. Returns `null` if the account isn't present in the response payload
 * (e.g. unknown account_id, or WG returned `null` for it).
 */
export const extractStats = (
  info: WargamingInfoResponse,
  accountId: number
): SnapshotData | null => {
  const data = info.data
  if (!data) return null
  const player = data[String(accountId)]
  if (!player) return null
  const statistics = player['statistics']
  if (!isNumericRecord(statistics)) return null
  return {
    all: pickNumeric(statistics['all'], CORE_FIELDS),
    random: pickNumeric(statistics['random'], CORE_FIELDS),
  }
}

/**
 * Extract the WG `last_battle_time` unix timestamp for an account, used to
 * detect whether the player has played since the previous snapshot. Returns
 * `null` if the field is missing or non-numeric.
 */
export const extractLastBattleTime = (
  info: WargamingInfoResponse,
  accountId: number
): number | null => {
  const data = info.data
  if (!data) return null
  const player = data[String(accountId)]
  if (!isNumericRecord(player)) return null
  const v = player['last_battle_time']
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Subtract each allowlist field field-by-field (past from current) for both
 * `all` and `random`. Negative deltas are clamped to 0 — these are monotonic
 * cumulative counters, so a negative implies a WG reset or a stale/buggy
 * snapshot rather than real play.
 */
export const computeDelta = (
  past: SnapshotData,
  current: SnapshotData
): SnapshotData => {
  const forGroup = (group: SnapshotGroup): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const field of CORE_FIELDS) {
      const c = current[group][field] ?? 0
      const p = past[group][field] ?? 0
      const d = c - p
      out[field] = d < 0 ? 0 : d
    }
    return out
  }
  return { all: forGroup('all'), random: forGroup('random') }
}

/**
 * Render-ready per-group metrics derived from a counter delta. Rates are
 * expressed as percentages (0–100); per-battle averages are raw ratios. All
 * values default to 0 when `battles` is 0 to avoid NaN/Infinity.
 */
export interface DerivedMetrics {
  battles: number
  winRate: number
  avgDamage: number
  avgFrags: number
  avgXp: number
  hitRate: number
  survivalRate: number
}

export type MetricsByGroup = Record<SnapshotGroup, DerivedMetrics>

const safeDiv = (n: number, d: number): number => (d > 0 ? n / d : 0)

export const deriveGroupMetrics = (
  delta: Record<string, number>
): DerivedMetrics => {
  const battles = delta['battles'] ?? 0
  const wins = delta['wins'] ?? 0
  const damage = delta['damage_dealt'] ?? 0
  const frags = delta['frags'] ?? 0
  const xp = delta['xp'] ?? 0
  const hits = delta['hits'] ?? 0
  const shots = delta['shots'] ?? 0
  const survived = delta['survived_battles'] ?? 0
  return {
    battles,
    winRate: safeDiv(wins, battles) * 100,
    avgDamage: safeDiv(damage, battles),
    avgFrags: safeDiv(frags, battles),
    avgXp: safeDiv(xp, battles),
    hitRate: safeDiv(hits, shots) * 100,
    survivalRate: safeDiv(survived, battles) * 100,
  }
}

export const deriveMetrics = (delta: SnapshotData): MetricsByGroup => ({
  all: deriveGroupMetrics(delta['all']),
  random: deriveGroupMetrics(delta['random']),
})

/**
 * Write a snapshot row for the account unless one was captured within the last
 * `CAPTURE_DEDUP_MS`. When `skipIfInactive` is true (the default), also no-ops
 * if the player's `last_battle_time` is unchanged since the most recent
 * snapshot (i.e. they haven't played) — this keeps the daily capture job from
 * stacking identical rows. The read path passes `skipIfInactive: false` so a
 * recent row always lands within `CAPTURE_DEDUP_MS` and the next stats query is
 * served from the snapshot instead of hitting Wargaming, preserving the
 * documented 5-min-per-account throttle for inactive as well as active
 * players. No-ops if the account has no parseable statistics in the response. A
 * unique-constraint collision (two concurrent captures landing in the same
 * second) is ignored — the recent row already serves the purpose. Returns true
 * when a new row was written.
 */
export const captureSnapshotIfStale = async (
  accountId: number,
  info: WargamingInfoResponse,
  options: { skipIfInactive?: boolean } = {}
): Promise<boolean> => {
  const skipIfInactive = options.skipIfInactive ?? true

  const recent = await prisma.playerStatsSnapshot.findFirst({
    where: {
      accountId,
      realm: REALM,
      capturedAt: { gt: new Date(Date.now() - CAPTURE_DEDUP_MS) },
    },
    orderBy: { capturedAt: 'desc' },
  })
  if (recent) return false

  const stats = extractStats(info, accountId)
  if (!stats) return false

  const lastBattleTime = extractLastBattleTime(info, accountId)
  if (skipIfInactive && lastBattleTime !== null) {
    const prev = await prisma.playerStatsSnapshot.findFirst({
      where: { accountId, realm: REALM },
      orderBy: { capturedAt: 'desc' },
    })
    if (
      prev &&
      prev.lastBattleTime !== null &&
      prev.lastBattleTime === lastBattleTime
    ) {
      return false
    }
  }

  try {
    await prisma.playerStatsSnapshot.create({
      data: {
        accountId,
        realm: REALM,
        lastBattleTime: lastBattleTime ?? null,
        data: JSON.stringify(stats),
      },
    })
  } catch (error) {
    // P2002 = unique-constraint violation on [accountId, realm, capturedAt]:
    // a concurrent capture won the race within the same second. Ignore it.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error['code'] === 'P2002'
    ) {
      return false
    }
    throw error
  }
  return true
}

/**
 * Resolve the "current" counter set for an account. A snapshot captured within
 * the last `CAPTURE_DEDUP_MS` (5 min) is reused so repeated stats queries don't
 * hit Wargaming; otherwise the profile is force-refreshed, a fresh snapshot is
 * recorded (skipped if the player hasn't played since the last one), and the
 * freshly fetched counters are used directly.
 */
const getCurrentStats = async (
  accountId: number
): Promise<
  | { status: 'ok'; current: SnapshotData }
  | { status: 'error'; error: { code: number; message: string } }
> => {
  const recent = await prisma.playerStatsSnapshot.findFirst({
    where: {
      accountId,
      realm: REALM,
      capturedAt: { gt: new Date(Date.now() - CAPTURE_DEDUP_MS) },
    },
    orderBy: { capturedAt: 'desc' },
  })

  if (recent) {
    return { status: 'ok', current: JSON.parse(recent.data) as SnapshotData }
  }

  const info = await getPlayerInfo(accountId, { forceRefresh: true })
  if (info.status !== 'ok') {
    return {
      status: 'error',
      error: info.error ?? { code: 502, message: 'Upstream Wargaming error' },
    }
  }
  await captureSnapshotIfStale(accountId, info, { skipIfInactive: false })
  const current = extractStats(info, accountId)
  if (!current) {
    return {
      status: 'error',
      error: { code: 422, message: 'INSUFFICIENT_HISTORY' },
    }
  }
  return { status: 'ok', current }
}

/**
 * Find a past snapshot to diff against and compute the delta + derived metrics
 * over the supplied current counters. Prefers the nearest snapshot at least
 * `days` old so the window matches the request; if none is old enough (the
 * account has been tracked for less than `days`), falls back to the OLDEST
 * available past snapshot so the client still gets a best-available diff
 * rather than a 422 — `from` records the anchor actually used, so a client can
 * tell when the real window is shorter than `range`. The fallback excludes
 * rows within `CAPTURE_DEDUP_MS` of now so we never diff against the
 * just-captured "current" row. Returns `INSUFFICIENT_HISTORY` (422) only when
 * no past snapshot exists at all. GC is intentionally not performed here — it
 * runs in the daily capture job only.
 */
const computeRangeResult = async (
  accountId: number,
  days: number,
  current: SnapshotData
): Promise<StatsDeltaResult> => {
  let past = await prisma.playerStatsSnapshot.findFirst({
    where: {
      accountId,
      realm: REALM,
      capturedAt: { lte: new Date(Date.now() - days * DAY_MS) },
    },
    orderBy: { capturedAt: 'desc' },
  })
  if (!past) {
    past = await prisma.playerStatsSnapshot.findFirst({
      where: {
        accountId,
        realm: REALM,
        capturedAt: { lt: new Date(Date.now() - CAPTURE_DEDUP_MS) },
      },
      orderBy: { capturedAt: 'asc' },
    })
  }
  if (!past) {
    return {
      status: 'error',
      error: { code: 422, message: 'INSUFFICIENT_HISTORY' },
    }
  }

  const pastStats = JSON.parse(past.data) as SnapshotData
  const deltas = computeDelta(pastStats, current)
  return {
    status: 'ok',
    range: days,
    from: past.capturedAt,
    deltas,
    metrics: deriveMetrics(deltas),
  }
}

export type StatsDeltaResult =
  | {
      status: 'ok'
      range: number
      from: Date
      deltas: SnapshotData
      metrics: MetricsByGroup
    }
  | { status: 'error'; error: { code: number; message: string } }

/**
 * Compute per-field stat deltas and derived metrics over a trailing window of
 * `days` days. "Current" stats come from a snapshot captured within the last
 * `CAPTURE_DEDUP_MS` (5 min) if one exists; otherwise the profile is
 * force-refreshed and a fresh snapshot is recorded. The nearest snapshot at
 * >= `days` ago is used as the past anchor; if none is that old, the oldest
 * available past snapshot is used as a best-available anchor (see
 * `computeRangeResult`). Returns `INSUFFICIENT_HISTORY` (422) only when no
 * past snapshot exists at all — otherwise the diff is always returned, with
 * `from` showing the anchor actually used.
 */
export const getStatsDelta = async (
  accountId: number,
  days: number
): Promise<StatsDeltaResult> => {
  const cur = await getCurrentStats(accountId)
  if (cur.status !== 'ok') return cur
  return computeRangeResult(accountId, days, cur.current)
}

export interface StatsSummaryOk {
  status: 'ok'
  ranges: StatsDeltaResult[]
}

export type StatsSummaryResult =
  StatsSummaryOk | { status: 'error'; error: { code: number; message: string } }

/**
 * Compute deltas + derived metrics for multiple trailing windows in one call.
 * "Current" is fetched once and reused across all ranges; each range resolves
 * its own past anchor independently (preferring a snapshot at least `days` old,
 * else the oldest available past one). An `INSUFFICIENT_HISTORY` entry appears
 * in `ranges` only when no past snapshot exists at all for that range; the
 * whole request never fails on a single range, so a frontend can render
 * partial tables.
 */
export const getStatsSummary = async (
  accountId: number,
  days: number[]
): Promise<StatsSummaryResult> => {
  const cur = await getCurrentStats(accountId)
  if (cur.status !== 'ok') return cur

  const ranges = await Promise.all(
    days.map((d) => computeRangeResult(accountId, d, cur.current))
  )
  return { status: 'ok', ranges }
}
