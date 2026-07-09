import 'dotenv/config'
import { prisma } from './prisma.js'
import { getPlayerInfo, REALM } from './wargaming.js'
import type { WargamingInfoResponse } from './wargaming.js'

// Numeric counters snapshotted from statistics.all/random.* (an allowlist keeps
// deltas clean and the table small).
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

/// Snapshots older than this are GC'd by the daily capture job (not on the read
/// path). Kept above the max 30-day window so the sliding anchor has a past point.
const DAY_MS = 86_400_000
export const SNAPSHOT_GC_DAYS = 45

// Skip a new snapshot if one was captured within the last 5 min, so repeated
// queries don't spam rows. Reused by wn8.ts for per-vehicle snapshots.
export const CAPTURE_DEDUP_MS = 5 * 60 * 1000

// Trailing-window ranges (days) exposed by the stats endpoints.
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

/** Extract the allowlist counters from account/info. null if the account isn't present. */
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

/** Extract WG last_battle_time for inactivity detection. null if missing/non-numeric. */
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

/** Per-field current − past for both groups; negatives clamped to 0 (monotonic counters). */
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
 * Render-ready per-group metrics from a counter delta. Rates as percentages
 * (0–100), per-battle values raw; 0 when battles is 0 to avoid NaN/Infinity.
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
 * Write a snapshot unless one was captured within CAPTURE_DEDUP_MS. With
 * skipIfInactive (default) also no-op if last_battle_time is unchanged since
 * the last snapshot (keeps the daily job from stacking identical rows); the
 * read path passes false so a fresh row always lands. P2002 (same-second race)
 * is ignored. Returns true if a row was written.
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
    // P2002: a concurrent capture won the same-second race; the recent row
    // already serves the purpose.
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
 * Resolve the current counters: reuse a snapshot within CAPTURE_DEDUP_MS, else
 * force-refresh + capture + use the freshly fetched counters.
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
 * Diff against a past snapshot: nearest at >= days ago, else the oldest past
 * one (best-available, recorded in `from` so the client sees the real window).
 * INSUFFICIENT_HISTORY (422) only when no past snapshot exists. No GC here.
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
 * Trailing-window stat delta over `days` days. Current via getCurrentStats;
 * past anchor via computeRangeResult. INSUFFICIENT_HISTORY only when no past
 * snapshot exists — otherwise `from` shows the anchor actually used.
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
 * Deltas for multiple windows in one call: current is fetched once, each range
 * resolves its own anchor. A range with no history yields an
 * INSUFFICIENT_HISTORY entry, never a whole-request failure.
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
