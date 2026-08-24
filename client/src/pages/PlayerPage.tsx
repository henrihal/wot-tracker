import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import {
  api,
  ApiError,
  type PlayerAccount,
  type Wn8PerTank,
  type Wn8CurrentResponse,
} from '../router.ts'

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; insufficient?: boolean }
  | {
      kind: 'ok'
      profile: PlayerAccount | null
      profileError: string | null
      wn8: Wn8CurrentResponse
    }

type SortKey =
  | 'name'
  | 'tier'
  | 'type'
  | 'battles'
  | 'wins'
  | 'wr'
  | 'damage_dealt'
  | 'frags'
  | 'spotted'
  | 'dropped_capture_points'
  | 'wn8'

type SortDir = 'asc' | 'desc'

interface Column {
  key: SortKey
  label: string
  className?: string
}

const COLUMNS: Column[] = [
  { key: 'name', label: 'Tank', className: 'name' },
  { key: 'tier', label: 'Tier' },
  { key: 'type', label: 'Type' },
  { key: 'battles', label: 'Battles' },
  { key: 'wins', label: 'Wins' },
  { key: 'wr', label: 'WR%' },
  { key: 'damage_dealt', label: 'Dmg' },
  { key: 'frags', label: 'Frags' },
  { key: 'spotted', label: 'Spot' },
  { key: 'dropped_capture_points', label: 'DCap' },
  { key: 'wn8', label: 'WN8' },
]

const NUMERIC = new Set<SortKey>([
  'tier',
  'battles',
  'wins',
  'wr',
  'damage_dealt',
  'frags',
  'spotted',
  'dropped_capture_points',
  'wn8',
])

function typeLabel(t: string): string {
  switch (t) {
    case 'mediumTank':
      return 'MT'
    case 'heavyTank':
      return 'HT'
    case 'lightTank':
      return 'LT'
    case 'AT-SPG':
      return 'TD'
    case 'SPG':
      return 'SPG'
    default:
      return t
  }
}

function sortValue(row: Wn8PerTank, key: SortKey): number | string {
  if (key === 'wr') return row.battles ? (row.wins / row.battles) * 100 : 0
  if (key === 'type') return typeLabel(row.type)
  return row[key]
}

export function PlayerPage() {
  const { accountId } = useParams()
  const id = parseInt(accountId ?? '', 10)
  const valid = Number.isFinite(id) && id > 0
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [sortKey, setSortKey] = useState<SortKey>('battles')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  useEffect(() => {
    if (!valid) {
      setState({ kind: 'error', message: 'invalid account id' })
      return
    }
    let cancelled = false
    setState({ kind: 'loading' })

    Promise.all([
      api.getWn8Current(id).catch((e) => {
        if (e instanceof ApiError && e.isInsufficientHistory) throw e
        throw e
      }),
      api
        .getPlayer(id)
        .then((res) => ({
          profile: res.data[String(id)] ?? null,
          profileError: null as string | null,
        }))
        .catch((e) => ({
          profile: null,
          profileError: e instanceof ApiError ? e.message : String(e),
        })),
    ])
      .then(([wn8, { profile, profileError }]) => {
        if (cancelled) return
        setState({ kind: 'ok', profile, profileError, wn8 })
      })
      .catch((err) => {
        if (cancelled) return
        const insufficient = err instanceof ApiError && err.isInsufficientHistory
        setState({
          kind: 'error',
          message: insufficient ? 'No captured history yet' : String(err.message ?? err),
          insufficient,
        })
      })

    return () => {
      cancelled = true
    }
  }, [id, valid])

  const rows = useMemo(() => {
    if (state.kind !== 'ok') return []
    const numeric = NUMERIC.has(sortKey)
    const dir = sortDir === 'asc' ? 1 : -1
    return [...state.wn8.perTank].sort((a, b) => {
      const av = sortValue(a, sortKey)
      const bv = sortValue(b, sortKey)
      if (numeric) return ((av as number) - (bv as number)) * dir
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0
    })
  }, [state, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(NUMERIC.has(key) ? 'desc' : 'asc')
    }
  }

  return (
    <main className="page">
      <header className="site-header">
        <Link to="/" className="brand">
          ← back
        </Link>
      </header>

      {state.kind === 'loading' && <p className="muted">loading…</p>}

      {state.kind === 'error' && (
        <p className={state.insufficient ? 'muted' : 'err'}>{state.message}</p>
      )}

      {state.kind === 'ok' && (
        <>
          <section className="player-header">
            <h1>{state.profile?.nickname ?? `Account ${id}`}</h1>
            {state.profile ? (
              <span className="muted">
                {state.profile.created_at
                  ? `since ${new Date(state.profile.created_at * 1000).getFullYear()}`
                  : ''}
              </span>
            ) : state.profileError ? (
              <span className="err"> (profile: {state.profileError})</span>
            ) : null}
            <div className="agg">
              <span>
                WN8 <strong>{state.wn8.wn8}</strong>
              </span>
              <span>
                Battles <strong>{state.wn8.battles}</strong>
              </span>
            </div>
          </section>

          <table className="tank-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    className={
                      c.className ?? undefined
                    }
                  >
                    <button
                      type="button"
                      className={`sort-btn ${sortKey === c.key ? `active ${sortDir}` : ''}`}
                      onClick={() => toggleSort(c.key)}
                    >
                      {c.label}
                      <span className="arrow">
                        {sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.tankId}>
                  <td className="name">{t.name}</td>
                  <td>{t.tier}</td>
                  <td>{typeLabel(t.type)}</td>
                  <td>{t.battles}</td>
                  <td>{t.wins}</td>
                  <td>{t.battles ? ((t.wins / t.battles) * 100).toFixed(2) : '0'}</td>
                  <td>{t.damage_dealt}</td>
                  <td>{t.frags}</td>
                  <td>{t.spotted}</td>
                  <td>{t.dropped_capture_points}</td>
                  <td>{t.wn8}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  )
}
