import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, type AuthUser, type Cluster, type Priority, type Run, type Template } from '../api'
import EnvEditor, { envFromRows, envKeyError, rowsFromEnv, type EnvRow } from '../components/EnvEditor'
import ParamsEditor, { parseParams, paramState, SWEEP_MAX_RUNS, type ParamState } from '../components/ParamsEditor'
import ScriptEditor from '../components/ScriptEditor'
import { formatApiMessage, useI18n } from '../i18n'
import '../styles/training.css'

function tmplKindLabel(kind: string | undefined, t: (k: 'tmplKindChart' | 'tmplKindTrain' | 'tmplKindGpu' | 'tmplKindPipeline' | 'tmplKindCustom') => string) {
  if (kind === 'chart-demo') return t('tmplKindChart')
  if (kind === 'train') return t('tmplKindTrain')
  if (kind === 'gpu-smoke') return t('tmplKindGpu')
  if (kind === 'pipeline') return t('tmplKindPipeline')
  return t('tmplKindCustom')
}

/** `YYYY-MM-DDTHH:mm` in local time, the format datetime-local inputs use. */
function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function quotaLabel(
  st: { user_max_active?: number; user_max_cpu?: number; user_max_memory_gi?: number; user_max_gpu?: number },
  runsLabel: string,
): string {
  const parts = [
    st.user_max_active ? runsLabel.replace('{n}', String(st.user_max_active)) : '',
    st.user_max_cpu ? `CPU ≤ ${st.user_max_cpu}` : '',
    st.user_max_memory_gi ? `${st.user_max_memory_gi}Gi` : '',
    st.user_max_gpu ? `GPU ≤ ${st.user_max_gpu}` : '',
  ]
  return parts.filter(Boolean).join(' · ')
}

