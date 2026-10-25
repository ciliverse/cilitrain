import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, type AuthUser, type InferenceService, type InferSpec, type ServicePrediction } from '../api'
import ApiKeyDialog from '../components/ApiKeyDialog'
import CodeBlock from '../components/CodeBlock'
import ConfirmDialog from '../components/ConfirmDialog'
import InferForm from '../components/InferForm'
import PredictionView from '../components/PredictionView'
import StatusBadge from '../components/StatusBadge'
import { formatApiMessage, formatLocalDateTime, useI18n } from '../i18n'
import { formatLatency, useServiceStatus } from './ServicesPage'
import '../styles/runs.css'
import '../styles/models.css'

type Pending = 'stop' | 'delete' | 'rotate' | null

function sampleInput(spec?: InferSpec | null): Record<string, string | number> {
  return Object.fromEntries((spec?.fields || []).map((f) => [f.key, f.default ?? (f.type === 'text' ? '' : 0)]))
}

export function curlExample(url: string, spec?: InferSpec | null): string {
  const body = JSON.stringify({ input: sampleInput(spec) })
  return [
    `curl -X POST ${url} \\`,
    `  -H "Authorization: Bearer $CILITRAIN_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${body}'`,
  ].join('\n')
}

export default function ServiceDetailPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const { t, lang } = useI18n()
  const statusLabel = useServiceStatus()
  const [svc, setSvc] = useState<InferenceService | null>(null)
  const [me, setMe] = useState<AuthUser | null>(null)
  const [logs, setLogs] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending>(null)
  const [newKey, setNewKey] = useState<string | null>(() => sessionStorage.getItem(`svc-key-${id}`))
  const [result, setResult] = useState<ServicePrediction | null>(null)
  const [tryErr, setTryErr] = useState('')
  const [copied, setCopied] = useState(false)

  const load = useCallback(() => {
    api
      .service(id)
      .then(setSvc)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
    api
      .serviceLogs(id)
      .then((r) => setLogs(r.logs))
      .catch(() => {})
  }, [id])

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null))
    load()
  }, [load])

  useEffect(() => {
    const timer = window.setInterval(load, svc?.status === 'starting' ? 2000 : 6000)
    return () => window.clearInterval(timer)
  }, [load, svc?.status])

  function closeKey() {
    sessionStorage.removeItem(`svc-key-${id}`)
    setNewKey(null)
  }

  async function act(fn: () => Promise<unknown>, after?: (v: unknown) => void) {
    setBusy(true)
    setErr('')
    try {
      const v = await fn()
      after?.(v)
      setPending(null)
    } catch (e) {
      setErr(formatApiMessage(e instanceof Error ? e.message : String(e), t))
      setPending(null)
    } finally {
      setBusy(false)
    }
  }

  async function tryIt(input: Record<string, string | number>) {
    setBusy(true)
    setTryErr('')
    try {
      setResult(await api.servicePredict(id, input))
      load()
    } catch (e) {
      setTryErr(formatApiMessage(e instanceof Error ? e.message : String(e), t))
    } finally {
      setBusy(false)
    }
  }

  const canMutate = !!me && me.role !== 'viewer'
  const url = svc ? `${window.location.origin}${svc.endpoint_path}` : ''
  const running = svc?.status === 'running'
  const errorRate = svc && svc.requests ? `${((svc.errors / svc.requests) * 100).toFixed(1)}%` : '—'

  async function copyUrl() {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="runs-detail models-detail svc-detail space-y-6">
      <nav className="runs-crumb" aria-label={t('navServices')}>
        <Link to="/services">{t('svcTitle')}</Link>
        <span className="runs-crumb-sep" aria-hidden="true">
          /
        </span>
        <span className="runs-crumb-now">{svc?.name || t('loading')}</span>
      </nav>

      <div className="page-head runs-detail-head">
        <div className="min-w-0">
          <div className="runs-title-row">
            <h1 className="page-title mono">{svc?.name}</h1>
            {svc && <StatusBadge status={svc.status} label={statusLabel(svc.status)} />}
          </div>
          <div className="runs-head-meta">
            {svc && (
              <span className="mono">
                {svc.cluster_name || svc.cluster_id} · {svc.namespace}
              </span>
            )}
          </div>
        </div>
        {svc && canMutate && (
          <div className="flex flex-wrap items-center gap-2">
            {svc.status !== 'stopped' && (
              <div className="runs-kind svc-replica-pick" role="group" aria-label={t('svcColReplicas')}>
                {[1, 2, 3].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={svc.replicas === n}
                    disabled={busy}
                    onClick={() => n !== svc.replicas && act(() => api.scaleService(id, n), (v) => setSvc(v as InferenceService))}
                  >
                    {n}
                  </button>
                ))}
              </div>
            )}
            {svc.status === 'stopped' || svc.status === 'failed' ? (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => act(() => api.startService(id), (v) => setSvc(v as InferenceService))}
                >
                  {t('svcStart')}
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setPending('delete')}>
                  {t('svcDelete')}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setPending('stop')}>
                {t('svcStop')}
              </button>
            )}
          </div>
        )}
      </div>

      {svc && (
        <dl className="runs-spec">
          <div>
            <dt>{t('svcModel')}</dt>
            <dd>
              <Link to={`/models/${svc.model_id}`} className="mono">
                {svc.model_label || svc.model_id.slice(0, 8)}
              </Link>
            </dd>
          </div>
          <div>
            <dt>{t('svcColReplicas')}</dt>
            <dd className="mono">
              {svc.status === 'stopped'
                ? '—'
                : t('svcReady').replace('{r}', String(svc.ready_replicas)).replace('{n}', String(svc.replicas))}
            </dd>
          </div>
          <div>
            <dt>{t('svcResources')}</dt>
            <dd className="mono">
              {svc.cpu} CPU · {svc.memory}
            </dd>
          </div>
          <div>
            <dt>{t('svcStarted')}</dt>
            <dd>{svc.started_at && svc.status !== 'stopped' ? formatLocalDateTime(svc.started_at, lang) : '—'}</dd>
          </div>
        </dl>
      )}

      {err && <p className="flash flash-err">{err}</p>}
      {svc?.status_message && svc.status !== 'stopped' && <p className="flash flash-warn">{svc.status_message}</p>}
      {svc?.error_message && svc.status === 'failed' && <p className="flash flash-err">{svc.error_message}</p>}

      {svc && (
        <section className="panel panel-pad svc-access">
          <div className="panel-head">
            <h2 className="panel-title">{t('svcEndpoint')}</h2>
          </div>
          <div className="svc-access-grid">
            <div className="svc-field">
              <span className="svc-field-k">POST</span>
              <code className="mono svc-field-v">{url}</code>
              <button type="button" className="btn btn-ghost btn-sm" onClick={copyUrl}>
                {copied ? t('svcKeyCopied') : t('svcKeyCopy')}
              </button>
            </div>
            <div className="svc-field">
              <span className="svc-field-k">{t('svcApiKey')}</span>
              <code className="mono svc-field-v">{svc.api_key_prefix}••••••••••••</code>
              {canMutate && (
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPending('rotate')}>
                  {t('svcRotate')}
                </button>
              )}
            </div>
          </div>
          <h3 className="svc-h3">{t('svcCurl')}</h3>
          <CodeBlock text={curlExample(url, svc.infer)} filename="predict.sh" language="bash" />
          <p className="panel-note">{t('svcCurlHint')}</p>
        </section>
      )}

      {svc?.infer && (
        <div className="infer-layout">
          <section className="panel panel-pad">
            <div className="panel-head">
              <h2 className="panel-title">{t('svcTry')}</h2>
            </div>
            <p className="panel-note infer-desc">{t('svcTryDesc')}</p>
            <InferForm spec={svc.infer} busy={busy} disabled={!running} onSubmit={tryIt} />
            {!running && <p className="panel-note infer-viewer">{t('svcTryNotRunning')}</p>}
          </section>
          <section className="panel panel-pad infer-result">
            <div className="panel-head">
              <h2 className="panel-title">{t('inferOutput')}</h2>
              {result && (
                <span className="panel-meta mono">{t('svcLatency').replace('{ms}', String(result.latency_ms))}</span>
              )}
            </div>
            {tryErr ? (
              <p className="flash flash-err">{tryErr}</p>
            ) : result?.output ? (
              <PredictionView prediction={result.output} />
            ) : (
              <p className="panel-note">{t('inferHistoryEmpty')}</p>
            )}
          </section>
        </div>
      )}

      {svc && (
        <section className="panel">
          <div className="panel-head infer-history-head">
            <h2 className="panel-title">{t('svcStats')}</h2>
            <span className="svc-stats mono">
              <span>
                {t('svcColRequests')} <b>{svc.requests.toLocaleString()}</b>
              </span>
              <span>
                {t('svcErrorRate')} <b>{errorRate}</b>
              </span>
              <span>
                {t('svcColLatency')} <b>{formatLatency(svc.avg_latency_ms)}</b>
              </span>
            </span>
          </div>
          {svc.recent.length === 0 ? (
            <p className="panel-note panel-pad">{t('svcRecentEmpty')}</p>
          ) : (
            <div className="infer-history-wrap">
              <table className="data-table infer-history">
                <thead>
                  <tr>
                    <th>{t('svcColAt')}</th>
                    <th>{t('colStatus')}</th>
                    <th>{t('svcColRows')}</th>
                    <th>{t('colResult')}</th>
                    <th>{t('svcColLatency')}</th>
                  </tr>
                </thead>
                <tbody>
                  {svc.recent.map((r, i) => (
                    <tr key={`${r.at}-${i}`}>
                      <td className="runs-muted">{formatLocalDateTime(r.at, lang)}</td>
                      <td>
                        <StatusBadge status={r.ok ? 'succeeded' : 'failed'} label={r.ok ? 'OK' : 'ERR'} />
                      </td>
                      <td className="mono runs-muted">{r.rows}</td>
                      <td className="infer-cell mono">{r.summary || <span className="runs-sub">—</span>}</td>
                      <td className="mono runs-muted">{formatLatency(r.latency_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {svc && logs && (
        <section className="panel panel-pad">
          <div className="panel-head">
            <h2 className="panel-title">{t('svcLogs')}</h2>
          </div>
          <CodeBlock text={logs} filename={`${svc.name}.log`} maxLines={30} />
        </section>
      )}

      {svc && !canMutate && me && <p className="panel-note">{t('svcViewerHint')}</p>}

      <ConfirmDialog
        open={pending === 'stop'}
        tone="warn"
        title={t('svcStopTitle')}
        description={t('svcStopDesc').replace('{name}', svc?.name || '')}
        confirmLabel={t('svcStop')}
        cancelLabel={t('confirmCancel')}
        busy={busy}
        onConfirm={() => act(() => api.stopService(id), (v) => setSvc(v as InferenceService))}
        onClose={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === 'delete'}
        title={t('svcDeleteTitle')}
        description={t('svcDeleteDesc')}
        confirmLabel={t('svcDelete')}
        cancelLabel={t('confirmCancel')}
        requireText={svc?.name}
        busy={busy}
        onConfirm={() => act(() => api.deleteService(id), () => nav('/services'))}
        onClose={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === 'rotate'}
        tone="warn"
        title={t('svcRotateTitle')}
        description={t('svcRotateDesc')}
        confirmLabel={t('svcRotate')}
        cancelLabel={t('confirmCancel')}
        busy={busy}
        onConfirm={() =>
          act(
            () => api.rotateServiceKey(id),
            (v) => {
              const r = v as { service: InferenceService; api_key: string }
              setSvc(r.service)
              setNewKey(r.api_key)
            },
          )
        }
        onClose={() => setPending(null)}
      />
      <ApiKeyDialog apiKey={newKey} onClose={closeKey} />
    </div>
  )
}
