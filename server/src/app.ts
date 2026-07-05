import 'dotenv/config'
import express from 'express'
import { prisma } from './lib/prisma.js'
import { searchPlayers, getPlayerInfo } from './lib/wargaming.js'
import { getStatsDelta, getStatsSummary, isValidRange } from './lib/stats.js'
import { runCaptureJob, startScheduler } from './lib/scheduler.js'
import { sendApiError, sendResult } from './lib/http.js'
import { apiErrorHandler } from './lib/middleware.js'

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

app.get('/players/info', async (req, res) => {
  const raw = req.query['account_id']
  const accountId = parseAccountIdParam(
    typeof raw === 'string' ? raw : undefined
  )
  if (accountId === null) {
    sendApiError(res, 400, {
      code: 402,
      message:
        'ACCOUNT_ID_NOT_SPECIFIED: ?account_id query parameter must be a positive integer.',
      field: 'account_id',
      value: typeof raw === 'string' ? raw : '',
    })
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
  const range =
    typeof rangeRaw === 'string' ? Number.parseInt(rangeRaw, 10) : NaN
  if (!isValidRange(range)) {
    sendApiError(res, 400, {
      code: 402,
      message: '?range query parameter must be one of: 7, 14, 30.',
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
  const requested =
    typeof rangesRaw === 'string' && rangesRaw.length > 0
      ? rangesRaw.split(',')
      : ['7', '14', '30']

  const ranges: number[] = []
  const seen = new Set<number>()
  for (const part of requested) {
    const n = Number.parseInt(part, 10)
    if (!isValidRange(n) || seen.has(n)) continue
    seen.add(n)
    ranges.push(n)
  }

  if (ranges.length === 0) {
    sendApiError(res, 400, {
      code: 402,
      message:
        '?ranges query parameter must be a comma-separated subset of: 7, 14, 30.',
      field: 'ranges',
      value: typeof rangesRaw === 'string' ? rangesRaw : '',
    })
    return
  }

  const result = await getStatsSummary(accountId, ranges)
  sendResult(res, result)
})

app.post('/admin/snapshots/run', async (_req, res) => {
  try {
    const summary = await runCaptureJob()
    res.json({ status: 'ok', ...summary })
  } catch (error) {
    console.error('Capture job failed:', error)
    sendApiError(res, 500, { code: 500, message: 'Capture job failed' })
  }
})

// Express 5 routes async rejections and sync throws here. Registered after all
// routes so thrown errors (Prisma, JSON.parse of a corrupt cache row) become
// the API's JSON envelope instead of Express's default HTML 500.
app.use(apiErrorHandler)

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`)
  startScheduler()
})

export { app }
