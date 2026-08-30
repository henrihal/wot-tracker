import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, ApiError, type PlayerSummary } from '../router.ts'

export function IndexPage() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PlayerSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [health, setHealth] = useState<'up' | 'down' | 'checking'>('checking')
  const reqId = useRef(0)

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

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    const id = ++reqId.current
    const t = setTimeout(() => {
      api
        .searchPlayers(q)
        .then((res) => {
          if (id !== reqId.current) return
          setResults(res.data.slice(0, 10))
          setLoading(false)
        })
        .catch((err) => {
          if (id !== reqId.current) return
          setError(err instanceof ApiError ? err.message : String(err))
          setResults([])
          setLoading(false)
        })
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  return (
    <main className="page">
      <header className="site-header">
        <Link to="/" className="brand">
          WoT Stats
        </Link>
        <span className={`pill ${health}`}>server: {health}</span>
        <Link to="/admin" className="admin-link">
          admin
        </Link>
      </header>

      <section className="search">
        <input
          autoFocus
          type="text"
          placeholder="search player by nickname"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {loading && <p className="muted">searching…</p>}
        {error && <p className="err">{error}</p>}
        {!loading && !error && query.trim() && results.length === 0 && (
          <p className="muted">no players found</p>
        )}
        <ul className="result-list">
          {results.map((p) => (
            <li key={p.account_id}>
              <Link to={`/players/${p.account_id}`}>{p.nickname}</Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
