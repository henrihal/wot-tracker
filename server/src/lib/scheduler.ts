import 'dotenv/config'
import { prisma } from './prisma.js'
import { getPlayerInfo, REALM } from './wargaming.js'
import { captureSnapshotIfStale, SNAPSHOT_GC_DAYS } from './stats.js'

const DAY_MS = 86_400_000
const JOB_INTERVAL_MS = 24 * 60 * 60 * 1000

// The daily capture job snapshots every tracked account once a day so trailing
// 7/14/30-day windows stay meaningful regardless of query traffic. It is the
// recommended primary history-building path but stays off by default to avoid
// surprising upstream calls; enable with SNAPSHOT_JOB_ENABLED=true.
const JOB_ENABLED = process.env['SNAPSHOT_JOB_ENABLED'] === 'true'

export interface CaptureJobSummary {
  tracked: number
  captured: number
  errors: number
  gcDeleted: number
}

/**
 * Iterate every tracked account, force-refresh its profile from Wargaming, and
 * write a snapshot (5-min dedup + unchanged-`last_battle_time` skip via the
 * default `skipIfInactive: true`, see `captureSnapshotIfStale`) so the daily
 * job doesn't stack identical rows for inactive accounts. Then globally GC
 * snapshots older than
 * `SNAPSHOT_GC_DAYS`. Safe to call manually (POST /admin/snapshots/run) or from
 * the daily interval.
 */
export const runCaptureJob = async (): Promise<CaptureJobSummary> => {
  const tracked = await prisma.trackedAccount.findMany({
    where: { realm: REALM },
  })

  let captured = 0
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
    } catch (error) {
      // One account's transient failure (e.g. SQLITE_BUSY, a non-P2002 Prisma
      // error, or a corrupt-cache JSON.parse inside getPlayerInfo) must not
      // abort the remaining captures or the GC pass below.
      errors += 1
      console.error('capture failed for', account.accountId, error)
    }
  }

  const gc = await prisma.playerStatsSnapshot.deleteMany({
    where: {
      realm: REALM,
      capturedAt: { lt: new Date(Date.now() - SNAPSHOT_GC_DAYS * DAY_MS) },
    },
  })

  return {
    tracked: tracked.length,
    captured,
    errors,
    gcDeleted: gc.count,
  }
}

/**
 * Start the daily capture interval (and one immediate tick on boot) only when
 * `SNAPSHOT_JOB_ENABLED=true`. The immediate tick ensures a fresh "now"
 * snapshot exists for any tracked account right after (re)start.
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
