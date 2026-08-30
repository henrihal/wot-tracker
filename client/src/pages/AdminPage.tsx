import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, ApiError, RANGES, type Range } from '../router.ts'

interface LogEntry {
  id: number
  ok: boolean
  label: string
  ts: string
  text: string
}

const TEST_ACCOUNT_ID = 12345678
const TEST_SEARCH = 'test'

export function AdminPage() {
  const [acct, setAcct] = useState(String(TEST_ACCOUNT_ID))
  const [q, setQ] = useState(TEST_SEARCH)
  const [token, setToken] = useState(
    (import.meta.env.VITE_ADMIN_TOKEN as string | undefined) ?? '',
  )
  const [health, setHealth] = useState<'up' | 'down' | 'checking'>('checking')
  const [log, setLog] = useState<LogEntry[]>([])
  const logId = useRef(0)

  useEffect(() => {
    let cancelled = false
    api
      .health()
      .then(() => !cancelled && setHealth('up'))
      .catch(() => !cancelled && setHealth('down'))
    return () => {
      cancelled = true
    }
  }, [])

  function pushEntry(ok: boolean, label: string, text: string) {
    const entry: LogEntry = {
      id: ++logId.current,
      ok,
      label,
      ts: new Date().toLocaleTimeString(),
      text,
    }
    setLog((l) => [entry, ...l])
  }

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      const payload = await fn()
      pushEntry(true, label, JSON.stringify(payload, null, 2))
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, String(err), 0)
      pushEntry(false, label, JSON.stringify({
        name: e.name,
        message: e.message,
        envelopeCode: e.code,
        httpStatus: e.httpStatus,
        field: e.field,
        value: e.value,
        insufficientHistory: e.isInsufficientHistory,
      }, null, 2))
    }
  }

  const accountId = (): number => {
    const n = parseInt(acct, 10)
    return Number.isFinite(n) && n > 0 ? n : TEST_ACCOUNT_ID
  }
  const adminToken = (): string | undefined => {
    const v = token.trim()
    return v ? v : undefined
  }

  const endpoints: Record<string, () => Promise<unknown>> = {
    health: () => api.health(),
    search: () => api.searchPlayers(q || TEST_SEARCH),
    player: () => api.getPlayer(accountId()),
    vehicles: () => api.getVehicles(accountId()),
    stats7: () => api.getStats(accountId(), 7 as Range),
    stats14: () => api.getStats(accountId(), 14 as Range),
    stats30: () => api.getStats(accountId(), 30 as Range),
    statsSummary: () => api.getStatsSummary(accountId(), RANGES),
    wn8: () => api.getWn8Current(accountId()),
    wn87: () => api.getWn8Delta(accountId(), 7 as Range),
    wn8Summary: () => api.getWn8Summary(accountId(), RANGES),
    runSnapshots: () => api.runSnapshots(adminToken()),
    refreshVehicles: () => api.refreshVehicles(adminToken()),
    refreshWn8Expected: () => api.refreshWn8Expected(adminToken()),
  }

  const buttons: { ep: string; label: string; admin?: boolean }[] = [
    { ep: 'health', label: 'GET /health' },
    { ep: 'search', label: 'GET /players/search' },
    { ep: 'player', label: 'GET /players/:id' },
    { ep: 'vehicles', label: 'GET /players/:id/vehicles' },
    { ep: 'stats7', label: 'stats?range=7' },
    { ep: 'stats14', label: 'stats?range=14' },
    { ep: 'stats30', label: 'stats?range=30' },
    { ep: 'statsSummary', label: 'GET /players/:id/stats/summary' },
    { ep: 'wn8', label: 'GET /players/:id/wn8 (current)' },
    { ep: 'wn87', label: 'wn8?range=7' },
    { ep: 'wn8Summary', label: 'GET /players/:id/wn8/summary' },
    { ep: 'runSnapshots', label: 'POST /admin/snapshots/run', admin: true },
    { ep: 'refreshVehicles', label: 'POST /admin/vehicles/refresh', admin: true },
    { ep: 'refreshWn8Expected', label: 'POST /admin/wn8/refresh-expected', admin: true },
  ]

  return (
    <main className="page admin">
      <header className="site-header">
        <Link to="/" className="brand">
          ← back
        </Link>
        <span className={`pill ${health}`}>server: {health}</span>
      </header>

      <h1>wot-stat-server API tester</h1>

      <div className="admin-row">
        <label>
          accountId{' '}
          <input type="number" value={acct} onChange={(e) => setAcct(e.target.value)} />
        </label>
        <label>
          search <input type="text" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>
          admin token{' '}
          <input
            type="password"
            placeholder="X-Admin-Token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
      </div>

      <div className="admin-buttons">
        {buttons.map((b, i) =>
          b.admin ? (
            <hr key={`sep-${i}`} />
          ) : null,
        )}
        {buttons.map((b) => (
          <button
            key={b.ep}
            className={b.admin ? 'admin-btn' : undefined}
            onClick={() => run(b.label, endpoints[b.ep])}
          >
            {b.label}
          </button>
        ))}
      </div>

      <div className="log-wrap">
        <div className="log-toolbar">
          <span>response log</span>
          <button onClick={() => setLog([])}>clear</button>
        </div>
        <div className="log">
          {log.map((e) => (
            <div key={e.id} className={`log-entry ${e.ok ? 'ok' : 'err'}`}>
              <span className="ts">{e.ts}</span>{' '}
              <span className={`tag ${e.ok ? 'ok' : 'err'}`}>{e.ok ? 'OK' : 'ERR'}</span>{' '}
              <span className="lbl">{e.label}</span>
              <pre>{e.text}</pre>
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}
