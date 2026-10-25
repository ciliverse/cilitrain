import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, type Run } from '../api'
import MetricsChart from '../components/MetricsChart'
import StatusBadge from '../components/StatusBadge'
import { useFieldLabel } from '../components/InferForm'
import { formatDuration, useI18n } from '../i18n'
import '../styles/training.css'

const MAX_PICK = 12

function formatMetric(value: unknown, key?: string): string {
  if (value == null) return '-'
  if (typeof value === 'number') {
    if (key === 'params' || key === 'rows') return Math.round(value).toLocaleString()
    if (Number.isInteger(value) || (key && ['epochs', 'epoch', 'vocab'].includes(key))) {
      return String(Math.round(value))
    }
    return value.toFixed(4)
  }
  return String(value)
}

function isFinished(r: Run) {
  return ['succeeded', 'failed', 'timeout', 'cancelled'].includes(r.status)
}

export default function ComparePage() {
  const { t, statusLabel } = useI18n()
  const fieldLabel = useFieldLabel()
  const [search] = useSearchParams()
  const sweepId = search.get('sweep')
  const [runs, setRuns] = useState<Run[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.compare>> | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    api
      .runs()
      .then((rows) => {
        const train = rows.filter((r) => r.kind !== 'infer')
        setRuns(train)
        const preset = sweepId
          ? train.filter((r) => r.sweep_id === sweepId && isFinished(r)).map((r) => r.id)
          : (search.get('ids') || '').split(',').filter((id) => train.some((r) => r.id === id))
        if (preset.length) setPicked(preset.slice(0, MAX_PICK))
        if (preset.length >= 2) {
          setBusy(true)
          api
            .compare(preset.slice(0, MAX_PICK))
            .then(setResult)
            .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false))
        }
      })
      .catch((e) => setErr(String(e.message || e)))
      .finally(() => setLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweepId])

  function toggle(id: string) {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= MAX_PICK) return prev
      return [...prev, id]
    })
    setResult(null)
  }

  async function doCompare() {
    if (picked.length < 2 || picked.length > MAX_PICK) return
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

  const finished = runs.filter(isFinished)
  const pickedRuns = picked
    .map((id) => finished.find((r) => r.id === id))
    .filter((r): r is Run => Boolean(r))
  const canCompare = picked.length >= 2 && picked.length <= MAX_PICK
  const paramKeys = Array.from(new Set((result?.runs || []).flatMap((r) => Object.keys(r.params || {}))))

  return (
    <div className="space-y-6">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('compareTitle')}</h1>
          <p className="page-desc">{t('compareDesc')}</p>
        </div>
      </div>
      {err && <p className="flash flash-err">{err}</p>}

      {!loaded ? null : finished.length === 0 ? (
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
              <span className="text-[var(--muted-2)]"> {picked.length}/{MAX_PICK}</span>
            </span>
          </div>

          <ul className="pick-list">
            {finished.map((r) => {
              const on = picked.includes(r.id)
              const locked = !on && picked.length >= MAX_PICK
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
                    <span className="pick-name">
                      <Link
                        to={`/runs/${r.id}`}
                        className="truncate hover:text-[var(--accent-text)]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.name}
                      </Link>
                      {r.sweep_id && <span className="sweep-badge mono">{r.sweep_id}</span>}
                    </span>
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
                {paramKeys.map((k) => (
                  <th key={`p-${k}`}>{fieldLabel(k)}</th>
                ))}
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
                    {paramKeys.map((k) => (
                      <td key={`p-${k}`} className="mono cmp-num">
                        {r.params?.[k] ?? '-'}
                      </td>
                    ))}
                    {(result.comparison.metric_keys || []).map((k) => (
                      <td key={k} className="mono cmp-num">
                        {formatMetric(row[k], k)}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}

      {result && (
        <section className="space-y-4">
          <h2 className="text-sm font-semibold">{t('compareCurves')}</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {result.runs.map((r) => {
              const view = result.metrics?.[r.id]
              return (
                <div key={r.id} className="panel panel-pad">
                  <h3 className="mb-2 text-sm font-medium">
                    <Link to={`/runs/${r.id}`} className="hover:text-[var(--accent-text)]">
                      {r.name}
                    </Link>
                  </h3>
                  <MetricsChart
                    series={view?.series || []}
                    keys={view?.chart_keys || []}
                    xKey={view?.x_key === 'index' ? 'index' : view?.x_key === 'x' ? 'x' : 'epoch'}
                    xLabel={view?.x_key === 'index' ? t('indexAxis') : t('epochAxis')}
                  />
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
