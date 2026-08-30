import 'dotenv/config'
import express from 'express'
import { prisma } from './lib/prisma.js'
import {
  searchPlayers,
  getPlayerInfo,
  getPlayerVehicles,
} from './lib/wargaming.js'
import { getStatsDelta, getStatsSummary, isValidRange } from './lib/stats.js'
import { getWN8Current, getWN8Delta, getWN8Summary } from './lib/wn8.js'
import {
  refreshVehicleEncyclopedia,
  refreshExpectedValues,
} from './lib/vehicles.js'
import { runCaptureJob, startScheduler } from './lib/scheduler.js'
import { sendApiError, sendResult } from './lib/http.js'
import { apiErrorHandler } from './lib/middleware.js'
import { adminAuth } from './lib/adminAuth.js'

const PORT = process.env['PORT'] || 3001
const app = express()

app.use(express.json())

const parseAccountIdParam = (raw: string | undefined): number | null => {
  const accountId = Number.parseInt(raw ?? '', 10)
  if (!Number.isInteger(accountId) || accountId <= 0) return null
  return accountId
}

// Shared 400 envelope for an invalid :accountId (kept identical across routes).
const sendAccountIdError = (res: express.Response, value: string): void => {
  sendApiError(res, 400, {
    code: 402,
    message:
      'ACCOUNT_ID_NOT_SPECIFIED: :accountId path parameter must be a positive integer.',
    field: 'account_id',
    value,
  })
}

// Shared ?range / ?ranges validation messages (stats + wn8 share wording).
const RANGE_SINGLE_MSG = '?range query parameter must be one of: 7, 14, 30.'
const RANGE_SET_MSG =
  '?ranges query parameter must be a comma-separated subset of: 7, 14, 30.'

// Parse ?range into a valid window (7/14/30) or null.
const parseRange = (raw: unknown): number | null => {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN
  return isValidRange(n) ? n : null
}

// Parse ?ranges into a deduped, order-preserving subset of 7/14/30 (default
// all). null when every entry is invalid.
const parseRanges = (raw: unknown): number[] | null => {
  const requested =
    typeof raw === 'string' && raw.length > 0
      ? raw.split(',')
      : ['7', '14', '30']
  const ranges: number[] = []
  const seen = new Set<number>()
  for (const part of requested) {
    const n = Number.parseInt(part, 10)
    if (!isValidRange(n) || seen.has(n)) continue
    seen.add(n)
    ranges.push(n)
  }
  return ranges.length > 0 ? ranges : null
}

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: 'ok', database: 'connected' })
  } catch (error) {
    console.error('Health check failed:', error)
    sendApiError(res, 503, { code: 503, message: 'Database unreachable' })
  }
})

app.get('/players/search', async (req, res) => {
  const search = req.query['search']
  if (typeof search !== 'string') {
    sendApiError(res, 400, {
      code: 402,
      message: 'SEARCH_NOT_SPECIFIED: ?search query parameter is required.',
      field: 'search',
      value: '',
    })
    return
  }

  const forceRefresh = req.query['forceRefresh'] === 'true'
  const result = await searchPlayers(search, { forceRefresh })
  sendResult(res, result)
})

app.get('/players/:accountId', async (req, res) => {
  const accountId = parseAccountIdParam(req.params['accountId'])
  if (accountId === null) {
    sendAccountIdError(res, req.params['accountId'] ?? '')
    return
  }

  const forceRefresh = req.query['forceRefresh'] === 'true'
  const result = await getPlayerInfo(accountId, { forceRefresh })
  sendResult(res, result)
})

app.get('/players/:accountId/stats', async (req, res) => {
  const accountId = parseAccountIdParam(req.params['accountId'])
  if (accountId === null) {
    sendAccountIdError(res, req.params['accountId'] ?? '')
    return
  }

  const rangeRaw = req.query['range']
  const range = parseRange(rangeRaw)
  if (range === null) {
    sendApiError(res, 400, {
      code: 402,
      message: RANGE_SINGLE_MSG,
      field: 'range',
      value: typeof rangeRaw === 'string' ? rangeRaw : '',
    })
    return
  }

  const result = await getStatsDelta(accountId, range)
  sendResult(res, result)
})

