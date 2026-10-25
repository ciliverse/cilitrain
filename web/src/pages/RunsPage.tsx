import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, type AuthUser, type Run, type RunTrend } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'
import ExtIcon from '../components/ExtIcon'
import LiveChip from '../components/LiveChip'
import { predictionSummary } from '../components/PredictionView'
import Sparkline from '../components/Sparkline'
import StatusBadge from '../components/StatusBadge'
import { formatDuration, formatLocalDateTime, useI18n } from '../i18n'
import '../styles/runs.css'
import '../styles/models.css'
import '../styles/training.css'

function isActive(status: string) {
  return status === 'queued' || status === 'pending' || status === 'running'
}

function isTerminal(status: string) {
  return status === 'succeeded' || status === 'failed' || status === 'timeout' || status === 'cancelled'
}

function isFailed(status: string) {
  return status === 'failed' || status === 'timeout'
}

type Filter = 'all' | 'active' | 'done' | 'succeeded' | 'failed'
type Dialog =
  | { kind: 'cancel'; run: Run }
  | { kind: 'cleanup'; run: Run }
  | { kind: 'delete'; run: Run }
  | { kind: 'rerun'; run: Run }
  | null

function canCleanup(run: Run) {
  return isFailed(run.status) && Boolean(run.job_name) && !run.simulated
}

const SKEL_ROWS = [0, 1, 2, 3, 4, 5] as const

/** Second status line only when it says something the badge does not. */
function runNote(r: Run): string {
  if (isFailed(r.status) && r.error_message) return r.error_message.replace(/\s*\(.*\)\s*$/, '')
  if (r.simulated) return ''
  const reason = r.status_reason && r.status_reason !== r.pod_phase ? r.status_reason : ''
  return reason
}