export default function NewRunPage() {
  const nav = useNavigate()
  const [search, setSearch] = useSearchParams()
  const resumeId = search.get('resume')
  const { t } = useI18n()
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [clusterId, setClusterId] = useState('')
  const [templateId, setTemplateId] = useState('nanogpt-cpu')
  const [name, setName] = useState('nanogpt-cpu')
  const [concurrency, setConcurrency] = useState(3)
  const [maxQueued, setMaxQueued] = useState(20)
  const [quota, setQuota] = useState('')
  const [priority, setPriority] = useState<Priority>(0)
  const [startAt, setStartAt] = useState('')
  const [maxCpu, setMaxCpu] = useState(8)
  const [maxMemGi, setMaxMemGi] = useState(16)
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
  const [pvcMount, setPvcMount] = useState('/data')
  const [script, setScript] = useState('')
  const [paramSt, setParamSt] = useState<ParamState>({ values: {}, sweep: {} })
  const [envRows, setEnvRows] = useState<EnvRow[]>([])
  const [resumeSrc, setResumeSrc] = useState<Run | null>(null)
  const [me, setMe] = useState<AuthUser | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    Promise.all([
      api.clusters(),
      api.templates(),
      api.settings(),
      api.me().catch(() => null),
      resumeId ? api.run(resumeId) : Promise.resolve(null),
    ])
      .then(([cs, ts, st, u, src]) => {
        setClusters(cs)
        setTemplates(ts)
        setMe(u)
        if (typeof st.max_gpu === 'number') setMaxGpu(st.max_gpu)
        if (typeof st.max_cpu === 'number') setMaxCpu(st.max_cpu)
        if (typeof st.max_memory_gi === 'number') setMaxMemGi(st.max_memory_gi)
        if (typeof st.default_concurrency === 'number') setConcurrency(st.default_concurrency)
        if (typeof st.max_queued === 'number') setMaxQueued(st.max_queued)
        setQuota(quotaLabel(st, t('quotaRuns')))
        const preferred = window.localStorage.getItem('cilitrain.preferredCluster')
        const pick = cs.find((c) => c.id === preferred) || cs[0]
        if (pick) setClusterId(pick.id)
        const tmpl =
          ts.find((x) => x.id === 'nanogpt-cpu') ||
          ts.find((x) => x.id === 'monitor-demo') ||
          ts.find((x) => x.id === 'sklearn-cpu') ||
          ts[0]
        const srcTmpl = src ? ts.find((x) => x.id === src.template) : undefined
        if (src && srcTmpl) applyResume(src, srcTmpl)
        else if (tmpl) applyTemplate(tmpl)
      })
      .catch((e) => setErr(String(e.message || e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId])

  function applyResume(src: Run, tmpl: Template) {
    applyTemplate(tmpl)
    setResumeSrc(src)
    setClusterId(src.cluster_id)
    setName(`${src.name}-cont`.slice(0, 120))
    setNamespace(src.namespace)
    setImage(src.image)
    setCpu(src.cpu)
    setMemory(src.memory)
    setGpuCount(src.gpu_count ?? 0)
    setTimeoutSec(src.timeout_seconds)
    setPvc(src.pvc_name || '')
    setPvcMount(src.pvc_mount_path || '/data')
    if (src.script) setScript(src.script)
    setParamSt(paramState(tmpl.params || [], src.params))
    setEnvRows(rowsFromEnv(src.env))
  }

  function clearResume() {
    setResumeSrc(null)
    search.delete('resume')
    setSearch(search, { replace: true })
  }

  function applyTemplate(tmpl: Template) {
    setTemplateId(tmpl.id)
    setImage(tmpl.image)
    setCommand(JSON.stringify(tmpl.command, null, 0))
    setArgs(JSON.stringify(tmpl.args, null, 0))
    setCpu(tmpl.cpu)
    setMemory(tmpl.memory)
    setGpuCount(tmpl.gpu_count ?? 0)
    setTimeoutSec(tmpl.timeout_seconds)
    setScript(tmpl.script || '')
    setParamSt(paramState(tmpl.params || []))
    setResumeSrc(null)
    if (tmpl.id !== 'custom') setName(`${tmpl.id}-${Date.now().toString().slice(-4)}`)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const tmpl = templates.find((x) => x.id === templateId)
      const hasEditor = Boolean((tmpl?.script && tmpl.script.length > 0) || script.trim())
      if (hasEditor && !script.trim()) {
        setErr(t('scriptEmpty'))
        setBusy(false)
        return
      }
      if (Object.keys(parsed.errors).length || envRows.some((r) => envKeyError(r.key))) {
        setErr(t('paramSweepBad'))
        setBusy(false)
        return
      }
      const body = {
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
        pvc_mount_path: pvcMount.trim() || '/data',
        script: script.trim() ? script : null,
        params: parsed.params,
        env: envFromRows(envRows),
        resume_from: resumeSrc?.id ?? null,
        priority,
        start_at: startAt ? new Date(startAt).toISOString() : null,
      }
      if (sweeping) {
        await api.createSweep(body, parsed.grid)
        nav('/')
        return
      }
      const run = await api.createRun(body)
      nav(`/runs/${run.id}`)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  const field = 'field'
  const selectedTmpl = templates.find((x) => x.id === templateId)
  const paramFields = selectedTmpl?.params || []
  const parsed = parseParams(paramFields, paramSt)
  const sweeping = !resumeSrc && parsed.combos > 0
  const sweepOver = sweeping && parsed.combos > SWEEP_MAX_RUNS

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('newTitle')}</h1>
          <div className="hint-row mt-3" aria-label={t('newDesc')}>
            <span className="hint-chip">{t('newGuardCpu').replace('{n}', String(maxCpu))}</span>
            <span className="hint-chip">{t('newGuardMem').replace('{n}', String(maxMemGi))}</span>
            <span className="hint-chip">{t('newGuardGpu').replace('{n}', String(maxGpu))}</span>
            <span className="hint-chip">{t('newGuardTimeout')}</span>
            <span className="hint-chip">{t('newGuardConc').replace('{n}', String(concurrency))}</span>
            <span className="hint-chip">{t('newGuardQueue').replace('{n}', String(maxQueued))}</span>
            {quota && <span className="hint-chip">{t('newGuardQuota')} {quota}</span>}
          </div>
        </div>
      </div>
      {me?.role === 'viewer' && <p className="flash flash-warn mt-4">{t('showcaseViewerHint')}</p>}
      {err && <p className="flash flash-err mt-4">{formatApiMessage(err, t)}</p>}
      {resumeSrc && (
        <div className="flash flash-info mt-4 resume-banner">
          <span>
            {t('resumeBanner')
              .split('{name}')
              .flatMap((part, i) =>
                i === 0
                  ? [part]
                  : [
                      <Link key="src" to={`/runs/${resumeSrc.id}`}>
                        {resumeSrc.name}
                      </Link>,
                      part,
                    ],
              )}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={clearResume}>
            {t('resumeCancel')}
          </button>
        </div>
      )}
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
                onChange={(e) => {
                  setClusterId(e.target.value)
                  window.localStorage.setItem('cilitrain.preferredCluster', e.target.value)
                }}
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
                  disabled={Boolean(resumeSrc)}
                  onChange={(e) => {
                    const tmpl = templates.find((x) => x.id === e.target.value)
                    if (tmpl) applyTemplate(tmpl)
                  }}
                >
                  {templates.map((tmpl) => (
                    <option key={tmpl.id} value={tmpl.id}>
                      {tmplKindLabel(tmpl.kind, t)} · {tmpl.name}
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
            <div className="pvc-row">
              <label className="label">
                {t('newPriority')}
                <select
                  className={field}
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value) as Priority)}
                >
                  {([1, 0, -1] as Priority[]).map((p) => (
                    <option key={p} value={p} disabled={p > 0 && me?.role !== 'admin'}>
                      {t(`prio_${p}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="label">
                {t('newStartAt')}
                <input
                  type="datetime-local"
                  className={`${field} mono`}
                  value={startAt}
                  min={localInputValue(new Date())}
                  max={localInputValue(new Date(Date.now() + 7 * 86400_000))}
                  onChange={(e) => setStartAt(e.target.value)}
                />
              </label>
            </div>
            <p className="spec-tmpl-hint">
              {t('newPriorityHint')} {t('newStartAtHint')}
            </p>
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
            <div className="pvc-row">
              <label className="label">
                {t('pvc')}
                <input className={`${field} mono`} value={pvc} onChange={(e) => setPvc(e.target.value)} />
              </label>
              <label className="label">
                {t('pvcMount')}
                <input
                  className={`${field} mono`}
                  value={pvcMount}
                  disabled={!pvc.trim()}
                  onChange={(e) => setPvcMount(e.target.value)}
                />
              </label>
            </div>
            {pvc.trim() && <p className="spec-tmpl-hint">{t('pvcHint')}</p>}
          </fieldset>
        </div>

        <div className="spec-wide">
          <label className="label">
            {t('image')}
            <input className={`${field} mono`} value={image} onChange={(e) => setImage(e.target.value)} required />
          </label>
          {(selectedTmpl?.script != null && selectedTmpl.script !== '') || script ? (
            <div>
              <div className="label">{t('newScript')}</div>
              <p className="spec-tmpl-hint" style={{ marginBottom: '0.55rem' }}>
                {t('newScriptHint')}
              </p>
              <ScriptEditor value={script} onChange={setScript} />
            </div>
          ) : null}
          {paramFields.length > 0 && (
            <section className="spec-section" aria-labelledby="params-title">
              <div className="spec-section-head">
                <h2 id="params-title" className="spec-section-title">
                  {t('newParams')}
                </h2>
                {sweeping && (
                  <p className="sweep-summary" data-over={sweepOver ? 'true' : undefined}>
                    {sweepOver
                      ? t('sweepTooMany').replace('{n}', String(parsed.combos))
                      : t('sweepCount').replace('{n}', String(parsed.combos))}
                  </p>
                )}
              </div>
              <p className="spec-tmpl-hint">{t('newParamsHint')}</p>
              <ParamsEditor
                fields={paramFields}
                state={paramSt}
                onChange={setParamSt}
                allowSweep={!resumeSrc}
              />
            </section>
          )}
          <section className="spec-section" aria-labelledby="env-title">
            <h2 id="env-title" className="spec-section-title">
              {t('newEnv')}
            </h2>
            <p className="spec-tmpl-hint">{t('newEnvHint')}</p>
            <EnvEditor rows={envRows} onChange={setEnvRows} />
          </section>
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
          <button
            type="submit"
            disabled={busy || !clusterId || me?.role === 'viewer' || sweepOver}
            className="btn btn-primary"
          >
            {busy
              ? t('submitting')
              : sweeping
                ? t('submitSweep').replace('{n}', String(parsed.combos))
                : resumeSrc
                  ? t('resumeAction')
                  : t('submit')}
          </button>
        </div>
      </form>
    </div>
  )
}
