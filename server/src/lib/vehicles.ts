import 'dotenv/config'
import { prisma } from './prisma.js'
import { getVehicleEncyclopedia } from './wargaming.js'
import type {
  Vehicle,
  VehicleExpectedValue,
} from '../../generated/prisma/client.js'

// XVM publishes the canonical WN8 expected-values dataset (per-tank
// expDamage/expSpot/expFrag/expDef/expWinRate). Wargaming does NOT expose these;
// they are derived from active-player statistics by XVM and recalculated daily.
// We don't need that cadence — refresh on demand via POST /admin/wn8/refresh-expected.
const MODXVM_WN8_URL = 'https://static.modxvm.com/wn8-data-exp/json/wg/wn8exp.json'

interface Wn8ExpectedEntry {
  IDNum: number
  expFrag: number
  expDamage: number
  expSpot: number
  expDef: number
  expWinRate: number
}

interface Wn8ExpectedFile {
  header?: { version?: string }
  data?: Wn8ExpectedEntry[]
}

export interface EncyclopediaRefreshSummary {
  tanks: number
  pages: number
}

/**
 * Fetch the full vehicle encyclopedia from Wargaming (paginated) and upsert
 * every tank into the `Vehicle` table keyed by `tankId`. Encyclopedia changes
 * rarely (new tanks), so this is an explicit admin-triggered refresh, not a
 * TTL read cache. Returns the count of tanks upserted and pages fetched.
 */
export const refreshVehicleEncyclopedia = async (): Promise<
  EncyclopediaRefreshSummary & { status: 'ok' | 'error'; error?: string }
> => {
  const result = await getVehicleEncyclopedia()
  if (result.status !== 'ok') {
    return {
      status: 'error',
      tanks: 0,
      pages: result.pages,
      error: result.error?.message ?? 'Upstream Wargaming error',
    }
  }

  const vehicles = Object.values(result.vehicles)
  for (const v of vehicles) {
    await prisma.vehicle.upsert({
      where: { tankId: v.tank_id },
      create: {
        tankId: v.tank_id,
        name: v.name,
        shortName: v.short_name,
        nation: v.nation,
        tier: v.tier,
        type: v.type,
        isPremium: v.is_premium,
        tag: v.tag,
      },
      update: {
        name: v.name,
        shortName: v.short_name,
        nation: v.nation,
        tier: v.tier,
        type: v.type,
        isPremium: v.is_premium,
        tag: v.tag,
        fetchedAt: new Date(),
      },
    })
  }

  return { status: 'ok', tanks: vehicles.length, pages: result.pages }
}

export interface ExpectedValuesRefreshSummary {
  expected: number
  version: string
}

/**
 * Fetch the XVM WN8 expected-values JSON and upsert every tank's expected
 * values into `VehicleExpectedValue` keyed by `tankId` (the JSON `IDNum`).
 * Stores the XVM `header.version` date stamp. Returns the count and version.
 */
export const refreshExpectedValues = async (): Promise<
  ExpectedValuesRefreshSummary & { status: 'ok' | 'error'; error?: string }
> => {
  let res: Response
  try {
    res = await fetch(MODXVM_WN8_URL)
  } catch {
    return {
      status: 'error',
      expected: 0,
      version: '',
      error: 'Upstream XVM request failed: network error contacting the API.',
    }
  }
  if (!res.ok) {
    return {
      status: 'error',
      expected: 0,
      version: '',
      error: `Upstream XVM request failed with HTTP ${res.status}`,
    }
  }

  const body = (await res.json()) as Wn8ExpectedFile
  const version = body.header?.version ?? ''
  const entries = body.data ?? []

  for (const entry of entries) {
    await prisma.vehicleExpectedValue.upsert({
      where: { tankId: entry.IDNum },
      create: {
        tankId: entry.IDNum,
        expFrag: entry.expFrag,
        expDamage: entry.expDamage,
        expSpot: entry.expSpot,
        expDef: entry.expDef,
        expWinRate: entry.expWinRate,
        version,
      },
      update: {
        expFrag: entry.expFrag,
        expDamage: entry.expDamage,
        expSpot: entry.expSpot,
        expDef: entry.expDef,
        expWinRate: entry.expWinRate,
        version,
        fetchedAt: new Date(),
      },
    })
  }

  return { status: 'ok', expected: entries.length, version }
}

/**
 * Batch-load `Vehicle` rows for the given tank_ids, returning a `Map` keyed by
 * `tankId`. Used to enrich WN8 results with name/tier/type.
 */
export const getVehiclesByIds = async (
  tankIds: number[]
): Promise<Map<number, Vehicle>> => {
  if (tankIds.length === 0) return new Map()
  const rows = await prisma.vehicle.findMany({
    where: { tankId: { in: tankIds } },
  })
  const map = new Map<number, Vehicle>()
  for (const row of rows) map.set(row.tankId, row)
  return map
}

/**
 * Batch-load `VehicleExpectedValue` rows for the given tank_ids, returning a
 * `Map` keyed by `tankId`. Tanks missing from this map are excluded from WN8
 * (their per-tank WN8 can't be computed without expected values).
 */
export const getExpectedValuesByIds = async (
  tankIds: number[]
): Promise<Map<number, VehicleExpectedValue>> => {
  if (tankIds.length === 0) return new Map()
  const rows = await prisma.vehicleExpectedValue.findMany({
    where: { tankId: { in: tankIds } },
  })
  const map = new Map<number, VehicleExpectedValue>()
  for (const row of rows) map.set(row.tankId, row)
  return map
}
