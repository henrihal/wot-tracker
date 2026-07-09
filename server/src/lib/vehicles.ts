import 'dotenv/config'
import { prisma } from './prisma.js'
import { getVehicleEncyclopedia } from './wargaming.js'
import type {
  Vehicle,
  VehicleExpectedValue,
} from '../../generated/prisma/client.js'

// XVM publishes the canonical WN8 expected values (WG doesn't expose them).
// Refresh on demand via POST /admin/wn8/refresh-expected.
const MODXVM_WN8_URL =
  'https://static.modxvm.com/wn8-data-exp/json/wg/wn8exp.json'

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
 * Fetch the full WG vehicle encyclopedia (paginated) and upsert every tank into
 * `Vehicle` keyed by tankId. Admin-triggered (not a TTL cache) since it changes
 * rarely. Returns tanks upserted and pages fetched.
 */
export const refreshVehicleEncyclopedia = async (): Promise<
  EncyclopediaRefreshSummary & {
    status: 'ok' | 'error'
    error?: { code: number; message: string }
  }
> => {
  const result = await getVehicleEncyclopedia()
  if (result.status !== 'ok') {
    return {
      status: 'error',
      tanks: 0,
      pages: result.pages,
      error: {
        code: 502,
        message: result.error?.message ?? 'Upstream Wargaming error',
      },
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
 * Fetch the XVM expected-values JSON and upsert every tank into
 * `VehicleExpectedValue` keyed by tankId (the JSON IDNum). Stores the XVM
 * header.version. Returns the count and version.
 */
export const refreshExpectedValues = async (): Promise<
  ExpectedValuesRefreshSummary & {
    status: 'ok' | 'error'
    error?: { code: number; message: string }
  }
> => {
  let res: Response
  try {
    res = await fetch(MODXVM_WN8_URL)
  } catch {
    return {
      status: 'error',
      expected: 0,
      version: '',
      error: {
        code: 502,
        message:
          'Upstream XVM request failed: network error contacting the API.',
      },
    }
  }
  if (!res.ok) {
    return {
      status: 'error',
      expected: 0,
      version: '',
      error: {
        code: 502,
        message: `Upstream XVM request failed with HTTP ${res.status}`,
      },
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

/** Batch-load `Vehicle` rows into a Map keyed by tankId (enriches WN8 results). */
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
 * Batch-load `VehicleExpectedValue` rows into a Map keyed by tankId. Tanks
 * missing from this map are excluded from WN8 (no expected values to compute
 * against).
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
