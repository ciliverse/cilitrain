import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, downloadFile, type AuthUser, type ModelVersion, type Run } from '../api'
import BatchInferForm from '../components/BatchInferForm'
import DeployServiceDialog from '../components/DeployServiceDialog'
import InferForm, { useFieldLabel } from '../components/InferForm'
import ModelVersions from '../components/ModelVersions'
import PredictionView, { predictionSummary } from '../components/PredictionView'
import StatusBadge from '../components/StatusBadge'
import { formatApiMessage, formatDuration, formatLocalDateTime, useI18n } from '../i18n'
import { formatBytes, formatMetric } from './ModelsPage'
import '../styles/runs.css'
import '../styles/models.css'

function isActive(status: string) {
  return status === 'queued' || status === 'pending' || status === 'running'
}

export function inputSummary(input?: Record<string, string | number> | null, batchLabel?: string): string {
  if (batchLabel) return batchLabel
  if (!input) return ''
  return Object.entries(input)
    .map(([k, v]) => (typeof v === 'string' ? `"${v.length > 24 ? `${v.slice(0, 24)}…` : v}"` : `${k}=${v}`))
    .join(' · ')
}

export default function ModelDetailPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const { t, statusLabel, lang } = useI18n()
  const fieldLabel = useFieldLabel()
  const [model, setModel] = useState<ModelVersion | null>(null)
  const [siblings, setSiblings] = useState<ModelVersion[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [me, setMe] = useState<AuthUser | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'single' | 'batch'>('single')
  const [deployOpen, setDeployOpen] = useState(false)
  const [deployErr, setDeployErr] = useState('')

  const loadRuns = useCallback(() => {
    api
      .modelRuns(id)
      .then(setRuns)
      .catch(() => {})
  }, [id])

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null))
    api
      .model(id)
      .then((m) => {
        setModel(m)
        return api.models().then((all) => setSiblings(all.filter((x) => x.name === m.name)))
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
    loadRuns()
  }, [id, loadRuns])

  const anyActive = runs.some((r) => isActive(r.status))
  useEffect(() => {
    if (!anyActive) return
    const timer = window.setInterval(loadRuns, 2000)
    return () => window.clearInterval(timer)
  }, [anyActive, loadRuns])

  async function launch(start: () => Promise<Run>) {
    setBusy(true)
    setErr('')
    try {
      const run = await start()
      setRuns((prev) => [run, ...prev])
    } catch (e) {
      setErr(formatApiMessage(e instanceof Error ? e.message : String(e), t))
    } finally {
      setBusy(false)
    }
  }

  function downloadModel() {
    if (!model) return
    setErr('')
    downloadFile(api.modelDownloadUrl(model.id), `${model.name}-v${model.version}`).catch((e) =>
      setErr(e instanceof Error ? e.message : String(e)),
    )
  }

  async function deploy(name: string, replicas: number) {
    if (!model) return
    setBusy(true)
    setDeployErr('')
    try {
      const { service, api_key } = await api.createService({ model_id: model.id, name, replicas })
      sessionStorage.setItem(`svc-key-${service.id}`, api_key)
      nav(`/services/${service.id}`)
    } catch (e) {
      setDeployErr(formatApiMessage(e instanceof Error ? e.message : String(e), t))
    } finally {
      setBusy(false)
    }
  }

  const batchLabel = (r: Run) => (r.batch_rows ? t('batchRows').replace('{n}', String(r.batch_rows)) : undefined)

  const latest = runs[0]
  const viewer = me?.role === 'viewer'

  return (
    <div className="runs-detail models-detail space-y-6">
      <nav className="runs-crumb" aria-label={t('navModels')}>
        <Link to="/models">{t('modelsTitle')}</Link>
        <span className="runs-crumb-sep" aria-hidden="true">
          /
        </span>
        <span className="runs-crumb-now">{model?.label || t('loading')}</span>
      </nav>

      <div className="page-head runs-detail-head">
        <div className="min-w-0">
          <div className="runs-title-row">
            <h1 className="page-title mono">
              {model?.name}
              {model && <span className="model-ver model-ver-lg">v{model.version}</span>}
            </h1>
          </div>
          <div className="runs-head-meta">
            {model && <span className="mono">{model.template}</span>}
          </div>
        </div>
        {model && (model.files.length > 0 || (model.infer && !viewer)) && (
          <div className="flex flex-wrap items-center gap-2">
            {model.files.length > 0 && (
              <button type="button" className="btn btn-secondary" onClick={downloadModel}>
                {t('modelDownload')}
              </button>
            )}
            {model.infer && !viewer && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setDeployErr('')
                  setDeployOpen(true)
                }}
              >
                {t('svcDeploy')}
              </button>
            )}
          </div>
        )}
      </div>

      {model && (
        <dl className="runs-spec">
          <div>
            <dt>{t('modelFrom')}</dt>
            <dd>
              {model.source_run_id ? (
                <Link to={`/runs/${model.source_run_id}`} className="mono">
                  {model.source_run_name || model.source_run_id.slice(0, 8)}
                </Link>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt>{t('modelFiles')}</dt>
            <dd className="mono">
              {model.files.map((f) => f.path).join(', ')} · {formatBytes(model.size_bytes)}
            </dd>
          </div>
          {Object.entries(model.metrics)
            .filter(([k]) => k !== 'epochs')
            .slice(0, 4)
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className="mono">{formatMetric(v)}</dd>
              </div>
            ))}
          <div>
            <dt>{t('modelRegistered')}</dt>
            <dd>{formatLocalDateTime(model.created_at, lang)}</dd>
          </div>
        </dl>
      )}

      {err && <p className="flash flash-err">{err}</p>}

      {model && (
        <div className="infer-layout">
          <section className="panel panel-pad">
            <div className="panel-head">
              <h2 className="panel-title">{t('inferTitle')}</h2>
              {model.infer && (
                <span className="panel-meta mono">
                  {model.infer.cpu} CPU · {model.infer.memory}
                </span>
              )}
            </div>
            <p className="panel-note infer-desc">{t('inferDesc')}</p>
            {!model.infer ? (
              <p className="panel-note">{t('inferUnsupported')}</p>
            ) : (
              <>
                <div className="runs-kind infer-mode" role="group" aria-label={t('inferTitle')}>
                  <button type="button" aria-pressed={mode === 'single'} onClick={() => setMode('single')}>
                    {t('inferModeSingle')}
                  </button>
                  <button type="button" aria-pressed={mode === 'batch'} onClick={() => setMode('batch')}>
                    {t('inferModeBatch')}
                  </button>
                </div>
                {mode === 'single' ? (
                  <InferForm
                    spec={model.infer}
                    busy={busy}
                    disabled={viewer}
                    onSubmit={(input) => launch(() => api.infer(id, input))}
                  />
                ) : (
                  <BatchInferForm
                    spec={model.infer}
                    busy={busy}
                    disabled={viewer}
                    onSubmit={(csv) => launch(() => api.inferBatch(id, csv))}
                  />
                )}
                {viewer && <p className="panel-note infer-viewer">{t('inferViewerHint')}</p>}
              </>
            )}
          </section>

          <section className="panel panel-pad infer-result">
            <div className="panel-head">
              <h2 className="panel-title">{t('inferOutput')}</h2>
              {latest && (
                <span className="infer-result-head">
                  <StatusBadge status={latest.status} label={statusLabel(latest.status)} />
                  <Link to={`/runs/${latest.id}`} className="panel-meta mono">
                    {latest.job_name || latest.id.slice(0, 8)}
                  </Link>
                </span>
              )}
            </div>
            {!latest ? (
              <p className="panel-note">{t('inferHistoryEmpty')}</p>
            ) : latest.prediction ? (
              <>
                <PredictionView prediction={latest.prediction} runId={latest.id} />
                {latest.infer_input && (
                  <dl className="infer-echo">
                    {Object.entries(latest.infer_input)
                      .filter(([, v]) => typeof v !== 'string')
                      .map(([k, v]) => (
                        <div key={k}>
                          <dt>{fieldLabel(k)}</dt>
                          <dd className="mono">{v}</dd>
                        </div>
                      ))}
                  </dl>
                )}
              </>
            ) : isActive(latest.status) ? (
              <div className="infer-wait">
                <span className="infer-wait-bar" />
                <p className="panel-note">{t('inferWaiting')}</p>
              </div>
            ) : (
              <p className="panel-note">{latest.error_message || t('inferNoOutput')}</p>
            )}
          </section>
        </div>
      )}

      {model && siblings.length > 1 && <ModelVersions current={model} versions={siblings} />}

      <section className="panel">
        <div className="panel-head infer-history-head">
          <h2 className="panel-title">{t('inferHistory')}</h2>
          <span className="panel-meta mono">{runs.length}</span>
        </div>
        {runs.length === 0 ? (
          <p className="panel-note panel-pad">{t('inferHistoryEmpty')}</p>
        ) : (
          <div className="infer-history-wrap">
          <table className="data-table infer-history">
            <thead>
              <tr>
                <th>{t('colStatus')}</th>
                <th>{t('inferInput')}</th>
                <th>{t('colResult')}</th>
                <th>{t('colDuration')}</th>
                <th>{t('colCreated')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="data-row" onClick={() => nav(`/runs/${r.id}`)}>
                  <td>
                    <StatusBadge status={r.status} label={statusLabel(r.status)} />
                  </td>
                  <td className="mono runs-muted infer-cell" title={batchLabel(r) || JSON.stringify(r.infer_input)}>
                    {inputSummary(r.infer_input, batchLabel(r))}
                  </td>
                  <td className="infer-cell" title={predictionSummary(r.prediction)}>
                    {predictionSummary(r.prediction) || <span className="runs-sub">—</span>}
                  </td>
                  <td className="mono runs-muted">{formatDuration(r.duration_seconds)}</td>
                  <td className="runs-muted">{formatLocalDateTime(r.created_at, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <DeployServiceDialog
        open={deployOpen}
        initialName={model ? `${model.name}-v${model.version}`.slice(0, 41) : ''}
        busy={busy}
        error={deployErr}
        onSubmit={deploy}
        onClose={() => setDeployOpen(false)}
      />
    </div>
  )
}
