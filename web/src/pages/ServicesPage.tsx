import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type InferenceService } from '../api'
import StatusBadge from '../components/StatusBadge'
import { formatLocalDateTime, useI18n } from '../i18n'
import '../styles/runs.css'
import '../styles/models.css'

export function useServiceStatus() {
  const { t } = useI18n()
  return (s: InferenceService['status']) => t(`svc_${s}` as 'svc_running')
}

export function formatLatency(ms?: number | null): string {
  if (ms == null) return '—'
  return ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`
}

export default function ServicesPage() {
  const { t, lang } = useI18n()
  const statusLabel = useServiceStatus()
  const nav = useNavigate()
  const [rows, setRows] = useState<InferenceService[]>([])
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .services()
        .then((r) => alive && setRows(r))
        .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => alive && setLoaded(true))
    load()
    const timer = window.setInterval(load, 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  return (
    <div className="runs-page models-page svc-list">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('svcTitle')}</h1>
          <p className="page-desc">{t('svcDesc')}</p>
        </div>
      </div>

      {err && <p className="flash flash-err mb-4">{err}</p>}

      {loaded && rows.length === 0 ? (
        <div className="empty-state">
          <div>
            <p className="empty-title">{t('svcEmptyTitle')}</p>
            <p className="runs-empty-desc">{t('svcEmptyDesc')}</p>
          </div>
          <div className="empty-actions">
            <Link to="/models" className="btn btn-secondary">
              {t('navModels')}
            </Link>
          </div>
        </div>
      ) : (
        <div className="data-table-wrap" aria-busy={!loaded}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('svcColService')}</th>
                <th>{t('colStatus')}</th>
                <th>{t('svcColReplicas')}</th>
                <th>{t('svcColRequests')}</th>
                <th>{t('svcColLatency')}</th>
                <th>{t('svcColLastCall')}</th>
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
                : rows.map((s) => (
                    <tr key={s.id} className="data-row" onClick={() => nav(`/services/${s.id}`)}>
                      <td>
                        <Link to={`/services/${s.id}`} className="runs-name mono">
                          {s.name}
                        </Link>
                        <div className="runs-sub mono">
                          {s.model_label || s.model_id.slice(0, 8)} · {s.namespace}
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={s.status} label={statusLabel(s.status)} />
                      </td>
                      <td className="mono runs-muted">
                        {s.status === 'stopped' ? '—' : `${s.ready_replicas}/${s.replicas}`}
                      </td>
                      <td className="mono runs-muted">
                        {s.requests.toLocaleString()}
                        {s.errors > 0 && <span className="svc-err-count"> · {s.errors}✕</span>}
                      </td>
                      <td className="mono runs-muted">{formatLatency(s.avg_latency_ms)}</td>
                      <td className="runs-muted">
                        {s.last_request_at ? formatLocalDateTime(s.last_request_at, lang) : '—'}
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
