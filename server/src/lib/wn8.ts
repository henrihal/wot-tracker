import 'dotenv/config'
import { prisma } from './prisma.js'
import { getPlayerVehicles, REALM } from './wargaming.js'
import type { WargamingVehicleStatsResponse } from './wargaming.js'
import { getExpectedValuesByIds, getVehiclesByIds } from './vehicles.js'
import type {
  Vehicle,
  VehicleExpectedValue,
} from '../../generated/prisma/client.js'
import { CAPTURE_DEDUP_MS } from './stats.js'

// WN8 input counters from each tank's statistics.random.* — only what the
// formula consumes (WN8 is defined against the random group).
const VEHICLE_FIELDS = [
  'battles',
  'wins',
  'damage_dealt',
  'spotted',
  'frags',
  'dropped_capture_points',
] as const

export type VehicleCounters = Record<(typeof VEHICLE_FIELDS)[number], number>

/// Per-account snapshot of all tanks' counters as `{ [tankId]: VehicleCounters }`.
export type VehicleStats = Record<string, VehicleCounters>

const DAY_MS = 86_400_000

const isNumericRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const pickCounters = (obj: unknown): VehicleCounters => {
  const out: VehicleCounters = {
    battles: 0,
    wins: 0,
    damage_dealt: 0,
    spotted: 0,
    frags: 0,
    dropped_capture_points: 0,
  }
  if (!isNumericRecord(obj)) return out
  for (const field of VEHICLE_FIELDS) {
    const v = obj[field]
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[field] = v
    }
  }
  return out
}

/** Extract per-tank WN8 counters from tanks/stats. null if the account isn't present. */
export const extractVehicleStats = (
  resp: WargamingVehicleStatsResponse,
  accountId: number
): VehicleStats | null => {
  const data = resp.data
  if (!data) return null
  const tanks = data[String(accountId)]
  if (!Array.isArray(tanks)) return null
  const out: VehicleStats = {}
  for (const tank of tanks) {
    if (!tank || typeof tank.tank_id !== 'number') continue
    out[String(tank.tank_id)] = pickCounters(tank.random)
  }
  return out
}

/**
 * Write a per-vehicle snapshot unless one was captured within CAPTURE_DEDUP_MS.
 * With skipIfInactive (default) also no-op if the blob is byte-identical to the
 * last snapshot (no per-tank last_battle_time exists to compare). P2002 ignored.
 * Returns true if a row was written.
 */