app.get('/players/:accountId/stats/summary', async (req, res) => {
  const accountId = parseAccountIdParam(req.params['accountId'])
  if (accountId === null) {
    sendAccountIdError(res, req.params['accountId'] ?? '')
    return
  }

  const rangesRaw = req.query['ranges']
  const ranges = parseRanges(rangesRaw)
  if (ranges === null) {
    sendApiError(res, 400, {
      code: 402,
      message: RANGE_SET_MSG,
      field: 'ranges',
      value: typeof rangesRaw === 'string' ? rangesRaw : '',
    })
    return
  }

  const result = await getStatsSummary(accountId, ranges)
  sendResult(res, result)
})

app.get('/players/:accountId/vehicles', async (req, res) => {
  const accountId = parseAccountIdParam(req.params['accountId'])
  if (accountId === null) {
    sendAccountIdError(res, req.params['accountId'] ?? '')
    return
  }

  const forceRefresh = req.query['forceRefresh'] === 'true'
  const result = await getPlayerVehicles(accountId, { forceRefresh })
  sendResult(res, result)
})

app.get('/players/:accountId/wn8', async (req, res) => {
  const accountId = parseAccountIdParam(req.params['accountId'])
  if (accountId === null) {
    sendAccountIdError(res, req.params['accountId'] ?? '')
    return
  }

  const rangeRaw = req.query['range']
  if (rangeRaw === undefined) {
    // No range → overall current WN8 (no history needed).
    const result = await getWN8Current(accountId)
    sendResult(res, result)
    return
  }

  const range = parseRange(rangeRaw)
  if (range === null) {
    sendApiError(res, 400, {
      code: 402,
      message: RANGE_SINGLE_MSG,
      field: 'range',
      value: typeof rangeRaw === 'string' ? rangeRaw : '',
    })
    return
  }

  const result = await getWN8Delta(accountId, range)
  sendResult(res, result)
})

app.get('/players/:accountId/wn8/summary', async (req, res) => {
  const accountId = parseAccountIdParam(req.params['accountId'])
  if (accountId === null) {
    sendAccountIdError(res, req.params['accountId'] ?? '')
    return
  }

  const rangesRaw = req.query['ranges']
  const ranges = parseRanges(rangesRaw)
  if (ranges === null) {
    sendApiError(res, 400, {
      code: 402,
      message: RANGE_SET_MSG,
      field: 'ranges',
      value: typeof rangesRaw === 'string' ? rangesRaw : '',
    })
    return
  }

  const result = await getWN8Summary(accountId, ranges)
  sendResult(res, result)
})

// Admin routes gated by X-Admin-Token; fail-closed (503 if ADMIN_TOKEN unset).
app.use('/admin', adminAuth)

// runCaptureJob throws on hard DB failure → apiErrorHandler as a 500 envelope.
app.post('/admin/snapshots/run', async (_req, res) => {
  const summary = await runCaptureJob()
  sendResult(res, { status: 'ok', ...summary })
})

app.post('/admin/vehicles/refresh', async (_req, res) => {
  const result = await refreshVehicleEncyclopedia()
  sendResult(res, result)
})

app.post('/admin/wn8/refresh-expected', async (_req, res) => {
  const result = await refreshExpectedValues()
  sendResult(res, result)
})

// JSON 404 envelope for unmatched routes (registered before the error handler).
app.use((_req, res) =>
  sendApiError(res, 404, { code: 404, message: 'Not found' })
)

// Express 5 forwards async rejections / sync throws here → JSON envelope.
app.use(apiErrorHandler)

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`)
  startScheduler()
})

export { app }
