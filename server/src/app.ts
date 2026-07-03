import 'dotenv/config'
import express from 'express'
import { prisma } from './lib/prisma.js'
import { searchPlayers, getPlayerInfo } from './lib/wargaming.js'

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
  const result = await getPlayerInfo(accountId, { forceRefresh })

  if (result.status === 'ok') {
    res.json(result)
  } else {
    res.status(400).json(result)
  }
})

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`)
})

export { app }
