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

// Shared error response for an invalid :accountId path parameter. Used by both
// stats routes so the envelope stays identical.
const sendAccountIdError = (res: express.Response, value: string): void => {
  sendApiError(res, 400, {
    code: 402,
    message:
      'ACCOUNT_ID_NOT_SPECIFIED: :accountId path parameter must be a positive integer.',
    field: 'account_id',
    value,
  })
}

// Shared validation messages for the trailing-window ?range / ?ranges params.
// Both stats and wn8 routes use the same wording, so it lives once here.
const RANGE_SINGLE_MSG = '?range query parameter must be one of: 7, 14, 30.'
const RANGE_SET_MSG =
  '?ranges query parameter must be a comma-separated subset of: 7, 14, 30.'

// Parse the single ?range query param into a valid trailing window (7/14/30)
// or null. Shared by the stats and wn8 delta routes. Accepts the raw query
// value (which Express types as string | ParsedQs | array) and narrows to a
// string inside.
const parseRange = (raw: unknown): number | null => {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN
  return isValidRange(n) ? n : null
}

// Parse the ?ranges query param into a deduped, order-preserving subset of
// 7/14/30 (default: all three). Returns null when every entry is invalid so the
// caller can emit the validation error. Shared by the stats and wn8 summary
// routes. Accepts the raw query value and narrows to a string inside.
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

  // ?ranges=7,14,30 (default: all three). Each value must be a valid range;
  // duplicates are collapsed while preserving first-seen order.
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
    // No range → overall current WN8 from cumulative counters (no history needed).
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

  // ?ranges=7,14,30 (default: all three). Each value must be a valid range;
  // duplicates are collapsed while preserving first-seen order.
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

// Admin endpoints are gated behind an X-Admin-Token header checked against
// ADMIN_TOKEN. Fail-closed: if ADMIN_TOKEN is unset, every admin route returns
// 503. See lib/adminAuth.ts.
app.use('/admin', adminAuth)

app.post('/admin/snapshots/run', async (_req, res) => {
  // runCaptureJob throws on hard failure (Prisma/DB) — those propagate to
  // apiErrorHandler as a 500 JSON envelope. The ok summary has no `status`
  // field, so the envelope is built here.
  const summary = await runCaptureJob()
  sendResult(res, { status: 'ok', ...summary })
})

app.post('/admin/vehicles/refresh', async (_req, res) => {
  // refreshVehicleEncyclopedia returns a TaggedApiResult: { status:'ok', tanks,
  // pages } or { status:'error', error:{code,message} }. sendResult forwards the
  // ok branch and promotes the error code (502) to the HTTP status. Throws
  // (unexpected Prisma errors) fall through to apiErrorHandler.
  const result = await refreshVehicleEncyclopedia()
  sendResult(res, result)
})

app.post('/admin/wn8/refresh-expected', async (_req, res) => {
  const result = await refreshExpectedValues()
  sendResult(res, result)
})

// Unmatched routes fall through to this JSON 404 envelope instead of Express's
// default HTML 404, keeping the response shape uniform for clients. Registered
// before the error handler (which is matched by arity + position) so a normal
// 2-arg middleware handles the not-found case.
app.use((_req, res) =>
  sendApiError(res, 404, { code: 404, message: 'Not found' })
)

// Express 5 routes async rejections and sync throws here. Registered after all
// routes so thrown errors (Prisma, JSON.parse of a corrupt cache row) become
// the API's JSON envelope instead of Express's default HTML 500.
app.use(apiErrorHandler)

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`)
  startScheduler()
})

export { app }
