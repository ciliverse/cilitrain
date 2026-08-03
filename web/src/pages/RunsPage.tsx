import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type Run } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'
import { formatDuration, useI18n } from '../i18n'

function statusColor(s: string) {
  if (s === 'succeeded') return 'text-[var(--accent)]'
  if (s === 'failed' || s === 'timeout' || s === 'cancelled') return 'text-[var(--danger)]'
  if (s === 'running') return 'text-[var(--warn)]'
  return 'text-[var(--muted)]'
}

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

  const chip = (id: Filter, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setFilter(id)}
      className={`rounded px-3 py-1 text-xs font-medium ${
        filter === id
          ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
          : 'text-[var(--muted)] hover:text-[var(--text)]'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">{t('runsTitle')}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">{t('runsDesc')}</p>
        </div>
        <Link
          to="/new"
          className="rounded border border-[var(--accent-dim)] bg-[var(--accent)]/15 px-4 py-2 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent)]/25"
        >
          {t('newRunBtn')}
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded border border-[var(--line)] bg-[var(--panel)] p-0.5">
          {chip('all', t('filterAll'))}
          {chip('active', t('filterActive'))}
          {chip('done', t('filterDone'))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="min-w-[14rem] flex-1 rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-sm"
        />
      </div>

      {err && <p className="mb-4 text-sm text-[var(--danger)]">{err}</p>}
      <div className="overflow-hidden rounded border border-[var(--line)] bg-[var(--panel)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--line)] text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3 font-medium">{t('colName')}</th>
              <th className="px-4 py-3 font-medium">{t('colStatus')}</th>
              <th className="px-4 py-3 font-medium">{t('colTemplate')}</th>
              <th className="px-4 py-3 font-medium">{t('colNamespace')}</th>
              <th className="px-4 py-3 font-medium">{t('colDuration')}</th>
              <th className="px-4 py-3 font-medium">{t('colCreated')}</th>
              <th className="px-4 py-3 font-medium">{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-[var(--muted)]">
                  {t('emptyRuns')}
                </td>
              </tr>
            )}
            {visible.map((r) => (
              <tr key={r.id} className="border-t border-[var(--line)]/70 hover:bg-white/2">
                <td className="px-4 py-3">
                  <Link to={`/runs/${r.id}`} className="font-medium hover:text-[var(--accent)]">
                    {r.name}
                  </Link>
                  <div className="mono text-[11px] text-[var(--muted)]">{r.job_name}</div>
                </td>
                <td className="px-4 py-3">
                  <div className={`mono ${statusColor(r.status)}`}>{statusLabel(r.status)}</div>
                  {(r.status_reason || r.pod_phase) && (
                    <div className="mono text-[11px] text-[var(--muted)]">
                      {[r.pod_phase, r.status_reason].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">{r.template}</td>
                <td className="px-4 py-3 mono">{r.namespace}</td>
                <td className="px-4 py-3 mono text-[var(--muted)]">
                  {formatDuration(r.duration_seconds)}
                </td>
                <td className="px-4 py-3 text-[var(--muted)]">
                  {new Date(r.created_at).toLocaleString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-2">
                    {isActive(r.status) && (
                      <button
                        type="button"
                        disabled={busyId === r.id}
                        onClick={() => setDialog({ kind: 'cancel', run: r })}
                        className="rounded border border-[var(--warn)]/40 px-2 py-0.5 text-xs text-[var(--warn)] hover:bg-[var(--warn)]/10 disabled:opacity-40"
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
                          className="rounded border border-[var(--accent-dim)] px-2 py-0.5 text-xs text-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-40"
                        >
                          {t('rerun')}
                        </button>
                        <button
                          type="button"
                          disabled={busyId === r.id}
                          onClick={() => setDialog({ kind: 'delete', run: r })}
                          className="rounded border border-[var(--danger)]/50 bg-[var(--danger)]/10 px-2 py-0.5 text-xs font-semibold text-[var(--danger)] hover:bg-[var(--danger)]/20 disabled:opacity-40"
                        >
                          {t('deleteRecord')}
                        </button>
                      </>
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
