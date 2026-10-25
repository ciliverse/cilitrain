import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, downloadFile, type AuthUser, type MetricsView, type Run } from '../api'
import CodeBlock from '../components/CodeBlock'
import ConfirmDialog from '../components/ConfirmDialog'
import ExtIcon from '../components/ExtIcon'
import LiveChip from '../components/LiveChip'
import MetricsChart, { nextLegendHidden } from '../components/MetricsChart'
import StatusBadge from '../components/StatusBadge'
import { useFieldLabel } from '../components/InferForm'
import PredictionView from '../components/PredictionView'
import RegisterModelDialog, { suggestModelName } from '../components/RegisterModelDialog'
import { formatApiMessage, formatDuration, formatLocalDateTime, useI18n } from '../i18n'
import '../styles/runs.css'
import '../styles/models.css'
import '../styles/training.css'

function isActive(status?: string) {
  return status === 'queued' || status === 'pending' || status === 'running'
}

function isTerminal(status?: string) {
  return status === 'succeeded' || status === 'failed' || status === 'timeout' || status === 'cancelled'
}

function isMissingCluster(message: string) {
  return /cluster not found/i.test(message)
}

function preferLogs(prev: string, next: string) {
  if (!next) return prev
  if (!prev) return next
  if (/(logs timed out|集群不可达|logs not ready)/i.test(next) && prev.length > 40) return prev
  if (next.includes(prev) || next.length >= prev.length) return next
  if (prev.includes(next)) return prev
  return next
}

type Dialog = 'cancel' | 'cleanup' | 'delete' | 'rerun' | null

function canCleanup(run: Run) {
  return (run.status === 'failed' || run.status === 'timeout') && Boolean(run.job_name) && !run.simulated
}

const STEP_RE = /epoch\s+(\d+)\s*\/\s*(\d+)\s+step\s+(\d+)\s*\/\s*(\d+)\s+loss\s+([-\d.]+)/gi

type Phase = {
  kind: 'installing' | 'starting' | 'training'
  epoch?: number
  epochs?: number
  step?: number
  steps?: number
  loss?: number
  ratio?: number
}

/** Derive a coarse "what is it doing right now" view from the tail of the logs. */
function derivePhase(logs: string, hasSeries: boolean): Phase | null {
  if (!logs) return null
  let last: RegExpExecArray | null = null
  STEP_RE.lastIndex = 0
  for (let m = STEP_RE.exec(logs); m; m = STEP_RE.exec(logs)) last = m
  if (last) {
    const [, e, es, s, ss, loss] = last
    const epoch = Number(e)
    const epochs = Number(es)
    const step = Number(s)
    const steps = Number(ss)
    const done = (epoch - 1) * steps + step
    return {
      kind: 'training',
      epoch,
      epochs,
      step,
      steps,
      loss: Number(loss),
      ratio: epochs * steps > 0 ? Math.min(1, done / (epochs * steps)) : undefined,
    }
  }
  if (hasSeries) return { kind: 'training' }
  const tail = logs.split('\n').filter(Boolean).slice(-8).join('\n')
  if (
    /\[cilitrain\] installing/i.test(logs) &&
    !/running train\.py|training nanoGPT|metrics epoch=/i.test(tail)
  ) {
    return { kind: 'installing' }
  }
  return { kind: 'starting' }
}

