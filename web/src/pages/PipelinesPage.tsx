import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, type Cluster, type Pipeline, type Template } from '../api'
import { useI18n } from '../i18n'

export default function PipelinesPage() {
  const { t, statusLabel } = useI18n()
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [name, setName] = useState('demo-pipeline')
  const [clusterId, setClusterId] = useState('')
  const [err, setErr] = useState('')

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
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="page-title">{t('pipelinesTitle')}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{t('pipelinesDesc')}</p>
      </div>
      {err && <p className="text-sm text-[var(--danger)]">{err}</p>}

      <form
        onSubmit={onCreate}
        className="grid max-w-xl gap-3 panel panel-pad"
      >
        <h2 className="font-semibold">{t('newPipeline')}</h2>
        <label className="text-sm">
          <span className="text-[var(--muted)]">{t('pipelineName')}</span>
          <input
            className="mt-1 w-full rounded border border-[var(--line)] bg-black/20 px-3 py-2"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="text-sm">
          <span className="text-[var(--muted)]">{t('cluster')}</span>
          <select
            className="mt-1 w-full rounded border border-[var(--line)] bg-black/20 px-3 py-2"
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
        <p className="text-xs text-[var(--muted)]">
          {t('step')} 1: preprocess-demo → {t('step')} 2: monitor-demo / sklearn-cpu
        </p>
        <button
          type="submit"
          disabled={!clusterId}
          className="rounded border border-[var(--accent-dim)] bg-[var(--accent)]/15 px-4 py-2 text-sm font-semibold text-[var(--accent)] disabled:opacity-40"
        >
          {t('createPipeline')}
        </button>
      </form>

      <div className="space-y-3">
        {pipelines.map((p) => (
          <div key={p.id} className="panel panel-pad text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-lg font-semibold">{p.name}</div>
                <div className="mono text-xs text-[var(--muted)]">
                  {statusLabel(p.status)} · {t('step')} {p.current_step + 1}/{p.steps.length}
                  {p.pvc_name ? ` · ${t('pipelinePvc')} ${p.pvc_name}` : ''}
                </div>
              </div>
              {(p.status === 'pending' || p.status === 'running') && (
                <button
                  type="button"
                  className="rounded border border-[var(--warn)]/40 px-2 py-1 text-xs text-[var(--warn)]"
                  onClick={async () => {
                    await api.cancelPipeline(p.id)
                    await refresh()
                  }}
                >
                  {t('cancel')}
                </button>
              )}
            </div>
            {p.error_message && (
              <p className="mt-2 text-xs text-[var(--danger)]">{p.error_message}</p>
            )}
            <div className="mt-3">
              <div className="mb-1 text-xs text-[var(--muted)]">{t('pipelineRuns')}</div>
              <ul className="space-y-1">
                {p.run_ids.map((rid, i) => (
                  <li key={rid}>
                    <Link className="mono text-[var(--accent)] hover:underline" to={`/runs/${rid}`}>
                      s{i + 1}: {rid.slice(0, 8)}…
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
