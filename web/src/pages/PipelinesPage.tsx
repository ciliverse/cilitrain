import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, type Cluster, type Pipeline, type Template } from '../api'
import StatusBadge from '../components/StatusBadge'
import { formatApiMessage, useI18n } from '../i18n'

export default function PipelinesPage() {
  const { t, statusLabel } = useI18n()
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [name, setName] = useState('demo-pipeline')
  const [clusterId, setClusterId] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    const [ps, cs, ts] = await Promise.all([api.pipelines(), api.clusters(), api.templates()])
    setPipelines(ps)
    setClusters(cs)
    setTemplates(ts)
    if (!clusterId && cs[0]) setClusterId(cs[0].id)
  }

  useEffect(() => {
    refresh().catch((e) => setErr(String(e.message || e)))
    const id = window.setInterval(() => {
      refresh().catch(() => undefined)
    }, 5000)
    return () => window.clearInterval(id)
  }, [])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setErr('')
    const pre =
      templates.find((x) => x.id === 'preprocess-demo') || templates.find((x) => x.id === 'custom')
    const train =
      templates.find((x) => x.id === 'monitor-demo') ||
      templates.find((x) => x.id === 'sklearn-cpu') ||
      templates[0]
    if (!pre || !train) {
      setErr('templates missing')
      return
    }
    setBusy(true)
    try {
      await api.createPipeline({
        name,
        cluster_id: clusterId,
        namespace: 'default',
        steps: [
          {
            name: 'preprocess',
            template: pre.id,
            image: pre.image,
            command: pre.command,
            args: pre.args,
            cpu: pre.cpu,
            memory: pre.memory,
            timeout_seconds: pre.timeout_seconds,
          },
          {
            name: 'train',
            template: train.id,
            image: train.image,
            command: train.command,
            args: train.args,
            cpu: train.cpu,
            memory: train.memory,
            timeout_seconds: train.timeout_seconds,
          },
        ],
      })
      await refresh()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-8">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('pipelinesTitle')}</h1>
          <p className="page-desc">{t('pipelinesDesc')}</p>
        </div>
      </div>
      {err && <p className="flash flash-err">{err}</p>}
      {clusters.length === 0 && (
        <p className="flash flash-warn">
          {t('needCluster')}{' '}
          <Link to="/clusters">{t('goClusters')}</Link>
        </p>
      )}

      <form onSubmit={onCreate} className="panel panel-pad pipe-create">
        <label className="label">
          {t('pipelineName')}
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="label">
          {t('cluster')}
          <select
            className="field"
            value={clusterId}
            onChange={(e) => setClusterId(e.target.value)}
            required
          >
            {clusters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={!clusterId || busy || clusters.length === 0} className="btn btn-primary">
          {busy ? t('pipeCreating') : t('createPipeline')}
        </button>
        <p className="pipe-create-hint">{t('pipeStepsHint')}</p>
      </form>

      {pipelines.length === 0 ? (
        <div className="empty-state">
          <p className="empty-title">{t('pipeEmpty')}</p>
        </div>
      ) : (
        <div className="pipe-list">
          <div className="pipe-row pipe-row-head">
            <span>{t('name')}</span>
            <span>{t('colStatus')}</span>
            <span>{t('step')}</span>
            <span>{t('pipelineRuns')}</span>
            <span />
          </div>
          {pipelines.map((p) => (
            <div key={p.id} className="pipe-row">
              <div className="pipe-row-name">
                <div>{p.name}</div>
                <div className="pipe-row-id mono">{p.id.slice(0, 12)}</div>
              </div>
              <StatusBadge status={p.status} label={statusLabel(p.status)} />
              <div className="pipe-row-meta mono">
                {t('step')} {p.current_step + 1}/{p.steps.length}
                {p.pvc_name ? (
                  <>
                    <br />
                    {t('pipelinePvc')} {p.pvc_name}
                  </>
                ) : null}
                {p.error_message ? (
                  <div className="text-[var(--danger)]">{formatApiMessage(p.error_message, t)}</div>
                ) : null}
              </div>
              <div className="pipe-row-runs">
                {p.run_ids.length === 0 ? (
                  <span>{t('pipeNoRuns')}</span>
                ) : (
                  p.run_ids.map((rid, i) => (
                    <Link key={rid} className="mono" to={`/runs/${rid}`}>
                      s{i + 1} {rid.slice(0, 8)}
                    </Link>
                  ))
                )}
              </div>
              <div className="pipe-row-actions">
                {(p.status === 'pending' || p.status === 'running') && (
                  <button
                    type="button"
                    className="btn btn-warn btn-sm"
                    onClick={async () => {
                      await api.cancelPipeline(p.id)
                      await refresh()
                    }}
                  >
                    {t('pipeStop')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