export const captureVehicleSnapshotIfStale = async (
  accountId: number,
  resp: WargamingVehicleStatsResponse,
  options: { skipIfInactive?: boolean } = {}
): Promise<boolean> => {
  const skipIfInactive = options.skipIfInactive ?? true

  const recent = await prisma.playerVehicleSnapshot.findFirst({
    where: {
      accountId,
      realm: REALM,
      capturedAt: { gt: new Date(Date.now() - CAPTURE_DEDUP_MS) },
    },
    orderBy: { capturedAt: 'desc' },
  })
  if (recent) return false

  const stats = extractVehicleStats(resp, accountId)
  if (!stats) return false
  const blob = JSON.stringify(stats)

  if (skipIfInactive) {
    const prev = await prisma.playerVehicleSnapshot.findFirst({
      where: { accountId, realm: REALM },
      orderBy: { capturedAt: 'desc' },
    })
    if (prev && prev.data === blob) {
      return false
    }
  }

  try {
    await prisma.playerVehicleSnapshot.create({
      data: {
        accountId,
        realm: REALM,
        data: blob,
      },
    })
  } catch (error) {
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
 * Resolve the current per-tank counters: reuse a snapshot within
 * CAPTURE_DEDUP_MS, else force-refresh + capture + use the fetched counters.
 */
const getCurrentVehicleStats = async (
  accountId: number
): Promise<
  | { status: 'ok'; current: VehicleStats }
  | { status: 'error'; error: { code: number; message: string } }
> => {
  const recent = await prisma.playerVehicleSnapshot.findFirst({
    where: {
      accountId,
      realm: REALM,
      capturedAt: { gt: new Date(Date.now() - CAPTURE_DEDUP_MS) },
    },
    orderBy: { capturedAt: 'desc' },
  })

  if (recent) {
    return { status: 'ok', current: JSON.parse(recent.data) as VehicleStats }
  }

  const resp = await getPlayerVehicles(accountId, { forceRefresh: true })
  if (resp.status !== 'ok') {
    return {
      status: 'error',
      error: resp.error ?? { code: 502, message: 'Upstream Wargaming error' },
    }
  }
  await captureVehicleSnapshotIfStale(accountId, resp, {
    skipIfInactive: false,
  })
  const current = extractVehicleStats(resp, accountId)
  if (!current) {
    return {
      status: 'error',
      error: { code: 422, message: 'INSUFFICIENT_HISTORY' },
    }
  }
  return { status: 'ok', current }
}

/**
 * Per-tank current − past, negatives clamped to 0. First-seen tanks use their
 * full current counters; tanks with battles <= 0 after diffing are dropped.
 */
export const computeVehicleDelta = (
  past: VehicleStats,
  current: VehicleStats
): VehicleStats => {
  const out: VehicleStats = {}
  for (const [id, cur] of Object.entries(current)) {
    const prev = past[id]
    const delta: VehicleCounters = {
      battles: 0,
      wins: 0,
      damage_dealt: 0,
      spotted: 0,
      frags: 0,
      dropped_capture_points: 0,
    }
    for (const field of VEHICLE_FIELDS) {
      const c = cur[field] ?? 0
      const p = prev?.[field] ?? 0
      const d = c - p
      delta[field] = d < 0 ? 0 : d
    }
    if (delta.battles > 0) out[id] = delta
  }
  return out
}

const safeDiv = (n: number, d: number): number => (d > 0 ? n / d : 0)

/**
 * WN8 formula tail: clamp/cap then weighted sum. Shared by the per-tank and
 * aggregate paths so the nonlinear step can't drift between them. Unrounded.
 */
const wn8FromRatios = (
  rDAMAGE: number,
  rSPOT: number,
  rFRAG: number,
  rDEF: number,
  rWIN: number
): number => {
  const rWINc = Math.max(0, (rWIN - 0.71) / 0.29)
  const rDAMAGEc = Math.max(0, (rDAMAGE - 0.22) / 0.78)
  const rFRAGc = Math.max(0, Math.min(rDAMAGEc + 0.2, (rFRAG - 0.12) / 0.88))
  const rSPOTc = Math.max(0, Math.min(rDAMAGEc + 0.1, (rSPOT - 0.38) / 0.62))
  const rDEFc = Math.max(0, Math.min(rDAMAGEc + 0.1, (rDEF - 0.1) / 0.9))

  return (
    980 * rDAMAGEc +
    210 * rDAMAGEc * rFRAGc +
    155 * rFRAGc * rSPOTc +
    75 * rDEFc * rFRAGc +
    145 * Math.min(1.8, rWINc)
  )
}

/** Single-tank WN8 via the canonical formula. 0 when no battles or no expected values. */
export const computeTankWN8 = (
  counters: VehicleCounters,
  exp: VehicleExpectedValue | undefined
): number => {
  const battles = counters.battles
  if (battles <= 0 || !exp) return 0

  const rDAMAGE = safeDiv(counters.damage_dealt, battles) / exp.expDamage
  const rSPOT = safeDiv(counters.spotted, battles) / exp.expSpot
  const rFRAG = safeDiv(counters.frags, battles) / exp.expFrag
  const rDEF = safeDiv(counters.dropped_capture_points, battles) / exp.expDef
  const rWIN = (safeDiv(counters.wins, battles) * 100) / exp.expWinRate

  return Math.round(wn8FromRatios(rDAMAGE, rSPOT, rFRAG, rDEF, rWIN))
}

export interface TankWN8 extends VehicleCounters {
  tankId: number
  name: string
  tier: number
  type: string
  wn8: number
}

/**
 * Account-wide WN8 = the formula applied once to account-wide aggregates, NOT a
 * battle-weighted mean of per-tank scores (the clamp/cap nonlinearity doesn't
 * compose). Tanks missing expected values are excluded entirely. Returns the
 * aggregate wn8, total battles, and a display-only per-tank breakdown.
 */
export const computeAccountWN8 = (
  perTank: VehicleStats,
  expectedById: Map<number, VehicleExpectedValue>,
  vehicleById: Map<number, Vehicle>
): { wn8: number; battles: number; perTank: TankWN8[] } => {
  // Aggregate raw counters and battle-weighted expected values across tanks so
  // the formula can be applied once to them.
  const total = {
    damage: 0,
    spot: 0,
    frag: 0,
    def: 0,
    win: 0,
    battles: 0,
    expDmg: 0,
    expSpot: 0,
    expFrag: 0,
    expDef: 0,
    expWin: 0,
  }
  const breakdown: TankWN8[] = []

  for (const [id, counters] of Object.entries(perTank)) {
    const tankId = Number.parseInt(id, 10)
    const exp = expectedById.get(tankId)
    if (!exp) continue
    const b = counters.battles
    if (b <= 0) continue

    total.damage += counters.damage_dealt
    total.spot += counters.spotted
    total.frag += counters.frags
    total.def += counters.dropped_capture_points
    total.win += counters.wins
    total.battles += b
    total.expDmg += exp.expDamage * b
    total.expSpot += exp.expSpot * b
    total.expFrag += exp.expFrag * b
    total.expDef += exp.expDef * b
    total.expWin += exp.expWinRate * b

    const tankWN8 = computeTankWN8(counters, exp)
    const vehicle = vehicleById.get(tankId)
    breakdown.push({
      tankId,
      ...counters,
      name: vehicle?.name ?? '',
      tier: vehicle?.tier ?? 0,
      type: vehicle?.type ?? '',
      wn8: tankWN8,
    })
  }

  breakdown.sort((a, b) => b.battles - a.battles)
  const wn8 =
    total.battles > 0
      ? Math.round(
          wn8FromRatios(
            safeDiv(total.damage, total.expDmg),
            safeDiv(total.spot, total.expSpot),
            safeDiv(total.frag, total.expFrag),
            safeDiv(total.def, total.expDef),
            (total.win * 100) / total.expWin
          )
        )
      : 0
  return { wn8, battles: total.battles, perTank: breakdown }
}

const resolveInputs = async (
  perTank: VehicleStats
): Promise<{
  expectedById: Map<number, VehicleExpectedValue>
  vehicleById: Map<number, Vehicle>
}> => {
  const tankIds = Object.keys(perTank)
    .map((id) => Number.parseInt(id, 10))
    .filter((n) => Number.isFinite(n))
  const [expectedById, vehicleById] = await Promise.all([
    getExpectedValuesByIds(tankIds),
    getVehiclesByIds(tankIds),
  ])
  return { expectedById, vehicleById }
}

export type Wn8CurrentResult =
  | {
      status: 'ok'
      wn8: number
      battles: number
      perTank: TankWN8[]
    }
  | { status: 'error'; error: { code: number; message: string } }

/** Overall current WN8 from cumulative counters (no past anchor, no history needed). */
export const getWN8Current = async (
  accountId: number
): Promise<Wn8CurrentResult> => {
  const cur = await getCurrentVehicleStats(accountId)
  if (cur.status !== 'ok') return cur

  const { expectedById, vehicleById } = await resolveInputs(cur.current)
  const result = computeAccountWN8(cur.current, expectedById, vehicleById)
  return { status: 'ok', ...result }
}

export type Wn8DeltaResult =
  | {
      status: 'ok'
      range: number
      from: Date
      wn8: number
      battles: number
      perTank: TankWN8[]
    }
  | { status: 'error'; error: { code: number; message: string } }

/**
 * Diff against a past per-vehicle snapshot (nearest at >= days, else oldest),
 * compute per-tank deltas, and aggregate WN8 over the window.
 * INSUFFICIENT_HISTORY only when no past snapshot exists. Mirrors stats.ts.
 */
const computeRangeResult = async (
  accountId: number,
  days: number,
  current: VehicleStats
): Promise<Wn8DeltaResult> => {
  let past = await prisma.playerVehicleSnapshot.findFirst({
    where: {
      accountId,
      realm: REALM,
      capturedAt: { lte: new Date(Date.now() - days * DAY_MS) },
    },
    orderBy: { capturedAt: 'desc' },
  })
  if (!past) {
    past = await prisma.playerVehicleSnapshot.findFirst({
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

  const pastStats = JSON.parse(past.data) as VehicleStats
  const deltas = computeVehicleDelta(pastStats, current)
  const { expectedById, vehicleById } = await resolveInputs(deltas)
  const result = computeAccountWN8(deltas, expectedById, vehicleById)
  return {
    status: 'ok',
    range: days,
    from: past.capturedAt,
    wn8: result.wn8,
    battles: result.battles,
    perTank: result.perTank,
  }
}

/**
 * Trailing-window WN8 over `days` days. Current via getCurrentVehicleStats;
 * past via computeRangeResult. INSUFFICIENT_HISTORY only when no past snapshot
 * exists; `from` shows the anchor actually used.
 */
export const getWN8Delta = async (
  accountId: number,
  days: number
): Promise<Wn8DeltaResult> => {
  const cur = await getCurrentVehicleStats(accountId)
  if (cur.status !== 'ok') return cur
  return computeRangeResult(accountId, days, cur.current)
}

export interface Wn8SummaryOk {
  status: 'ok'
  ranges: Wn8DeltaResult[]
}

export type Wn8SummaryResult =
  Wn8SummaryOk | { status: 'error'; error: { code: number; message: string } }

/**
 * WN8 for multiple windows in one call: current fetched once, each range
 * resolves its own anchor. A range with no history yields an
 * INSUFFICIENT_HISTORY entry, never a whole-request failure.
 */
export const getWN8Summary = async (
  accountId: number,
  days: number[]
): Promise<Wn8SummaryResult> => {
  const cur = await getCurrentVehicleStats(accountId)
  if (cur.status !== 'ok') return cur

  const ranges = await Promise.all(
    days.map((d) => computeRangeResult(accountId, d, cur.current))
  )
  return { status: 'ok', ranges }
}
