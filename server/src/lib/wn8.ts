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

// WN8 input counters snapshotted from each tank's `statistics.random.*` group.
// Lean on purpose: only what the WN8 formula consumes (the `random` group is what
// WN8 is defined against). `dropped_capture_points` is the defense stat.
const VEHICLE_FIELDS = [
  'battles',
  'wins',
  'damage_dealt',
  'spotted',
  'frags',
  'dropped_capture_points',
] as const

export type VehicleCounters = Record<(typeof VEHICLE_FIELDS)[number], number>

/// Per-account snapshot of all tanks' WN8 counters as a JSON map
/// `{ [tankId]: VehicleCounters }`.
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

/**
 * Extract the WN8 input counters for every tank of `accountId` from a
 * Wargaming tanks/stats response, as a `{ [tankId]: VehicleCounters }` map
 * (the `random` group). Returns `null` if the account isn't present in the
 * response payload (e.g. unknown account_id, or WG returned `null`).
 */
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
 * Write a per-vehicle snapshot row for the account unless one was captured
 * within the last `CAPTURE_DEDUP_MS` (5 min). When `skipIfInactive` is true
 * (the default), also no-ops if the freshly extracted counter map is byte-identical
 * to the most recent snapshot (the player hasn't played any vehicle since) —
 * tanks/stats has no per-tank `last_battle_time`, so the whole blob is compared.
 * The read path passes `skipIfInactive: false` so a recent row always lands.
 * No-ops if the account has no tanks in the response. A P2002 (same-second
 * concurrent capture) is ignored. Returns true when a new row was written.
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
 * Resolve the "current" per-tank counter map for an account. A snapshot
 * captured within the last `CAPTURE_DEDUP_MS` (5 min) is reused so repeated
 * WN8 queries don't hit Wargaming; otherwise tanks/stats is force-refreshed, a
 * fresh snapshot is recorded (skipped if the player hasn't played since the
 * last one), and the freshly fetched counters are used directly.
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
 * Per-tank field deltas (current minus past), negatives clamped to 0. Tanks
 * present in `current` but missing from `past` (first-seen) are taken at their
 * full current counters as the delta; tanks with `battles <= 0` after diffing
 * are dropped (no play in the window → no WN8 contribution).
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
 * The shared WN8 formula tail: apply the canonical clamp/cap then the weighted
 * sum to the five normalized ratios (rDAMAGE, rSPOT, rFRAG, rDEF, rWIN). Both the
 * per-tank path and the account-wide aggregate path funnel through here so the
 * nonlinear step cannot drift between them. Returns the unrounded WN8.
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

/**
 * Compute a single tank's WN8 from its counters and expected values, using the
 * canonical WN8 formula (ratios → clamp/cap → weighted sum). Returns 0 when
 * the tank has no battles or when expected values are missing.
 */
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
 * Account-wide WN8 from a per-tank counter map. WN8 is defined as a single
 * formula applied once to account-wide aggregates — NOT a battle-weighted mean
 * of per-tank WN8 scores (the clamp/cap nonlinearity does not compose). So we
 * sum all raw counters and all battle-weighted expected values across tanks,
 * then apply the formula once to those aggregates via `wn8FromRatios`.
 *
 * Tanks missing from `expectedById` (or with no expected values) are excluded
 * entirely — they contribute to neither the numerator nor the battle-weighted
 * expected denominator. `vehicleById` enriches the breakdown. Returns the
 * aggregate WN8, total battles counted, and a per-tank breakdown (each entry's
 * `wn8` is that tank's own WN8 via `computeTankWN8`, for display only).
 */
export const computeAccountWN8 = (
  perTank: VehicleStats,
  expectedById: Map<number, VehicleExpectedValue>,
  vehicleById: Map<number, Vehicle>
): { wn8: number; battles: number; perTank: TankWN8[] } => {
  // Account-wide aggregates: raw counters and battle-weighted expected values
  // accumulated across tanks, so the WN8 formula can be applied once to them.
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
    if (!Number.isFinite(tankId)) continue
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

/**
 * Compute the player's overall current WN8 from the cumulative per-tank
 * counters (no past anchor, no history required). Always available once the
 * account has played tanks with known expected values.
 */
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
 * Find a past per-vehicle snapshot to diff against (nearest at `>= days` ago,
 * else the oldest available past one), compute per-tank deltas, and aggregate
 * WN8 over the window. Returns `INSUFFICIENT_HISTORY` (422) only when no past
 * snapshot exists at all. Mirrors `computeRangeResult` in stats.ts.
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
 * Compute trailing-window WN8 over `days` days. "Current" per-tank counters
 * come from a snapshot captured within the last `CAPTURE_DEDUP_MS` if one
 * exists; otherwise tanks/stats is force-refreshed and a fresh snapshot is
 * recorded. The nearest snapshot at `>= days` ago is the past anchor; if none
 * is that old, the oldest available past snapshot is used (best-available),
 * with `from` showing the anchor actually used. Returns `INSUFFICIENT_HISTORY`
 * (422) only when no past snapshot exists at all.
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
 * Compute trailing-window WN8 for multiple windows in one call. "Current" is
 * fetched once and reused across all ranges; each range resolves its own past
 * anchor independently. An `INSUFFICIENT_HISTORY` entry appears in `ranges`
 * only when no past snapshot exists at all for that range; the whole request
 * never fails on a single range.
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
