import 'dotenv/config'
import { prisma } from './prisma.js'
import { getPlayerInfo, getPlayerVehicles, REALM } from './wargaming.js'
import { captureSnapshotIfStale, SNAPSHOT_GC_DAYS } from './stats.js'
import { captureVehicleSnapshotIfStale } from './wn8.js'

const DAY_MS = 86_400_000
const JOB_INTERVAL_MS = 24 * 60 * 60 * 1000

// Daily capture job: snapshots every tracked account once a day so trailing
// 7/14/30-day windows stay meaningful regardless of query traffic. Off by
// default (SNAPSHOT_JOB_ENABLED=true).
const JOB_ENABLED = process.env['SNAPSHOT_JOB_ENABLED'] === 'true'

export interface CaptureJobSummary {
  tracked: number
  captured: number
  vehicleCaptured: number
  errors: number
  gcDeleted: number
}

/**
 * For each tracked account, force-refresh profile + tanks/stats and write a
 * snapshot (5-min dedup + skip-if-inactive so the daily job doesn't stack
 * identical rows), then GC both snapshot tables older than SNAPSHOT_GC_DAYS.
 * Safe to call manually (POST /admin/snapshots/run) or from the interval.
 */
export const runCaptureJob = async (): Promise<CaptureJobSummary> => {
  const tracked = await prisma.trackedAccount.findMany({
    where: { realm: REALM },
  })

  let captured = 0
  let vehicleCaptured = 0
  let errors = 0
  for (const account of tracked) {
    try {
      const info = await getPlayerInfo(account.accountId, {
        forceRefresh: true,
      })
      if (info.status !== 'ok') {
        errors += 1
        continue
      }
      if (await captureSnapshotIfStale(account.accountId, info)) {
        captured += 1
      }

      // Per-vehicle snapshot for trailing-window WN8; a failure here doesn't
      // undo the account-level snapshot already written.
      const vehicles = await getPlayerVehicles(account.accountId, {
        forceRefresh: true,
      })
      if (vehicles.status === 'ok') {
        if (await captureVehicleSnapshotIfStale(account.accountId, vehicles)) {
          vehicleCaptured += 1
        }
      } else {
        errors += 1
      }
    } catch (error) {
      // One account's transient failure must not abort the remaining captures
      // or the GC pass below.
      errors += 1
      console.error('capture failed for', account.accountId, error)
    }
  }

  const cutoff = new Date(Date.now() - SNAPSHOT_GC_DAYS * DAY_MS)
  const gc = await prisma.playerStatsSnapshot.deleteMany({
    where: { realm: REALM, capturedAt: { lt: cutoff } },
  })
  const vehicleGc = await prisma.playerVehicleSnapshot.deleteMany({
    where: { realm: REALM, capturedAt: { lt: cutoff } },
  })

  return {
    tracked: tracked.length,
    captured,
    vehicleCaptured,
    errors,
    gcDeleted: gc.count + vehicleGc.count,
  }
}

/**
 * Start the daily interval (plus one boot tick so a fresh "now" snapshot exists
 * right after restart) when SNAPSHOT_JOB_ENABLED=true.
 */
export const startScheduler = (): void => {
  if (!JOB_ENABLED) return
  const tick = (): void => {
    void runCaptureJob().catch((error) => {
      console.error('Snapshot capture job failed:', error)
    })
  }
  setInterval(tick, JOB_INTERVAL_MS)
  tick()
}
