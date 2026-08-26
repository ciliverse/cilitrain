import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Run } from '../api'
import StatusBadge from '../components/StatusBadge'
import { formatDuration, useI18n } from '../i18n'

function formatMetric(value: unknown): string {
  if (value == null) return '-'
  if (typeof value === 'number') return value.toPrecision(4)
  return String(value)
}

export default function ComparePage() {
  const { t, statusLabel } = useI18n()
  const [runs, setRuns] = useState<Run[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.compare>> | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .runs()
      .then(setRuns)
      .catch((e) => setErr(String(e.message || e)))
  }, [])

  function toggle(id: string) {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= 4) return prev
      return [...prev, id]
    })
    setResult(null)
  }

  async function doCompare() {
    if (picked.length < 2 || picked.length > 4) return
    setErr('')
    setBusy(true)
    try {
      setResult(await api.compare(picked))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const finished = runs.filter((r) =>
    ['succeeded', 'failed', 'timeout', 'cancelled'].includes(r.status),
  )
  const pickedRuns = picked
    .map((id) => finished.find((r) => r.id === id))
    .filter((r): r is Run => Boolean(r))
  const canCompare = picked.length >= 2 && picked.length <= 4

  return (
    <div className="space-y-6">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('compareTitle')}</h1>
          <p className="page-desc">{t('compareDesc')}</p>
        </div>
      </div>
      {err && <p className="flash flash-err">{err}</p>}

      {finished.length === 0 ? (
        <div className="empty-state">
          <p className="empty-title">{t('cmpEmpty')}</p>
          <div className="empty-actions">
            <Link to="/" className="btn btn-secondary">
              {t('navRuns')}
            </Link>
            <Link to="/new" className="btn btn-primary">
              {t('navNew')}
            </Link>
          </div>
        </div>
      ) : (
        <section className="panel panel-pad">
          <div className="pick-toolbar">
            <span className="text-sm font-semibold">{t('pickRuns')}</span>
            <div className="pick-chips">
              {pickedRuns.map((r) => (
                <span key={r.id} className="pick-chip">
                  <span className="pick-chip-name">{r.name}</span>
                  <button
                    type="button"
                    className="pick-chip-x"
                    aria-label={`${t('cmpRemove')} ${r.name}`}
                    onClick={() => toggle(r.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <span className="pick-hint mono">
              {canCompare ? t('cmpReady') : t('cmpNeed')}
              <span className="text-[var(--muted-2)]"> {picked.length}/4</span>
            </span>
          </div>

          <ul className="pick-list">
            {finished.map((r) => {
              const on = picked.includes(r.id)
              const locked = !on && picked.length >= 4
              return (
                <li key={r.id}>
                  <div
                    className={`pick-item${on ? ' is-on' : ''}${locked ? ' is-locked' : ''}`}
                    onClick={() => {
                      if (!locked) toggle(r.id)
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={locked}
                      onChange={() => toggle(r.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <Link
                      to={`/runs/${r.id}`}
                      className="truncate hover:text-[var(--accent-text)]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {r.name}
                    </Link>
                    <StatusBadge status={r.status} label={statusLabel(r.status)} />
                    <span className="mono text-xs text-[var(--muted)]">
                      {formatDuration(r.duration_seconds)}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>

          <div className="spec-form-foot">
            <button
              type="button"
              disabled={!canCompare || busy}
              onClick={doCompare}
              className="btn btn-primary"
            >
              {t('compareAction')}
            </button>
          </div>
        </section>
      )}

      {result && (
        <section className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('cmpRun')}</th>
                <th>{t('cmpStatus')}</th>
                <th>{t('cmpTemplate')}</th>
                <th>{t('cmpSpec')}</th>
                {(result.comparison.metric_keys || []).map((k) => (
                  <th key={k} className="mono">
                    {k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.runs.map((r) => {
                const row = result.comparison.rows.find((x) => x.run_id === r.id) || {}
                return (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/runs/${r.id}`} className="hover:text-[var(--accent-text)]">
                        {r.name}
                      </Link>
                    </td>
                    <td>
                      <StatusBadge status={r.status} label={statusLabel(r.status)} />
                    </td>
                    <td>
                      <span className="badge badge-neutral">{r.template}</span>
                    </td>
                    <td className="mono cmp-num text-xs">
                      {r.cpu}/{r.memory}
                    </td>
                    {(result.comparison.metric_keys || []).map((k) => (
                      <td key={k} className="mono cmp-num">
                        {formatMetric(row[k])}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
