import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type Cluster, type Template } from '../api'
import { useI18n } from '../i18n'

export default function NewRunPage() {
  const nav = useNavigate()
  const { t } = useI18n()
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [clusterId, setClusterId] = useState('')
  const [templateId, setTemplateId] = useState('sklearn-cpu')
  const [name, setName] = useState('sklearn-demo')
  const [namespace, setNamespace] = useState('default')
  const [image, setImage] = useState('')
  const [command, setCommand] = useState('[]')
  const [args, setArgs] = useState('[]')
  const [cpu, setCpu] = useState('1')
  const [memory, setMemory] = useState('1Gi')
  const [gpuCount, setGpuCount] = useState(0)
  const [maxGpu, setMaxGpu] = useState(2)
  const [timeout, setTimeoutSec] = useState(3600)
  const [pvc, setPvc] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    Promise.all([api.clusters(), api.templates(), api.settings()])
      .then(([cs, ts, st]) => {
        setClusters(cs)
        setTemplates(ts)
        if (typeof st.max_gpu === 'number') setMaxGpu(st.max_gpu)
        if (cs[0]) setClusterId(cs[0].id)
        const tmpl = ts.find((x) => x.id === 'sklearn-cpu') || ts[0]
        if (tmpl) applyTemplate(tmpl)
      })
      .catch((e) => setErr(String(e.message || e)))
  }, [])

  function applyTemplate(tmpl: Template) {
    setTemplateId(tmpl.id)
    setImage(tmpl.image)
    setCommand(JSON.stringify(tmpl.command, null, 0))
    setArgs(JSON.stringify(tmpl.args, null, 0))
    setCpu(tmpl.cpu)
    setMemory(tmpl.memory)
    setGpuCount(tmpl.gpu_count ?? 0)
    setTimeoutSec(tmpl.timeout_seconds)
    if (tmpl.id !== 'custom') setName(`${tmpl.id}-${Date.now().toString().slice(-4)}`)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const run = await api.createRun({
        cluster_id: clusterId,
        name,
        namespace,
        template: templateId,
        image,
        command: JSON.parse(command),
        args: JSON.parse(args),
        cpu,
        memory,
        gpu_count: gpuCount,
        timeout_seconds: timeout,
        pvc_name: pvc.trim() || null,
      })
      nav(`/runs/${run.id}`)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  const field = 'field'
  const selectedTmpl = templates.find((x) => x.id === templateId)

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('newTitle')}</h1>
          <div className="hint-row mt-3" aria-label={t('newDesc')}>
            <span className="hint-chip">{t('newGuardCpu')}</span>
            <span className="hint-chip">{t('newGuardMem')}</span>
            <span className="hint-chip">{t('newGuardGpu')}</span>
            <span className="hint-chip">{t('newGuardTimeout')}</span>
          </div>
        </div>
      </div>
      {err && <p className="flash flash-err mt-4">{err}</p>}
      {clusters.length === 0 && (
        <p className="flash flash-warn mt-4">
          {t('needCluster')}{' '}
          <Link to="/clusters">{t('goClusters')}</Link>
        </p>
      )}

      <form onSubmit={onSubmit} className="panel panel-pad spec-form mt-6">
        <div className="spec-form-cols">
          <fieldset className="spec-col">
            <legend className="spec-col-title">{t('newIdentity')}</legend>
            <label className="label">
              {t('cluster')}
              <select
                className={field}
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
            <div>
              <label className="label">
                {t('template')}
                <select
                  className={field}
                  value={templateId}
                  onChange={(e) => {
                    const tmpl = templates.find((x) => x.id === e.target.value)
                    if (tmpl) applyTemplate(tmpl)
                  }}
                >
                  {templates.map((tmpl) => (
                    <option key={tmpl.id} value={tmpl.id}>
                      {tmpl.name}
                    </option>
                  ))}
                </select>
              </label>
              {selectedTmpl?.description && (
                <p className="spec-tmpl-hint">{selectedTmpl.description}</p>
              )}
            </div>
            <label className="label">
              {t('name')}
              <input className={field} value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label className="label">
              {t('namespace')}
              <input
                className={`${field} mono`}
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                required
              />
            </label>
          </fieldset>

          <fieldset className="spec-col">
            <legend className="spec-col-title">{t('newResources')}</legend>
            <label className="label">
              {t('cpu')}
              <input className={`${field} mono`} value={cpu} onChange={(e) => setCpu(e.target.value)} />
            </label>
            <label className="label">
              {t('memory')}
              <input
                className={`${field} mono`}
                value={memory}
                onChange={(e) => setMemory(e.target.value)}
              />
            </label>
            <label className="label">
              {t('gpu')} (0-{maxGpu})
              <input
                type="number"
                min={0}
                max={maxGpu}
                className={`${field} mono`}
                value={gpuCount}
                onChange={(e) => setGpuCount(Number(e.target.value))}
              />
            </label>
            {gpuCount > 0 && (
              <p className="text-xs text-[var(--warn)]">{t('gpuHint')}</p>
            )}
            <label className="label">
              {t('timeout')}
              <input
                type="number"
                className={`${field} mono`}
                value={timeout}
                onChange={(e) => setTimeoutSec(Number(e.target.value))}
              />
            </label>
            <label className="label">
              {t('pvc')}
              <input className={`${field} mono`} value={pvc} onChange={(e) => setPvc(e.target.value)} />
            </label>
          </fieldset>
        </div>

        <div className="spec-wide">
          <label className="label">
            {t('image')}
            <input className={`${field} mono`} value={image} onChange={(e) => setImage(e.target.value)} required />
          </label>
          <details className="spec-advanced">
            <summary>{t('newWorkload')}</summary>
            <label className="label">
              {t('command')}
              <textarea
                className={`${field} mono h-20`}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
            </label>
            <label className="label">
              {t('args')}
              <textarea
                className={`${field} mono h-28`}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            </label>
          </details>
        </div>

        <div className="spec-form-foot">
          <button type="submit" disabled={busy || !clusterId} className="btn btn-primary">
            {busy ? t('submitting') : t('submit')}
          </button>
        </div>
      </form>
    </div>
  )
}
