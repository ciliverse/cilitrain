import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type ModelVersion } from '../api'
import { formatLocalDateTime, useI18n } from '../i18n'
import '../styles/runs.css'
import '../styles/models.css'

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function formatMetric(v: number | string): string {
  if (typeof v !== 'number') return String(v)
  if (Number.isInteger(v)) return v.toLocaleString()
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(4)
}

const HEADLINE = ['val_loss', 'loss', 'acc', 'accuracy', 'score']

export function headlineMetrics(m: Record<string, number | string>): [string, number | string][] {
  return HEADLINE.filter((k) => typeof m[k] === 'number')
    .slice(0, 2)
    .map((k) => [k, m[k]])
}

export default function ModelsPage() {
  const { t, lang } = useI18n()
  const nav = useNavigate()
  const [models, setModels] = useState<ModelVersion[]>([])
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    api
      .models()
      .then(setModels)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoaded(true))
  }, [])

  return (
    <div className="runs-page models-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('modelsTitle')}</h1>
          <p className="page-desc">{t('modelsDesc')}</p>
        </div>
      </div>

      {err && <p className="flash flash-err mb-4">{err}</p>}

      {loaded && models.length === 0 ? (
        <div className="empty-state">
          <div>
            <p className="empty-title">{t('modelsEmptyTitle')}</p>
            <p className="runs-empty-desc">{t('modelsEmptyDesc')}</p>
          </div>
          <div className="empty-actions">
            <Link to="/" className="btn btn-secondary">
              {t('navRuns')}
            </Link>
          </div>
        </div>
      ) : (
        <div className="data-table-wrap" aria-busy={!loaded}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('colModel')}</th>
                <th>{t('modelMetrics')}</th>
                <th>{t('modelFrom')}</th>
                <th>{t('modelInferCount')}</th>
                <th>{t('modelRegistered')}</th>
                <th className="runs-th-acts">{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {!loaded
                ? [0, 1].map((i) => (
                    <tr key={i}>
                      {[0, 1, 2, 3, 4, 5].map((j) => (
                        <td key={j}>
                          <span className="runs-skel runs-skel-md" />
                        </td>
                      ))}
                    </tr>
                  ))
                : models.map((m) => (
                    <tr key={m.id} className="data-row" onClick={() => nav(`/models/${m.id}`)}>
                      <td>
                        <Link to={`/models/${m.id}`} className="runs-name mono">
                          {m.name}
                          <span className="model-ver">v{m.version}</span>
                        </Link>
                        <div className="runs-sub mono">
                          {m.template} · {formatBytes(m.size_bytes)}
                        </div>
                      </td>
                      <td>
                        <div className="model-metrics">
                          {headlineMetrics(m.metrics).map(([k, v]) => (
                            <span key={k} className="model-metric mono">
                              <span className="k">{k}</span>
                              {formatMetric(v)}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {m.source_run_id ? (
                          <Link to={`/runs/${m.source_run_id}`} className="runs-act">
                            {m.source_run_name || m.source_run_id.slice(0, 8)}
                          </Link>
                        ) : (
                          <span className="runs-sub">—</span>
                        )}
                      </td>
                      <td className="mono runs-muted">{m.infer_count}</td>
                      <td className="runs-muted">{formatLocalDateTime(m.created_at, lang)}</td>
                      <td className="runs-td-acts" onClick={(e) => e.stopPropagation()}>
                        <div className="runs-acts">
                          <Link to={`/models/${m.id}`} className="runs-act runs-act-primary">
                            {t('inferTitle')}
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
