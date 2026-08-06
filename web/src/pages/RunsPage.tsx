import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type Run } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'
import StatusBadge from '../components/StatusBadge'
import { formatDuration, formatLocalDateTime, useI18n } from '../i18n'

function isActive(status: string) {
  return status === 'pending' || status === 'running'
}

function isTerminal(status: string) {
  return status === 'succeeded' || status === 'failed' || status === 'timeout' || status === 'cancelled'
}

type Filter = 'all' | 'active' | 'done'
type Dialog =
  | { kind: 'cancel'; run: Run }
  | { kind: 'delete'; run: Run }
  | { kind: 'rerun'; run: Run }
  | null

export default function RunsPage() {
  const { t, statusLabel } = useI18n()
  const nav = useNavigate()
  const [runs, setRuns] = useState<Run[]>([])
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
    }
  }

  useEffect(() => {
    load()
    const id = window.setInterval(load, 4000)
    return () => window.clearInterval(id)
  }, [])

  const visible = useMemo(() => {
    const qq = q.trim().toLowerCase()
    return runs.filter((r) => {
      if (filter === 'active' && !isActive(r.status)) return false
      if (filter === 'done' && !isTerminal(r.status)) return false
      if (!qq) return true
      return (
        r.name.toLowerCase().includes(qq) ||
        (r.job_name || '').toLowerCase().includes(qq) ||
        r.template.toLowerCase().includes(qq) ||
        r.namespace.toLowerCase().includes(qq)
      )
    })
  }, [runs, filter, q])

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
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-title">{t('runsTitle')}</h1>
          <p className="page-desc">{t('runsDesc')}</p>
        </div>
        <Link to="/new" className="btn btn-primary">
          {t('newRunBtn')}
        </Link>
      </div>

      <div className="toolbar">
        <div className="seg">
          <button type="button" className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
            {t('filterAll')}
          </button>
          <button
            type="button"
            className={filter === 'active' ? 'on' : ''}
            onClick={() => setFilter('active')}
          >
            {t('filterActive')}
          </button>
          <button type="button" className={filter === 'done' ? 'on' : ''} onClick={() => setFilter('done')}>
            {t('filterDone')}
          </button>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="field search"
          style={{ marginTop: 0 }}
        />
      </div>

      {err && <p className="mb-4 text-sm text-[var(--danger)]">{err}</p>}

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
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-[var(--muted)]">
                  {t('emptyRuns')}
                </td>
              </tr>
            )}
            {visible.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/runs/${r.id}`} className="font-medium text-[var(--text)] hover:text-[var(--accent-text)]">
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
                <td className="text-[var(--muted)]">{formatLocalDateTime(r.created_at)}</td>
                <td>
                  <div className="flex flex-wrap gap-1.5">
                    {isActive(r.status) && (
                      <button
                        type="button"
                        disabled={busyId === r.id}
                        onClick={() => setDialog({ kind: 'cancel', run: r })}
                        className="btn btn-warn btn-sm"
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
                          className="btn btn-secondary btn-sm"
                        >
                          {t('rerun')}
                        </button>
                        <button
                          type="button"
                          disabled={busyId === r.id}
                          onClick={() => setDialog({ kind: 'delete', run: r })}
                          className="btn btn-ghost btn-sm text-[var(--danger)]"
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
                        className="btn btn-ghost btn-sm text-[var(--accent-text)]"
                        title={t('openCilikube')}
                      >
                        CiliKube
                      </a>
                    ) : (
                      <Link
                        to="/settings#cilikube"
                        className="btn btn-ghost btn-sm"
                        title={t('cilikubeNotConfigured')}
                      >
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
          dialog?.kind === 'rerun'
            ? `${t('rerunConfirm')}\n\n${dialog.run.name}`
            : t('rerunConfirm')
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
