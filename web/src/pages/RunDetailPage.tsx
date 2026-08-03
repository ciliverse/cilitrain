import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, type Run } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'
import { formatDuration, useI18n } from '../i18n'

function isActive(status?: string) {
  return status === 'pending' || status === 'running'
}

function isTerminal(status?: string) {
  return status === 'succeeded' || status === 'failed' || status === 'timeout' || status === 'cancelled'
}

type Dialog = 'cancel' | 'delete' | 'rerun' | null

export default function RunDetailPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const { t, statusLabel } = useI18n()
  const [run, setRun] = useState<Run | null>(null)
  const [logs, setLogs] = useState('')
  const [pod, setPod] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [copied, setCopied] = useState(false)

  async function load() {
    if (!id) return
    try {
      const r = await api.run(id)
      setRun(r)
      const l = await api.logs(id)
      setLogs(l.logs)
      setPod(l.pod_name || r.pod_name || null)
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    load()
    const timer = window.setInterval(load, 3000)
    return () => window.clearInterval(timer)
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
    window.setTimeout(() => setCopied(false), 1500)
  }

  if (!run && !err) {
    return <p className="text-[var(--muted)]">{t('loading')}</p>
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/" className="text-sm text-[var(--muted)] hover:text-[var(--accent)]">
            {t('backRuns')}
          </Link>
          <h1 className="mt-2 text-3xl font-bold">{run?.name || 'Run'}</h1>
          <p className="mono mt-1 text-sm text-[var(--muted)]">
            {run ? statusLabel(run.status) : ''} · {run?.job_name} · {run?.namespace} ·{' '}
            {formatDuration(run?.duration_seconds)}
          </p>
          {(run?.pod_phase || run?.status_reason) && (
            <p className="mt-1 text-sm text-[var(--muted)]">
              {t('phase')}: <span className="mono text-[var(--text)]">{run?.pod_phase || '—'}</span>
              {' · '}
              {t('reason')}:{' '}
              <span className="mono text-[var(--text)]">{run?.status_reason || '—'}</span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {run && isActive(run.status) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setDialog('cancel')}
              className="rounded border border-[var(--warn)]/50 bg-[var(--warn)]/10 px-3 py-1.5 text-sm font-semibold text-[var(--warn)] hover:bg-[var(--warn)]/20 disabled:opacity-40"
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
                className="rounded border border-[var(--accent-dim)] bg-[var(--accent)]/10 px-3 py-1.5 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent)]/20 disabled:opacity-40"
              >
                {t('rerun')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDialog('delete')}
                className="rounded border border-[var(--danger)]/60 bg-[var(--danger)] px-3 py-1.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
              >
                {t('deleteRecord')}
              </button>
            </>
          )}
          {run?.cilikube_url && (
            <a
              href={run.cilikube_url}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-[var(--line)] px-3 py-1.5 text-sm hover:border-[var(--accent-dim)]"
            >
              {t('openCilikube')}
            </a>
          )}
        </div>
      </div>
      {err && <p className="text-sm text-[var(--danger)]">{err}</p>}
      {run?.error_message && (
        <p className="rounded border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-sm">
          {run.error_message}
        </p>
      )}
      {run?.status_message && (
        <p className="rounded border border-[var(--line)] bg-black/20 px-3 py-2 text-sm text-[var(--muted)]">
          {run.status_message}
        </p>
      )}

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded border border-[var(--line)] bg-[var(--panel)] p-4 text-sm">
          <h2 className="font-semibold">{t('spec')}</h2>
          <dl className="mt-3 space-y-1 text-[var(--muted)]">
            <div>
              Template: <span className="text-[var(--text)]">{run?.template}</span>
            </div>
            <div>
              Image: <span className="mono text-[var(--text)]">{run?.image}</span>
            </div>
            <div>
              Resources:{' '}
              <span className="mono text-[var(--text)]">
                {run?.cpu} / {run?.memory}
              </span>
            </div>
            <div>
              Timeout: <span className="mono text-[var(--text)]">{run?.timeout_seconds}s</span>
            </div>
            <div>
              Pod: <span className="mono text-[var(--text)]">{run?.pod_name || '—'}</span>
            </div>
          </dl>
        </div>
        <div className="rounded border border-[var(--line)] bg-[var(--panel)] p-4 text-sm">
          <h2 className="font-semibold">{t('events')}</h2>
          <ul className="mono mt-3 max-h-40 space-y-1 overflow-auto text-xs text-[var(--muted)]">
            {(run?.events || []).length === 0 && <li>{t('none')}</li>}
            {(run?.events || []).map((ev, i) => (
              <li key={i}>{ev}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="rounded border border-[var(--line)] bg-[var(--panel)] p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">
            {t('logs')} {pod ? `· ${pod}` : ''}
          </h2>
        </div>
        <pre className="mono max-h-[28rem] overflow-auto whitespace-pre-wrap rounded bg-black/35 p-3 text-xs leading-relaxed text-[var(--text)]">
          {logs || t('none')}
        </pre>
      </section>

      {run?.job_yaml && (
        <section className="rounded border border-[var(--line)] bg-[var(--panel)] p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="font-semibold">{t('jobYaml')}</h2>
            <button
              type="button"
              onClick={copyYaml}
              className="rounded border border-[var(--line)] px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--accent)]"
            >
              {copied ? t('copied') : t('copyYaml')}
            </button>
          </div>
          <pre className="mono mt-3 max-h-80 overflow-auto text-xs text-[var(--muted)]">
            {run.job_yaml}
          </pre>
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
