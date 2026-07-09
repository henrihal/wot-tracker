import 'dotenv/config'
import { prisma } from '../lib/prisma.js'
import {
  refreshVehicleEncyclopedia,
  refreshExpectedValues,
} from '../lib/vehicles.js'

// One-shot seed/sync of the vehicle reference data: fetches the Wargaming
// vehicle encyclopedia (paginated) into the `Vehicle` table and the XVM WN8
// expected-values dataset into `VehicleExpectedValue`. Wired as `npm run sync`.
// Run after migrations (and `prisma generate`) so the client knows the new
// models. Safe to re-run: rows are upserted.
const run = async (): Promise<void> => {
  try {
    console.log('Syncing vehicle encyclopedia from Wargaming…')
    const enc = await refreshVehicleEncyclopedia()
    if (enc.status === 'ok') {
      console.log(
        `  vehicles: ${enc.tanks} upserted across ${enc.pages} page(s)`
      )
    } else {
      console.error(`  encyclopedia refresh failed: ${enc.error}`)
    }

    console.log('Syncing WN8 expected values from XVM…')
    const exp = await refreshExpectedValues()
    if (exp.status === 'ok') {
      console.log(
        `  expected values: ${exp.expected} upserted (version ${exp.version})`
      )
    } else {
      console.error(`  expected-values refresh failed: ${exp.error}`)
    }

    if (enc.status !== 'ok' || exp.status !== 'ok') {
      process.exitCode = 1
    }
  } catch (error) {
    console.error('sync failed:', error)
    process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

void run()