function formatTrend(v: number): string {
  const a = Math.abs(v)
  if (a >= 100) return v.toFixed(0)
  if (a >= 1) return v.toFixed(2)
  return v.toFixed(4)
}
export default function RunsPage() {
  const { t, statusLabel, lang } = useI18n()
  const nav = useNavigate()
  const [runs, setRuns] = useState<Run[]>([])
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [params, setParams] = useSearchParams()
  const kind: 'train' | 'infer' = params.get('kind') === 'infer' ? 'infer' : 'train'
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [lastSync, setLastSync] = useState<number | null>(null)
  const [paused, setPaused] = useState(false)
  const [me, setMe] = useState<AuthUser | null>(null)

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null))
  }, [])

  async function load() {
    try {
      setRuns(await api.runs())
      setLastSync(Date.now())
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => {
    load()
    if (paused) return
    const id = window.setInterval(load, 4000)
    return () => window.clearInterval(id)
  }, [paused])

  const [trends, setTrends] = useState<Record<string, RunTrend>>({})
  const trendSync = useRef({ key: '', at: 0 })
  const kindCounts = useMemo(() => {
    let infer = 0
    for (const r of runs) if (r.kind === 'infer') infer += 1
    return { train: runs.length - infer, infer }
  }, [runs])

  const ofKind = useMemo(
    () => runs.filter((r) => (r.kind === 'infer' ? 'infer' : 'train') === kind),
    [runs, kind],
  )

  useEffect(() => {
    const trainRuns = runs.filter((r) => r.kind !== 'infer')
    if (!trainRuns.length) return
    const key = trainRuns.map((r) => r.id).join(',')
    const anyActive = trainRuns.some((r) => isActive(r.status))
    const now = Date.now()
    const stale = anyActive && now - trendSync.current.at > 12000
    if (key === trendSync.current.key && !stale) return
    trendSync.current = { key, at: now }
    api
      .runTrends(trainRuns.map((r) => r.id))
      .then((out) => setTrends(out.trends))
      .catch(() => {})
  }, [runs])

  function selectKind(next: 'train' | 'infer') {
    setFilter('all')
    setParams(next === 'infer' ? { kind: 'infer' } : {}, { replace: true })
  }

  const stats = useMemo(() => {
    let active = 0
    let succeeded = 0
    let failed = 0
    for (const r of ofKind) {
      if (isActive(r.status)) active += 1
      else if (r.status === 'succeeded') succeeded += 1
      else if (isFailed(r.status)) failed += 1
    }
    return { all: ofKind.length, active, succeeded, failed }
  }, [ofKind])

  const visible = useMemo(() => {
    const qq = q.trim().toLowerCase()
    return ofKind.filter((r) => {
      if (filter === 'active' && !isActive(r.status)) return false
      if (filter === 'done' && !isTerminal(r.status)) return false
      if (filter === 'succeeded' && r.status !== 'succeeded') return false
      if (filter === 'failed' && !isFailed(r.status)) return false
      if (!qq) return true
      return (
        r.name.toLowerCase().includes(qq) ||
        (r.job_name || '').toLowerCase().includes(qq) ||
        r.template.toLowerCase().includes(qq) ||
        (r.model_label || '').toLowerCase().includes(qq) ||
        (r.sweep_id || '').toLowerCase().includes(qq) ||
        r.namespace.toLowerCase().includes(qq)
      )
    })
  }, [ofKind, filter, q])

  function selectStat(next: Filter) {
    setFilter((cur) => (cur === next ? 'all' : next))
  }

  function clearFilters() {
    setFilter('all')
    setQ('')
  }

  async function confirmAction() {
    if (!dialog) return
    const { kind, run } = dialog
    setBusyId(run.id)
    try {
      if (kind === 'cancel') {
        await api.cancelRun(run.id)
        setDialog(null)
        await load()
      } else if (kind === 'cleanup') {
        await api.cleanupRun(run.id)
        setMsg(t('cleanupDone'))
        setDialog(null)
        await load()
      } else if (kind === 'delete') {
        await api.deleteRun(run.id)
        setDialog(null)
        await load()
      } else if (kind === 'rerun') {
        const created = await api.rerunRun(run.id)
        setDialog(null)
        nav(`/runs/${created.id}`)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setDialog(null)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="runs-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('runsTitle')}</h1>
          <p className="page-desc">{t('runsDesc')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LiveChip
            active
            paused={paused}
            lastSync={lastSync}
            onToggle={() => setPaused((p) => !p)}
            onRefresh={load}
          />
          <Link to="/new" className="btn btn-primary">
            {t('newRunBtn')}
          </Link>
        </div>
      </div>

      <div className="runs-bar">
        {loaded && (
          <div className="runs-kind" role="group" aria-label={t('kindTrain')}>
            {(['train', 'infer'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => selectKind(k)}>
                {k === 'train' ? t('kindTrain') : t('kindInfer')}
                <span className="n">{kindCounts[k]}</span>
              </button>
            ))}
          </div>
        )}
        {loaded && (
          <div className="runs-filters" role="toolbar" aria-label={t('runsTitle')}>
            {(
              [
                { f: 'all', n: stats.all, k: t('runsStatAll'), tone: undefined },
                { f: 'active', n: stats.active, k: t('runsStatActive'), tone: 'live' },
                { f: 'succeeded', n: stats.succeeded, k: t('runsStatSucceeded'), tone: 'ok' },
                { f: 'failed', n: stats.failed, k: t('runsStatFailed'), tone: 'fail' },
              ] as const
            ).map((it) => (
              <button
                key={it.f}
                type="button"
                className="runs-filter"
                data-tone={it.tone}
                data-hot={it.n > 0 ? 'true' : 'false'}
                aria-pressed={filter === it.f}
                onClick={() => (it.f === 'all' ? setFilter('all') : selectStat(it.f))}
              >
                <span className="k">{it.k}</span>
                <span className="n">{it.n}</span>
              </button>
            ))}
          </div>
        )}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          className="field runs-search"
        />
      </div>

      {msg && <p className="flash flash-ok mb-4">{msg}</p>}
      {err && <p className="flash flash-err mb-4">{err}</p>}

      {!loaded ? (
        <div className="data-table-wrap" aria-busy="true" aria-label={t('runsLoading')}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('colName')}</th>
                <th>{t('colStatus')}</th>
                <th>{t('colTrend')}</th>
                <th>{t('colTemplate')}</th>
                <th>{t('colDuration')}</th>
                <th>{t('colCreated')}</th>
                <th className="runs-th-acts">{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {SKEL_ROWS.map((i) => (
                <tr key={i}>
                  <td>
                    <span className="runs-skel runs-skel-name" />
                  </td>
                  <td>
                    <span className="runs-skel runs-skel-sm" />
                  </td>
                  <td>
                    <span className="runs-skel runs-skel-md" />
                  </td>
                  <td>
                    <span className="runs-skel runs-skel-sm" />
                  </td>
                  <td>
                    <span className="runs-skel runs-skel-sm" />
                  </td>
                  <td>
                    <span className="runs-skel runs-skel-lg" />
                  </td>
                  <td>
                    <span className="runs-skel runs-skel-md" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : kind === 'infer' && ofKind.length === 0 ? (
        <div className="empty-state">
          <div>
            <p className="empty-title">{t('inferHistoryEmpty')}</p>
            <p className="runs-empty-desc">{t('modelsDesc')}</p>
          </div>
          <div className="empty-actions">
            <Link to="/models" className="btn btn-primary">
              {t('navModels')}
            </Link>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <div>
            <p className="empty-title">
              {runs.length === 0 ? t('runsEmptyTitle') : t('runsEmptyFilteredTitle')}
            </p>
            <p className="runs-empty-desc">
              {runs.length === 0 ? t('runsEmptyDesc') : t('runsEmptyFilteredDesc')}
            </p>
          </div>
          {runs.length === 0 ? (
            <div className="empty-actions">
              <Link to="/clusters" className="btn btn-secondary">
                {t('goClusters')}
              </Link>
              <Link to="/new" className="btn btn-primary">
                {t('newRunBtn')}
              </Link>
            </div>
          ) : (
            <div className="empty-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                {t('runsClearFilters')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('colName')}</th>
                <th>{t('colStatus')}</th>
                <th>{kind === 'infer' ? t('colResult') : t('colTrend')}</th>
                <th>{kind === 'infer' ? t('colModel') : t('colTemplate')}</th>
                <th>{t('colDuration')}</th>
                <th>{t('colCreated')}</th>
                <th className="runs-th-acts">{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const trend = trends[r.id]
                const note = runNote(r)
                return (
                <tr
                  key={r.id}
                  className="data-row"
                  data-live={isActive(r.status) ? 'true' : undefined}
                  onClick={() => nav(`/runs/${r.id}`)}
                >
                  <td>
                    <Link to={`/runs/${r.id}`} className="runs-name">
                      {r.name}
                    </Link>
                    {r.sweep_id && (
                      <Link
                        to={`/compare?sweep=${r.sweep_id}`}
                        className="sweep-badge mono"
                        title={t('sweepCompare')}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.sweep_id}
                      </Link>
                    )}
                    <div className="runs-sub mono" title={r.job_name || undefined}>
                      {r.job_name}
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={r.status} label={statusLabel(r.status)} />
                    {r.queue_position ? (
                      <span className="queue-pos mono">
                        {t('queuePosition').replace('{n}', String(r.queue_position))}
                        {r.queue_reason && r.queue_reason !== 'namespace' && (
                          <> · {t(`queueReason_${r.queue_reason}`)}</>
                        )}
                      </span>
                    ) : r.queue_reason === 'scheduled' && r.not_before ? (
                      <span className="queue-pos mono">
                        {t('schedStartsAt').replace('{t}', formatLocalDateTime(r.not_before, lang))}
                      </span>
                    ) : null}
                    {note && (
                      <div className="runs-sub runs-note" title={note}>
                        {note}
                      </div>
                    )}
                  </td>
                  <td>
                    {r.kind === 'infer' ? (
                      r.prediction ? (
                        <span className="runs-result" title={predictionSummary(r.prediction)}>
                          {predictionSummary(r.prediction)}
                        </span>
                      ) : (
                        <span className="runs-sub">—</span>
                      )
                    ) : trend ? (
                      <div className="runs-trend" title={`${trend.key} ${trend.last}`}>
                        <Sparkline points={trend.points} live={isActive(r.status)} />
                        <span className="runs-trend-v mono">
                          <span className="runs-trend-k">{trend.key}</span>
                          {formatTrend(trend.last)}
                        </span>
                      </div>
                    ) : (
                      <span className="runs-sub">—</span>
                    )}
                  </td>
                  <td>
                    {r.kind === 'infer' && r.model_id ? (
                      <Link
                        to={`/models/${r.model_id}`}
                        className="mono runs-tmpl runs-model-link"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.model_label || r.template}
                      </Link>
                    ) : (
                      <div className="mono runs-tmpl">{r.template}</div>
                    )}
                    <div className="runs-sub mono">{r.namespace}</div>
                  </td>
                  <td className="mono runs-muted">{formatDuration(r.duration_seconds)}</td>
                  <td className="runs-muted">{formatLocalDateTime(r.created_at, lang)}</td>
                  <td className="runs-td-acts" onClick={(e) => e.stopPropagation()}>
                    <div className="runs-acts">
                      {me?.role !== 'viewer' && isActive(r.status) && (
                        <button
                          type="button"
                          disabled={busyId === r.id}
                          onClick={() => setDialog({ kind: 'cancel', run: r })}
                          className="runs-act runs-act-warn"
                        >
                          {t('cancel')}
                        </button>
                      )}
                      {me?.role !== 'viewer' && isTerminal(r.status) && (
                        <>
                          <button
                            type="button"
                            disabled={busyId === r.id}
                            onClick={() => setDialog({ kind: 'rerun', run: r })}
                            className="runs-act runs-act-primary"
                          >
                            {t('rerun')}
                          </button>
                          {canCleanup(r) && (
                            <button
                              type="button"
                              disabled={busyId === r.id}
                              onClick={() => setDialog({ kind: 'cleanup', run: r })}
                              className="runs-act runs-act-warn"
                            >
                              {t('cleanupLeftover')}
                            </button>
                          )}
                          {r.showcase_seed ? null : (
                            <button
                              type="button"
                              disabled={busyId === r.id}
                              onClick={() => setDialog({ kind: 'delete', run: r })}
                              className="runs-act runs-act-danger"
                            >
                              {t('deleteRecord')}
                            </button>
                          )}
                        </>
                      )}
                      {r.cilikube_links?.configured &&
                      (r.cilikube_links.job || r.cilikube_links.console) ? (
                        <a
                          href={r.cilikube_links.job || r.cilikube_links.console || undefined}
                          target="_blank"
                          rel="noreferrer"
                          className="runs-act runs-act-ext"
                          title={t('openCilikube')}
                        >
                          CiliKube
                          <ExtIcon />
                        </a>
                      ) : (
                        <Link to="/clusters#cilikube" className="runs-act" title={t('cilikubeNotConfigured')}>
                          CiliKube
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={dialog?.kind === 'cancel'}
        tone="warn"
        title={t('cancelTitle')}
        description={
          dialog?.kind === 'cancel'
            ? `${t('cancelConfirm')}\n\n${dialog.run.name} · ${dialog.run.job_name || ''}`
            : t('cancelConfirm')
        }
        confirmLabel={busyId ? t('cancelling') : t('confirmOk')}
        cancelLabel={t('confirmCancel')}
        busy={busyId !== null}
        onClose={() => !busyId && setDialog(null)}
        onConfirm={confirmAction}
      />
      <ConfirmDialog
        open={dialog?.kind === 'cleanup'}
        tone="warn"
        title={t('cleanupTitle')}
        description={
          dialog?.kind === 'cleanup'
            ? `${t('cleanupConfirm')}\n\n${dialog.run.name} · ${dialog.run.job_name || ''}`
            : t('cleanupConfirm')
        }
        confirmLabel={busyId ? t('cleaningLeftover') : t('confirmCleanup')}
        cancelLabel={t('confirmCancel')}
        busy={busyId !== null}
        onClose={() => !busyId && setDialog(null)}
        onConfirm={confirmAction}
      />
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        tone="danger"
        title={t('deleteTitle')}
        description={
          dialog?.kind === 'delete'
            ? `${t('deleteConfirm')}\n\n${dialog.run.name} · ${dialog.run.status}`
            : t('deleteConfirm')
        }
        requireText={dialog?.kind === 'delete' ? dialog.run.name : undefined}
        requireHint={t('deleteTypeHint')}
        confirmLabel={busyId ? t('deleting') : t('confirmDelete')}
        cancelLabel={t('confirmCancel')}
        busy={busyId !== null}
        onClose={() => !busyId && setDialog(null)}
        onConfirm={confirmAction}
      />
      <ConfirmDialog
        open={dialog?.kind === 'rerun'}
        tone="warn"
        title={t('rerunTitle')}
        description={
          dialog?.kind === 'rerun' ? `${t('rerunConfirm')}\n\n${dialog.run.name}` : t('rerunConfirm')
        }
        confirmLabel={busyId ? t('rerunning') : t('confirmRerun')}
        cancelLabel={t('confirmCancel')}
        busy={busyId !== null}
        onClose={() => !busyId && setDialog(null)}
        onConfirm={confirmAction}
      />
    </div>
  )
}