export default function RunDetailPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const { t, statusLabel, lang } = useI18n()
  const [run, setRun] = useState<Run | null>(null)
  const [logs, setLogs] = useState('')
  const [pod, setPod] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [metrics, setMetrics] = useState<MetricsView | null>(null)
  const [lastSync, setLastSync] = useState<number | null>(null)
  const [paused, setPaused] = useState(false)
  const [follow, setFollow] = useState(true)
  const [logCopied, setLogCopied] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [me, setMe] = useState<AuthUser | null>(null)
  const [trainHidden, setTrainHidden] = useState<Set<string>>(() => new Set())
  const [regOpen, setRegOpen] = useState(false)
  const [regBusy, setRegBusy] = useState(false)
  const [regErr, setRegErr] = useState('')
  const fieldLabel = useFieldLabel()
  const logRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null))
  }, [])

  async function load() {
    if (!id) return
    try {
      const r = await api.run(id)
      setRun(r)
      try {
        const [l, m] = await Promise.all([api.logs(id), api.metrics(id)])
        setLogs((prev) => preferLogs(prev, l.logs))
        setPod(l.pod_name || r.pod_name || null)
        setMetrics(m)
        setLastSync(Date.now())
        setErr('')
      } catch (side) {
        setErr(side instanceof Error ? side.message : String(side))
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    async function tick() {
      if (!id || cancelled) return
      try {
        const r = await api.run(id)
        if (cancelled) return
        setRun(r)
        try {
          const [l, m] = await Promise.all([api.logs(id), api.metrics(id)])
          if (cancelled) return
          setLogs((prev) => preferLogs(prev, l.logs))
          setPod(l.pod_name || r.pod_name || null)
          setMetrics(m)
          setLastSync(Date.now())
          setErr('')
        } catch (side) {
          if (!cancelled) setErr(side instanceof Error ? side.message : String(side))
        }
        if (!isTerminal(r.status) && !paused) {
          timer = window.setTimeout(tick, 3000)
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
        if (!paused) timer = window.setTimeout(tick, 5000)
      }
    }

    tick()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [id, paused, nonce])

  useEffect(() => {
    if (!follow) return
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, follow])

  const phase = useMemo(
    () => derivePhase(logs, Boolean(metrics?.series?.length)),
    [logs, metrics?.series?.length],
  )

  const phaseText = useMemo(() => {
    if (!phase) return ''
    if (phase.kind === 'installing') return t('phaseInstalling')
    if (phase.kind === 'starting') return t('phaseStarting')
    if (phase.epoch) {
      const head = `${t('phaseEpoch').replace('{n}', String(phase.epoch))}${
        phase.epochs ? `/${phase.epochs}` : ''
      }`
      const tail = phase.steps ? ` · step ${phase.step}/${phase.steps}` : ''
      const loss = phase.loss != null ? ` · loss ${phase.loss.toFixed(4)}` : ''
      return `${head}${tail}${loss}`
    }
    const last = metrics?.series?.[metrics.series.length - 1]
    const ep = last && Number.isFinite(Number(last.epoch)) ? Number(last.epoch) : null
    return ep != null ? t('phaseEpoch').replace('{n}', String(ep)) : t('phaseStarting')
  }, [phase, metrics?.series, t])

  const rail = useMemo(() => {
    const cells: { k: string; v: string; sub?: string; tone?: string }[] = []
    for (const [k, v] of Object.entries(metrics?.summary || {})) {
      let text: string
      if (typeof v !== 'number') text = String(v)
      else if (k === 'params' || k === 'rows') text = Math.round(v).toLocaleString()
      else if (Number.isInteger(v) || ['epochs', 'epoch', 'vocab'].includes(k))
        text = String(Math.round(v))
      else text = v.toFixed(4)
      cells.push({ k, v: text })
    }
    const res = metrics?.resource
    if (res?.available && res.cpu) {
      cells.push({ k: 'CPU', v: res.cpu, sub: res.pod_name || undefined, tone: 'live' })
      if (res.memory) cells.push({ k: 'MEM', v: res.memory, tone: 'live' })
    }
    return cells
  }, [metrics])

  const charts = useMemo(() => {
    type Cell = {
      id: string
      title: string
      meta: string
      series: Record<string, number>[]
      keys: string[]
      xKey: string
      xLabel: string
      wallOrigin?: string | null
    }
    const out: Cell[] = []
    if (metrics?.series?.length && metrics.chart_keys?.length) {
      out.push({
        id: 'train',
        title: t('trainCurve'),
        meta: '',
        series: metrics.series,
        keys: metrics.chart_keys,
        xKey: metrics.x_key === 'index' ? 'index' : metrics.x_key === 'x' ? 'x' : 'epoch',
        xLabel: metrics.x_key === 'index' ? t('indexAxis') : t('epochAxis'),
      })
    }
    const res = metrics?.resource
    const rs = res?.series || []
    const src = res?.frozen
      ? t('resourceFrozen')
      : res?.series_source === 'showcase'
        ? t('resourceFromSim')
        : res?.series_source === 'prometheus'
          ? t('resourceFromProm')
          : res?.series_source === 'metrics-server'
            ? t('resourceFromMs')
            : ''
    if (rs.some((p) => Number.isFinite(Number(p.cpu_m)))) {
      out.push({
        id: 'cpu',
        title: `${t('resourceChart')} · CPU`,
        meta: src,
        series: rs,
        keys: ['cpu_m'],
        xKey: 't',
        xLabel: t('timeAxis'),
        wallOrigin: run?.created_at,
      })
    }
    if (rs.some((p) => Number.isFinite(Number(p.memory_mi)))) {
      out.push({
        id: 'mem',
        title: `${t('resourceChart')} · MEM`,
        meta: src,
        series: rs,
        keys: ['memory_mi'],
        xKey: 't',
        xLabel: t('timeAxis'),
        wallOrigin: run?.created_at,
      })
    }
    return out
  }, [metrics, run?.created_at, t])

  const ckLinks = useMemo(() => {
    const l = run?.cilikube_links
    if (!l?.configured) return []
    return [
      { label: t('ckLinkJob'), href: l.job },
      { label: t('ckLinkPod'), href: l.pod },
      { label: t('ckLinkEvents'), href: l.events },
      { label: t('ckLinkPvc'), href: l.pvc },
      { label: t('ckLinkConsole'), href: l.console },
    ].filter((x): x is { label: string; href: string } => Boolean(x.href))
  }, [run?.cilikube_links, t])

  // `exit=0` from the pod condition is data, not a message worth a banner.
  const exitCode = useMemo(() => {
    const m = /^exit=(\d+)$/.exec((run?.status_message || '').trim())
    return m ? Number(m[1]) : null
  }, [run?.status_message])

  const resourceNote = useMemo(() => {
    const res = metrics?.resource
    if (!res) return ''
    if (res.available && res.cpu) return ''
    if (res.message === 'resource_history_frozen' || res.frozen || (isTerminal(run?.status) && res.series?.length))
      return t('resourceFinishedHist')
    if (!res.available && !res.series?.length) return t('resourceSetupHint')
    if (res.pending || res.message === 'waiting_for_pod_scrape') return t('resourcePending')
    if (res.message === 'pod_finished_no_live_metrics') return t('resourceFinished')
    return t('resourceIdle')
  }, [metrics?.resource, run?.status, t])

  async function confirmAction() {
    if (!id || !run || !dialog) return
    setBusy(true)
    try {
      if (dialog === 'cancel') {
        const r = await api.cancelRun(id)
        setRun(r)
        setDialog(null)
        await load()
      } else if (dialog === 'cleanup') {
        await api.cleanupRun(id)
        setMsg(t('cleanupDone'))
        setDialog(null)
        await load()
      } else if (dialog === 'delete') {
        await api.deleteRun(id)
        setDialog(null)
        nav('/')
        return
      } else if (dialog === 'rerun') {
        const created = await api.rerunRun(id)
        setDialog(null)
        nav(`/runs/${created.id}`)
        return
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setDialog(null)
    } finally {
      setBusy(false)
    }
  }

  const crumb = (
    <nav className="runs-crumb" aria-label={t('detailBack')}>
      <Link to="/">{t('detailBack')}</Link>
      <span className="runs-crumb-sep" aria-hidden="true">
        /
      </span>
      <span className="runs-crumb-now">{run?.name || t('loading')}</span>
    </nav>
  )

  if (!run && !err) {
    return (
      <div className="runs-detail">
        {crumb}
        <dl className="runs-spec" aria-busy="true" aria-label={t('loading')}>
          <div>
            <dt>{t('detailStatus')}</dt>
            <dd>
              <span className="runs-skel runs-skel-sm" />
            </dd>
          </div>
          <div>
            <dt>{t('detailDuration')}</dt>
            <dd>
              <span className="runs-skel runs-skel-sm" />
            </dd>
          </div>
          <div>
            <dt>{t('detailCreated')}</dt>
            <dd>
              <span className="runs-skel runs-skel-lg" />
            </dd>
          </div>
        </dl>
      </div>
    )
  }

  const clusterGone = Boolean(err && isMissingCluster(err))

  return (
    <div className="runs-detail space-y-6">
      {crumb}

      <div className="page-head runs-detail-head">
        <div className="min-w-0">
          <div className="runs-title-row">
            <h1 className="page-title">{run?.name || 'Run'}</h1>
            {run && <StatusBadge status={run.status} label={statusLabel(run.status)} />}
          </div>
          <div className="runs-head-meta">
            {run?.job_name ? <span className="mono">{run.job_name}</span> : null}
            {!clusterGone && ckLinks.length > 0 && (
              <span className="runs-ck">
                <span className="runs-ck-label">CiliKube</span>
                {ckLinks.map((l) => (
                  <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className="runs-ck-link">
                    {l.label}
                    <ExtIcon />
                  </a>
                ))}
              </span>
            )}
            {!clusterGone && run && !run.cilikube_links?.configured && (
              <Link to="/clusters#cilikube" className="runs-ck-link" title={t('cilikubeNotConfigured')}>
                CiliKube · {t('goClusters')}
              </Link>
            )}
            {(run?.registered_models || []).length > 0 && (
              <span className="run-registered">
                {t('registeredAs')}
                {run?.registered_models?.map((m) => (
                  <Link key={m.id} to={`/models/${m.id}`} className="runs-ck-link mono">
                    {m.label}
                  </Link>
                ))}
              </span>
            )}
            {run?.resume_from && (
              <span className="run-registered">
                {t('detailResumeFrom')}
                <Link to={`/runs/${run.resume_from}`} className="runs-ck-link">
                  {run.resume_from_name || run.resume_from.slice(0, 8)}
                </Link>
              </span>
            )}
            {run?.sweep_id && (
              <span className="run-registered">
                {t('detailSweep')}
                <Link to={`/compare?sweep=${run.sweep_id}`} className="runs-ck-link mono">
                  {run.sweep_id}
                </Link>
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isActive(run?.status) && (
            <LiveChip
              active
              paused={paused}
              lastSync={lastSync}
              onToggle={() => setPaused((p) => !p)}
              onRefresh={() => setNonce((n) => n + 1)}
            />
          )}
          {me?.role !== 'viewer' && run && isActive(run.status) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setDialog('cancel')}
              className="btn btn-warn"
            >
              {t('cancel')}
            </button>
          )}
          {me?.role !== 'viewer' && run?.registrable && run.status === 'succeeded' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRegErr('')
                setRegOpen(true)
              }}
              className="btn btn-primary"
            >
              {t('registerModel')}
            </button>
          )}
          {me?.role !== 'viewer' && run?.resumable && isTerminal(run.status) && (
            <Link to={`/new?resume=${run.id}`} className="btn btn-secondary">
              {t('resumeAction')}
            </Link>
          )}
          {me?.role !== 'viewer' && run && isTerminal(run.status) && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDialog('rerun')}
                className="btn btn-secondary"
              >
                {t('rerun')}
              </button>
              {canCleanup(run) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDialog('cleanup')}
                  className="btn btn-warn"
                >
                  {t('cleanupLeftover')}
                </button>
              )}
              {run.showcase_seed ? null : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDialog('delete')}
                  className="btn btn-ghost text-[var(--danger)]"
                >
                  {t('deleteRecord')}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <dl className="runs-spec">
        <div>
          <dt>{t('detailDuration')}</dt>
          <dd className="mono">{formatDuration(run?.duration_seconds)}</dd>
        </div>
        <div>
          <dt>{t('detailCreated')}</dt>
          <dd>{formatLocalDateTime(run?.created_at, lang)}</dd>
        </div>
        {run?.namespace ? (
          <div>
            <dt>{t('namespace')}</dt>
            <dd className="mono">{run.namespace}</dd>
          </div>
        ) : null}
        {run?.pod_phase && !run.simulated ? (
          <div>
            <dt>{t('phase')}</dt>
            <dd className="mono">{run.pod_phase}</dd>
          </div>
        ) : null}
        {run?.status_reason && run.status_reason !== run.pod_phase && !run.simulated ? (
          <div>
            <dt>{t('reason')}</dt>
            <dd className="mono">{run.status_reason}</dd>
          </div>
        ) : null}
        {exitCode != null ? (
          <div>
            <dt>{t('exitCode')}</dt>
            <dd className="mono">{exitCode}</dd>
          </div>
        ) : null}
        {run?.queue_position ? (
          <div>
            <dt>{t('status_queued')}</dt>
            <dd className="mono">
              {t('queuePosition').replace('{n}', String(run.queue_position))}
              {run.queue_reason && <> · {t(`queueReason_${run.queue_reason}`)}</>}
            </dd>
          </div>
        ) : null}
        {run?.status === 'queued' && run.not_before ? (
          <div>
            <dt>{t('newStartAt')}</dt>
            <dd className="mono">{formatLocalDateTime(run.not_before, lang)}</dd>
          </div>
        ) : null}
        {run?.priority ? (
          <div>
            <dt>{t('newPriority')}</dt>
            <dd className="sched-prio-tag" data-prio={run.priority}>
              {t(`prio_${run.priority}`)}
            </dd>
          </div>
        ) : null}
        {run && Object.keys(run.params || {}).length > 0 ? (
          <div className="runs-spec-wide">
            <dt>{t('detailParams')}</dt>
            <dd className="param-chips">
              {Object.entries(run.params || {}).map(([k, v]) => (
                <span key={k} className="param-chip mono">
                  <span>{fieldLabel(k)}</span>
                  <span>{String(v)}</span>
                </span>
              ))}
            </dd>
          </div>
        ) : null}
        {run && Object.keys(run.env || {}).length > 0 ? (
          <div className="runs-spec-wide">
            <dt>{t('detailEnv')}</dt>
            <dd className="param-chips">
              {Object.entries(run.env || {}).map(([k, v]) => (
                <span key={k} className="param-chip mono">
                  <span>{k}</span>
                  <span>{v}</span>
                </span>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>

      {msg && <p className="flash flash-ok">{msg}</p>}
      {err && (
        <p className={`flash ${isMissingCluster(err) ? 'flash-warn' : 'flash-err'}`}>
          {isMissingCluster(err) ? (
            <>
              {t('clusterMissing')}{' '}
              <Link to="/clusters">{t('goClusters')}</Link>
            </>
          ) : (
            err
          )}
        </p>
      )}
      {run?.error_message && (
        <p className="flash flash-err">{formatApiMessage(run.error_message, t)}</p>
      )}
      {run?.status === 'queued' && (
        <p className="flash flash-info">
          {run.queue_reason === 'scheduled'
            ? t('queuedHintScheduled')
            : run.queue_reason === 'user_active'
              ? t('queuedHintUserActive')
              : run.queue_reason === 'user_quota'
                ? t('queuedHintUserQuota')
                : t('queuedHint')}
        </p>
      )}
      {run?.status_message && !isTerminal(run.status) && run.status !== 'running' && run.status !== 'queued' && (
        <p className="flash">{formatApiMessage(run.status_message, t)}</p>
      )}
      {run?.status === 'pending' &&
        (run.gpu_count ?? 0) > 0 &&
        (run.events || []).some((ev) => /nvidia\.com\/gpu|Insufficient/i.test(ev)) && (
          <p className="flash flash-warn">{t('pendingGpu')}</p>
        )}

      {run?.kind === 'infer' && (
        <section className="panel panel-pad">
          <div className="panel-head">
            <h2 className="panel-title">{t('inferTitle')}</h2>
            {run.model_id && (
              <Link to={`/models/${run.model_id}`} className="panel-meta mono">
                {t('inferModel')} · {run.model_label || run.model_id.slice(0, 8)}
              </Link>
            )}
          </div>
          <div className="run-infer-grid">
            <dl className="run-infer-input">
              {run.batch_rows ? (
                <div>
                  <dt>{t('inferInput')}</dt>
                  <dd className="mono">{t('batchRows').replace('{n}', String(run.batch_rows))}</dd>
                </div>
              ) : (
                Object.entries(run.infer_input || {}).map(([k, v]) => (
                  <div key={k}>
                    <dt>{fieldLabel(k)}</dt>
                    <dd className="mono">{String(v)}</dd>
                  </div>
                ))
              )}
            </dl>
            <div>
              {run.prediction ? (
                <PredictionView prediction={run.prediction} runId={run.id} />
              ) : isActive(run.status) ? (
                <p className="panel-note">{t('inferWaiting')}</p>
              ) : (
                <p className="panel-note">{t('inferNoOutput')}</p>
              )}
            </div>
          </div>
        </section>
      )}

      <section className="panel panel-pad space-y-4">
        <div className="panel-head">
          <h2 className="panel-title">{t('metrics')}</h2>
          <span className="panel-meta">{t('chartHint')}</span>
        </div>

        {phase && isActive(run?.status) && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-xs font-medium">{t('trainProgress')}</span>
              <span className="mono text-xs text-[var(--muted)]">{phaseText}</span>
            </div>
            <div className="phase-bar">
              <i style={{ width: `${Math.round((phase.ratio ?? 0.04) * 100)}%` }} />
            </div>
          </div>
        )}

        {rail.length > 0 ? (
          <div className="metric-rail">
            {rail.map((cell) => {
              const seriesKey = (metrics?.chart_keys || []).find(
                (k) => k.toLowerCase() === cell.k.toLowerCase(),
              )
              const off = Boolean(seriesKey && trainHidden.has(seriesKey) && trainHidden.size > 0)
              const isolated =
                Boolean(seriesKey) &&
                trainHidden.size === (metrics?.chart_keys?.length || 0) - 1 &&
                seriesKey != null &&
                !trainHidden.has(seriesKey)
              if (seriesKey) {
                return (
                  <button
                    key={cell.k}
                    type="button"
                    className="metric-cell"
                    data-tone={cell.tone}
                    data-off={off ? 'true' : undefined}
                    data-on={isolated ? 'true' : undefined}
                    title={t('chartLegendHint')}
                    onClick={(e) =>
                      setTrainHidden(
                        nextLegendHidden(
                          metrics?.chart_keys || [],
                          trainHidden,
                          seriesKey,
                          e.metaKey || e.ctrlKey,
                        ),
                      )
                    }
                  >
                    <div className="metric-k">{cell.k}</div>
                    <div className="metric-v mono">{cell.v}</div>
                    {cell.sub ? <div className="metric-sub mono">{cell.sub}</div> : null}
                  </button>
                )
              }
              return (
                <div key={cell.k} className="metric-cell" data-tone={cell.tone}>
                  <div className="metric-k">{cell.k}</div>
                  <div className="metric-v mono">{cell.v}</div>
                  {cell.sub ? <div className="metric-sub mono">{cell.sub}</div> : null}
                </div>
              )
            })}
          </div>
        ) : run?.kind === 'infer' ? null : (
          <p className="chart-empty">{t('noMetrics')}</p>
        )}

        {charts.length > 0 && (
          <div className="chart-grid">
            {charts.map((c) => (
              <div
                key={c.id}
                className="chart-cell"
                data-span={c.id === 'train' && charts.length > 1 ? 'full' : undefined}
              >
                <div className="chart-cell-head">
                  <span className="chart-cell-title">{c.title}</span>
                  <span className="chart-cell-meta">{c.meta}</span>
                </div>
                <MetricsChart
                  series={c.series}
                  keys={c.keys}
                  xKey={c.xKey}
                  xLabel={c.xLabel}
                  wallOrigin={c.wallOrigin}
                  hidden={c.id === 'train' ? trainHidden : undefined}
                  onHiddenChange={c.id === 'train' ? setTrainHidden : undefined}
                />
              </div>
            ))}
          </div>
        )}

        {resourceNote && <p className="panel-note">{resourceNote}</p>}

        {!!metrics?.resource?.nodes?.length &&
          !metrics.resource.frozen &&
          !isTerminal(run?.status) && (
            <div className="space-y-1.5">
              <div className="metric-k">{t('clusterNodes')}</div>
              <div className="hint-row">
                {metrics.resource.nodes.map((n) => (
                  <span key={n.name} className="hint-chip">
                    {n.name} · CPU {n.cpu || '—'} · Mem {n.memory || '—'}
                  </span>
                ))}
              </div>
            </div>
          )}
      </section>

      <section className="panel panel-pad">
        <h2 className="mb-3 font-semibold">{t('artifacts')}</h2>
        {(metrics?.artifacts || []).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            {metrics?.harvest?.status === 'skipped'
              ? t('artifactsSkipped')
              : isActive(run?.status) || metrics?.harvest?.status === 'pending'
                ? t('artifactsPending')
                : t('noArtifacts')}
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {(metrics?.artifacts || []).map((a) => (
              <li
                key={a.path}
                className="flex items-center justify-between gap-3 border-b border-[var(--line)]/50 py-1.5"
              >
                <span className="mono text-[var(--text)]">{a.path}</span>
                <div className="flex items-center gap-3 text-[var(--muted)]">
                  <span className="mono text-xs">{a.size} B</span>
                  {id && (
                    <button
                      type="button"
                      className="text-xs text-[var(--accent)] hover:underline"
                      onClick={() => {
                        downloadFile(api.artifactUrl(id, a.path), a.path.split('/').pop() || 'artifact').catch(
                          () => {},
                        )
                      }}
                    >
                      {t('download')}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="panel panel-pad text-sm">
          <h2 className="font-semibold">{t('spec')}</h2>
          <dl className="spec-grid mt-3 text-[var(--muted)]">
            <div>
              <dt>Template</dt>
              <dd className="text-[var(--text)]">{run?.template}</dd>
            </div>
            <div>
              <dt>Image</dt>
              <dd className="mono text-[var(--text)]">{run?.image}</dd>
            </div>
            <div>
              <dt>Resources</dt>
              <dd className="mono text-[var(--text)]">
                {run?.cpu} / {run?.memory}
                {(run?.gpu_count ?? 0) > 0 ? ` · GPU×${run?.gpu_count}` : ''}
              </dd>
            </div>
            <div>
              <dt>Timeout</dt>
              <dd className="mono text-[var(--text)]">{run?.timeout_seconds}s</dd>
            </div>
            <div>
              <dt>Pod</dt>
              <dd className="mono text-[var(--text)]">{run?.pod_name || '—'}</dd>
            </div>
          </dl>
        </div>
        <div className="panel panel-pad text-sm">
          <h2 className="font-semibold">{t('events')}</h2>
          <ul className="mono mt-3 max-h-40 space-y-1 overflow-auto text-xs text-[var(--muted)]">
            {(run?.events || []).length === 0 && <li>{t('none')}</li>}
            {(run?.events || []).map((ev, i) => (
              <li key={i}>{ev}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="panel panel-pad">
        <div className="log-head">
          <div>
            <h2 className="font-semibold">
              {t('logs')} {pod ? `· ${pod}` : ''}
            </h2>
            <p className="log-meta">
              {t('codeLines').replace(
                '{n}',
                String(logs ? logs.replace(/\n$/, '').split('\n').length : 0),
              )}
              <span className="log-meta-sep">·</span>
              {t('logsKeepHint')}
            </p>
          </div>
          <div className="log-acts">
            <label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />
              {t('logsFollow')}
            </label>
            <button
              type="button"
              className="code-act"
              disabled={!logs}
              onClick={async () => {
                await navigator.clipboard.writeText(logs)
                setLogCopied(true)
                window.setTimeout(() => setLogCopied(false), 1600)
              }}
            >
              {logCopied ? t('copied') : t('copy')}
            </button>
            <button
              type="button"
              className="code-act"
              disabled={!logs}
              onClick={() => {
                const url = URL.createObjectURL(new Blob([logs], { type: 'text/plain' }))
                const link = document.createElement('a')
                link.href = url
                link.download = `${pod || 'trainer'}.log`
                link.click()
                URL.revokeObjectURL(url)
              }}
            >
              {t('download')}
            </button>
          </div>
        </div>
        <pre ref={logRef} className="log-pane mono">
          {logs || t('none')}
        </pre>
      </section>

      {(run?.script || run?.job_yaml) && (
        <section className="panel panel-pad space-y-3">
          <div className="panel-head" style={{ marginBottom: 0 }}>
            <h2 className="panel-title">{t('sourceTitle')}</h2>
            <span className="panel-meta">{t('sourceHint')}</span>
          </div>
          {run.script && (
            <CodeBlock
              text={run.script}
              filename="train.py"
              language="python"
              maxLines={28}
            />
          )}
          {run.job_yaml && (
            <details className="yaml-details">
              <summary>{t('yamlSummary')}</summary>
              <div className="mt-2">
                <CodeBlock
                  text={run.job_yaml}
                  filename={`${run.job_name || 'job'}.yaml`}
                  language="yaml"
                />
              </div>
            </details>
          )}
        </section>
      )}

      <ConfirmDialog
        open={dialog === 'cancel'}
        tone="warn"
        title={t('cancelTitle')}
        description={`${t('cancelConfirm')}\n\n${run?.name || ''} · ${run?.job_name || ''}`}
        confirmLabel={busy ? t('cancelling') : t('confirmOk')}
        cancelLabel={t('confirmCancel')}
        busy={busy}
        onClose={() => !busy && setDialog(null)}
        onConfirm={confirmAction}
      />
      <ConfirmDialog
        open={dialog === 'cleanup'}
        tone="warn"
        title={t('cleanupTitle')}
        description={`${t('cleanupConfirm')}\n\n${run?.name || ''} · ${run?.job_name || ''}`}
        confirmLabel={busy ? t('cleaningLeftover') : t('confirmCleanup')}
        cancelLabel={t('confirmCancel')}
        busy={busy}
        onClose={() => !busy && setDialog(null)}
        onConfirm={confirmAction}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        tone="danger"
        title={t('deleteTitle')}
        description={`${t('deleteConfirm')}\n\n${run?.name || ''} · ${run?.status || ''}`}
        requireText={run?.name}
        requireHint={t('deleteTypeHint')}
        confirmLabel={busy ? t('deleting') : t('confirmDelete')}
        cancelLabel={t('confirmCancel')}
        busy={busy}
        onClose={() => !busy && setDialog(null)}
        onConfirm={confirmAction}
      />
      <ConfirmDialog
        open={dialog === 'rerun'}
        tone="warn"
        title={t('rerunTitle')}
        description={`${t('rerunConfirm')}\n\n${run?.name || ''}`}
        confirmLabel={busy ? t('rerunning') : t('confirmRerun')}
        cancelLabel={t('confirmCancel')}
        busy={busy}
        onClose={() => !busy && setDialog(null)}
        onConfirm={confirmAction}
      />
      <RegisterModelDialog
        open={regOpen}
        initialName={suggestModelName(run?.name || '')}
        busy={regBusy}
        error={regErr}
        onClose={() => !regBusy && setRegOpen(false)}
        onSubmit={async (name) => {
          if (!id) return
          setRegBusy(true)
          setRegErr('')
          try {
            const m = await api.registerModel(id, name)
            setRegOpen(false)
            nav(`/models/${m.id}`)
          } catch (e) {
            setRegErr(e instanceof Error ? e.message : String(e))
          } finally {
            setRegBusy(false)
          }
        }}
      />
    </div>
  )
}
