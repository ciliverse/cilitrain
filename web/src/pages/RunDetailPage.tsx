import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, type MetricsView, type Run } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'
import MetricsChart from '../components/MetricsChart'
import StatusBadge from '../components/StatusBadge'
import { formatApiMessage, formatDuration, formatLocalDateTime, useI18n } from '../i18n'
import '../styles/runs.css'

function isActive(status?: string) {
  return status === 'pending' || status === 'running'
}

function isTerminal(status?: string) {
  return status === 'succeeded' || status === 'failed' || status === 'timeout' || status === 'cancelled'
}

function isMissingCluster(msg: string) {
  return /cluster not found/i.test(msg)
}

type Dialog = 'cancel' | 'delete' | 'rerun' | null

export default function RunDetailPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const { t, statusLabel, lang } = useI18n()
  const [run, setRun] = useState<Run | null>(null)
  const [logs, setLogs] = useState('')
  const [pod, setPod] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [copied, setCopied] = useState(false)
  const [metrics, setMetrics] = useState<MetricsView | null>(null)

  async function load() {
    if (!id) return
    try {
      const r = await api.run(id)
      setRun(r)
      try {
        const [l, m] = await Promise.all([api.logs(id), api.metrics(id)])
        setLogs(l.logs)
        setPod(l.pod_name || r.pod_name || null)
        setMetrics(m)
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
          setLogs(l.logs)
          setPod(l.pod_name || r.pod_name || null)
          setMetrics(m)
          setErr('')
        } catch (side) {
          if (!cancelled) setErr(side instanceof Error ? side.message : String(side))
        }
        if (!isTerminal(r.status)) {
          timer = window.setTimeout(tick, 3000)
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
        timer = window.setTimeout(tick, 5000)
      }
    }

    tick()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [id])

  async function confirmAction() {
    if (!id || !run || !dialog) return
    setBusy(true)
    try {
      if (dialog === 'cancel') {
        const r = await api.cancelRun(id)
        setRun(r)
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

  async function copyYaml() {
    if (!run?.job_yaml) return
    await navigator.clipboard.writeText(run.job_yaml)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
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

      <div className="page-head">
        <div>
          <h1 className="page-title">{run?.name || 'Run'}</h1>
          {run?.job_name ? <p className="runs-job mono">{run.job_name}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {run && isActive(run.status) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setDialog('cancel')}
              className="btn btn-warn"
            >
              {t('cancel')}
            </button>
          )}
          {run && isTerminal(run.status) && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDialog('rerun')}
                className="btn btn-secondary"
              >
                {t('rerun')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDialog('delete')}
                className="btn btn-ghost text-[var(--danger)]"
              >
                {t('deleteRecord')}
              </button>
            </>
          )}
        </div>
      </div>

      <dl className="runs-spec">
        <div>
          <dt>{t('detailStatus')}</dt>
          <dd>{run && <StatusBadge status={run.status} label={statusLabel(run.status)} />}</dd>
        </div>
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
        {run?.pod_phase ? (
          <div>
            <dt>{t('phase')}</dt>
            <dd className="mono">{run.pod_phase}</dd>
          </div>
        ) : null}
        {run?.status_reason ? (
          <div>
            <dt>{t('reason')}</dt>
            <dd className="mono">{run.status_reason}</dd>
          </div>
        ) : null}
      </dl>

      {!clusterGone && (
      <section className="panel panel-pad">
        <h2 className="text-sm font-semibold">{t('cilikubePanelTitle')}</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">{t('cilikubePanelDesc')}</p>
        {run?.cilikube_links?.configured ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {run.cilikube_links.job && (
              <a href={run.cilikube_links.job} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
                {t('ckLinkJob')}
              </a>
            )}
            {run.cilikube_links.pod && (
              <a href={run.cilikube_links.pod} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                {t('ckLinkPod')}
              </a>
            )}
            {run.cilikube_links.events && (
              <a href={run.cilikube_links.events} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                {t('ckLinkEvents')}
              </a>
            )}
            {run.cilikube_links.pvc && (
              <a href={run.cilikube_links.pvc} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                {t('ckLinkPvc')}
              </a>
            )}
            {run.cilikube_links.console && (
              <a href={run.cilikube_links.console} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                {t('ckLinkConsole')}
              </a>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm text-[var(--warn)]">
            {t('cilikubeNotConfigured')}{' '}
            <Link to="/clusters#cilikube" className="underline hover:text-[var(--accent)]">
              {t('goClusters')}
            </Link>
          </p>
        )}
      </section>
      )}

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
      {run?.status_message && (
        <p className="flash">{formatApiMessage(run.status_message, t)}</p>
      )}

      <section className="panel panel-pad">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h2 className="font-semibold">{t('metrics')}</h2>
          <span className="text-[11px] text-[var(--muted)]">{t('chartHint')}</span>
        </div>
        {metrics?.resource && (
          <div className="mb-4 space-y-3">
            {metrics.resource.available && metrics.resource.cpu ? (
              <div className="flex flex-wrap gap-3">
                <div className="rounded border border-[var(--warn)]/35 bg-[var(--warn)]/10 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                    {t('resourceLive')} · CPU
                  </div>
                  <div className="mono text-lg font-semibold text-[var(--warn)]">
                    {metrics.resource.cpu}
                  </div>
                  <div className="mono text-[10px] text-[var(--muted)]">
                    {metrics.resource.pod_name}
                  </div>
                </div>
                <div className="rounded border border-[var(--warn)]/35 bg-[var(--warn)]/10 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                    {t('resourceLive')} · Mem
                  </div>
                  <div className="mono text-lg font-semibold text-[var(--warn)]">
                    {metrics.resource.memory}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-[var(--muted)]">
                {metrics.resource.message === 'resource_history_frozen' || metrics.resource.frozen
                  ? t('resourceFinishedHist')
                  : !metrics.resource.available && !(metrics.resource.series?.length)
                    ? t('resourceUnavailable')
                    : metrics.resource.pending || metrics.resource.message === 'waiting_for_pod_scrape'
                      ? t('resourcePending')
                      : metrics.resource.message === 'pod_finished_no_live_metrics'
                        ? t('resourceFinished')
                        : t('resourceIdle')}
              </p>
            )}
            {!!metrics.resource.series?.length && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <h3 className="text-sm font-medium">{t('resourceChart')}</h3>
                  <span className="text-[11px] text-[var(--muted)]">
                    {metrics.resource.frozen
                      ? t('resourceFrozen')
                      : metrics.resource.series_source === 'prometheus'
                        ? t('resourceFromProm')
                        : metrics.resource.series_source === 'metrics-server'
                          ? t('resourceFromMs')
                          : t('resourceChartHint')}
                    {' · '}
                    {t('resourceHoverHint')}
                  </span>
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  {metrics.resource.series.some((p) => Number.isFinite(Number(p.cpu_m))) && (
                    <MetricsChart
                      series={metrics.resource.series}
                      keys={['cpu_m']}
                      xKey="t"
                      xLabel={t('timeAxis')}
                      wallOrigin={run?.created_at}
                    />
                  )}
                  {metrics.resource.series.some((p) => Number.isFinite(Number(p.memory_mi))) && (
                    <MetricsChart
                      series={metrics.resource.series}
                      keys={['memory_mi']}
                      xKey="t"
                      xLabel={t('timeAxis')}
                      wallOrigin={run?.created_at}
                    />
                  )}
                </div>
              </div>
            )}
            {!!metrics.resource.nodes?.length && !metrics.resource.frozen && !isTerminal(run?.status) && (
              <div>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-[var(--muted)]">
                  {t('clusterNodes')}
                </div>
                <div className="flex flex-wrap gap-2">
                  {metrics.resource.nodes.map((n) => (
                    <div
                      key={n.name}
                      className="rounded border border-[var(--line)] bg-[var(--bg)] px-2.5 py-1.5 text-xs"
                    >
                      <div className="mono text-[var(--text)]">{n.name}</div>
                      <div className="mono text-[var(--muted)]">
                        CPU {n.cpu || '—'} · Mem {n.memory || '—'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {metrics && Object.keys(metrics.summary || {}).length > 0 ? (
          <div className="mb-4 flex flex-wrap gap-3">
            {Object.entries(metrics.summary).map(([k, v]) => (
              <div
                key={k}
                className="min-w-[7rem] rounded border border-[var(--accent-dim)] bg-[var(--accent)]/10 px-3 py-2"
              >
                <div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{k}</div>
                <div className="mono text-xl font-semibold text-[var(--accent)]">
                  {typeof v === 'number'
                    ? Number.isInteger(v) || ['epochs', 'epoch', 'rows'].includes(k)
                      ? String(Math.round(v))
                      : v.toFixed(4)
                    : String(v)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mb-3 text-sm text-[var(--muted)]">{t('noMetrics')}</p>
        )}
        {metrics && metrics.series?.length > 0 && metrics.chart_keys?.length > 0 && (
          <MetricsChart
            series={metrics.series}
            keys={metrics.chart_keys}
            xKey={metrics.x_key === 'index' ? 'index' : 'epoch'}
            xLabel={t('epochAxis')}
          />
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
                      onClick={async () => {
                        const { getToken } = await import('../api')
                        const res = await fetch(api.artifactUrl(id, a.path), {
                          headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
                        })
                        if (!res.ok) return
                        const blob = await res.blob()
                        const url = URL.createObjectURL(blob)
                        const link = document.createElement('a')
                        link.href = url
                        link.download = a.path.split('/').pop() || 'artifact'
                        link.click()
                        URL.revokeObjectURL(url)
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
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">
            {t('logs')} {pod ? `· ${pod}` : ''}
          </h2>
        </div>
        <pre className="log-pane mono">{logs || t('none')}</pre>
      </section>

      {run?.job_yaml && (
        <section className="panel panel-pad">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="font-semibold">{t('jobYaml')}</h2>
            <button
              type="button"
              onClick={copyYaml}
              className={`btn btn-ghost btn-sm runs-copy${copied ? ' is-copied' : ''}`}
            >
              {copied ? t('detailYamlCopied') : t('copyYaml')}
            </button>
          </div>
          <pre className="log-pane mono mt-3 max-h-80">{run.job_yaml}</pre>
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
    </div>
  )
}
