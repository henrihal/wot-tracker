import 'dotenv/config'
import express from 'express'
import { prisma } from './lib/prisma.js'
import { searchPlayers, getPlayerInfo, REALM } from './lib/wargaming.js'
import { getStatsDelta, getStatsSummary, isValidRange } from './lib/stats.js'
import { runCaptureJob, startScheduler } from './lib/scheduler.js'

const PORT = process.env['PORT'] || 3001
const app = express()

app.use(express.json())

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: 'ok', database: 'connected' })
  } catch (error) {
    res
      .status(503)
      .json({ status: 'error', database: 'unreachable', error: String(error) })
  }
})

app.get('/players/search', async (req, res) => {
  const search = req.query['search']
  if (typeof search !== 'string') {
    res.status(400).json({
      status: 'error',
      error: {
        code: 402,
        message: 'SEARCH_NOT_SPECIFIED: ?search query parameter is required.',
        field: 'search',
        value: '',
      },
    })
    return
  }

  const forceRefresh = req.query['forceRefresh'] === 'true'
  const result = await searchPlayers(search, { forceRefresh })

  if (result.status === 'ok') {
    res.json(result)
  } else {
    res.status(400).json(result)
  }
})

app.get('/players/info', async (req, res) => {
  const raw = req.query['account_id']
  const accountId = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN
  if (!Number.isInteger(accountId) || accountId <= 0) {
    res.status(400).json({
      status: 'error',
      error: {
        code: 402,
        message:
          'ACCOUNT_ID_NOT_SPECIFIED: ?account_id query parameter must be a positive integer.',
        field: 'account_id',
        value: typeof raw === 'string' ? raw : '',
      },
    })
    return
  }

  const forceRefresh = req.query['forceRefresh'] === 'true'
  await prisma.trackedAccount.upsert({
    where: { accountId_realm: { accountId, realm: REALM } },
    create: { accountId, realm: REALM },
    update: {},
  })
  const result = await getPlayerInfo(accountId, { forceRefresh })

  if (result.status === 'ok') {
    res.json(result)
  } else {
    res.status(400).json(result)
  }
})

const parseAccountIdParam = (raw: string | undefined): number | null => {
  const accountId = Number.parseInt(raw ?? '', 10)
  if (!Number.isInteger(accountId) || accountId <= 0) return null
  return accountId
}

const sendAccountIdError = (
  res: express.Response,
  value: string | undefined
) => {
  res.status(400).json({
    status: 'error',
    error: {
      code: 402,
      message:
        'ACCOUNT_ID_NOT_SPECIFIED: :accountId path parameter must be a positive integer.',
      field: 'account_id',
      value: value ?? '',
    },
  })
}

const trackAccount = async (accountId: number): Promise<void> => {
  await prisma.trackedAccount.upsert({
    where: { accountId_realm: { accountId, realm: REALM } },
    create: { accountId, realm: REALM },
    update: {},
  })
}

app.get('/players/:accountId/stats', async (req, res) => {
  const accountId = parseAccountIdParam(req.params['accountId'])
  if (accountId === null) {
    sendAccountIdError(res, req.params['accountId'])
    return
  }

  const rangeRaw = req.query['range']
  const range =
    typeof rangeRaw === 'string' ? Number.parseInt(rangeRaw, 10) : NaN
  if (!isValidRange(range)) {
    res.status(400).json({
      status: 'error',
      error: {
        code: 402,
        message: '?range query parameter must be one of: 7, 14, 30.',
        field: 'range',
        value: typeof rangeRaw === 'string' ? rangeRaw : '',
      },
    })
    return
  }

  await trackAccount(accountId)

  const result = await getStatsDelta(accountId, range)
  if (result.status === 'ok') {
    res.json(result)
  } else if (result.error.code === 422) {
    res.status(422).json(result)
  } else {
    res.status(400).json(result)
  }
})

app.get('/players/:accountId/stats/summary', async (req, res) => {
  const accountId = parseAccountIdParam(req.params['accountId'])
  if (accountId === null) {
    sendAccountIdError(res, req.params['accountId'])
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
    res.status(400).json({
      status: 'error',
      error: {
        code: 402,
        message:
          '?ranges query parameter must be a comma-separated subset of: 7, 14, 30.',
        field: 'ranges',
        value: typeof rangesRaw === 'string' ? rangesRaw : '',
      },
    })
    return
  }

  await trackAccount(accountId)

  const result = await getStatsSummary(accountId, ranges)
  if (result.status === 'ok') {
    res.json(result)
  } else if (result.error.code === 422) {
    res.status(422).json(result)
  } else {
    res.status(400).json(result)
  }
})

app.post('/admin/snapshots/run', async (_req, res) => {
  try {
    const summary = await runCaptureJob()
    res.json({ status: 'ok', ...summary })
  } catch (error) {
    res.status(500).json({ status: 'error', error: String(error) })
  }
})

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`)
  startScheduler()
})

export { app }
