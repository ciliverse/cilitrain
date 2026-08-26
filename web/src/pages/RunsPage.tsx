import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type Run } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'
import StatusBadge from '../components/StatusBadge'
import { formatDuration, formatLocalDateTime, useI18n } from '../i18n'
import '../styles/runs.css'

function isActive(status: string) {
  return status === 'pending' || status === 'running'
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
  | { kind: 'delete'; run: Run }
  | { kind: 'rerun'; run: Run }
  | null

const SKEL_ROWS = [0, 1, 2, 3, 4, 5] as const

export default function RunsPage() {
  const { t, statusLabel, lang } = useI18n()
  const nav = useNavigate()
  const [runs, setRuns] = useState<Run[]>([])
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)

  async function load() {
    try {
      setRuns(await api.runs())
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => {
    load()
    const id = window.setInterval(load, 4000)
    return () => window.clearInterval(id)
  }, [])

  const stats = useMemo(() => {
    let active = 0
    let succeeded = 0
    let failed = 0
    for (const r of runs) {
      if (isActive(r.status)) active += 1
      else if (r.status === 'succeeded') succeeded += 1
      else if (isFailed(r.status)) failed += 1
    }
    return { all: runs.length, active, succeeded, failed }
  }, [runs])

  const visible = useMemo(() => {
    const qq = q.trim().toLowerCase()
    return runs.filter((r) => {
      if (filter === 'active' && !isActive(r.status)) return false
      if (filter === 'done' && !isTerminal(r.status)) return false
      if (filter === 'succeeded' && r.status !== 'succeeded') return false
      if (filter === 'failed' && !isFailed(r.status)) return false
      if (!qq) return true
      return (
        r.name.toLowerCase().includes(qq) ||
        (r.job_name || '').toLowerCase().includes(qq) ||
        r.template.toLowerCase().includes(qq) ||
        r.namespace.toLowerCase().includes(qq)
      )
    })
  }, [runs, filter, q])

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
        <Link to="/new" className="btn btn-primary">
          {t('newRunBtn')}
        </Link>
      </div>

      {loaded && (
        <div className="stat-strip" role="toolbar" aria-label={t('runsTitle')}>
          <button
            type="button"
            className="stat-chip"
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            <span className="n">{stats.all}</span>
            <span className="k">{t('runsStatAll')}</span>
          </button>
          <button
            type="button"
            className="stat-chip"
            data-tone="live"
            data-hot={stats.active > 0 ? 'true' : 'false'}
            aria-pressed={filter === 'active'}
            onClick={() => selectStat('active')}
          >
            <span className="n">{stats.active}</span>
            <span className="k">{t('runsStatActive')}</span>
          </button>
          <button
            type="button"
            className="stat-chip"
            data-tone="ok"
            data-hot={stats.succeeded > 0 ? 'true' : 'false'}
            aria-pressed={filter === 'succeeded'}
            onClick={() => selectStat('succeeded')}
          >
            <span className="n">{stats.succeeded}</span>
            <span className="k">{t('runsStatSucceeded')}</span>
          </button>
          <button
            type="button"
            className="stat-chip"
            data-tone="fail"
            data-hot={stats.failed > 0 ? 'true' : 'false'}
            aria-pressed={filter === 'failed'}
            onClick={() => selectStat('failed')}
          >
            <span className="n">{stats.failed}</span>
            <span className="k">{t('runsStatFailed')}</span>
          </button>
        </div>
      )}

      <div className="toolbar">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="field search"
          style={{ marginTop: 0 }}
        />
      </div>

      {err && <p className="flash flash-err mb-4">{err}</p>}

      {!loaded ? (
        <div className="data-table-wrap" aria-busy="true" aria-label={t('runsLoading')}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('colName')}</th>
                <th>{t('colStatus')}</th>
                <th>{t('colTemplate')}</th>
                <th>{t('colNamespace')}</th>
                <th>{t('colDuration')}</th>
                <th>{t('colCreated')}</th>
                <th>{t('actions')}</th>
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
                <th>{t('colTemplate')}</th>
                <th>{t('colNamespace')}</th>
                <th>{t('colDuration')}</th>
                <th>{t('colCreated')}</th>
                <th>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className="data-row" onClick={() => nav(`/runs/${r.id}`)}>
                  <td>
                    <Link
                      to={`/runs/${r.id}`}
                      className="font-medium text-[var(--text)] hover:text-[var(--accent-text)]"
                    >
                      {r.name}
                    </Link>
                    <div className="mono text-[11px] text-[var(--muted-2)]">{r.job_name}</div>
                  </td>
                  <td>
                    <StatusBadge status={r.status} label={statusLabel(r.status)} />
                    {(r.status_reason || r.pod_phase) && (
                      <div className="mono mt-1 text-[11px] text-[var(--muted-2)]">
                        {[r.pod_phase, r.status_reason].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className="badge badge-neutral">{r.template}</span>
                  </td>
                  <td className="mono text-[var(--muted)]">{r.namespace}</td>
                  <td className="mono text-[var(--muted)]">{formatDuration(r.duration_seconds)}</td>
                  <td className="text-[var(--muted)]">{formatLocalDateTime(r.created_at, lang)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="runs-acts">
                      {isActive(r.status) && (
                        <button
                          type="button"
                          disabled={busyId === r.id}
                          onClick={() => setDialog({ kind: 'cancel', run: r })}
                          className="runs-act runs-act-warn"
                        >
                          {t('cancel')}
                        </button>
                      )}
                      {isTerminal(r.status) && (
                        <>
                          <button
                            type="button"
                            disabled={busyId === r.id}
                            onClick={() => setDialog({ kind: 'rerun', run: r })}
                            className="runs-act runs-act-primary"
                          >
                            {t('rerun')}
                          </button>
                          <button
                            type="button"
                            disabled={busyId === r.id}
                            onClick={() => setDialog({ kind: 'delete', run: r })}
                            className="runs-act runs-act-danger"
                          >
                            {t('deleteRecord')}
                          </button>
                        </>
                      )}
                      {r.cilikube_links?.configured &&
                      (r.cilikube_links.job || r.cilikube_links.console) ? (
                        <a
                          href={r.cilikube_links.job || r.cilikube_links.console || undefined}
                          target="_blank"
                          rel="noreferrer"
                          className="runs-act"
                          title={t('openCilikube')}
                        >
                          CiliKube
                        </a>
                      ) : (
                        <Link to="/clusters#cilikube" className="runs-act" title={t('cilikubeNotConfigured')}>
                          CiliKube
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
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
