import 'dotenv/config'
import express from 'express'
import { prisma } from './lib/prisma.js'
import { searchPlayers } from './lib/wargaming.js'

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

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`)
})

export { app }
