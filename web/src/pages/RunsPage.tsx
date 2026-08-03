import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Run } from '../api'
import { formatDuration, useI18n } from '../i18n'

function statusColor(s: string) {
  if (s === 'succeeded') return 'text-[var(--accent)]'
  if (s === 'failed' || s === 'timeout') return 'text-[var(--danger)]'
  if (s === 'running') return 'text-[var(--warn)]'
  return 'text-[var(--muted)]'
}

export default function RunsPage() {
  const { t, statusLabel } = useI18n()
  const [runs, setRuns] = useState<Run[]>([])
  const [err, setErr] = useState('')

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
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-[var(--muted)]">
                  {t('emptyRuns')}
                </td>
              </tr>
            )}
            {runs.map((r) => (
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
