import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type Run } from '../api'

export default function RunDetailPage() {
  const { id } = useParams()
  const [run, setRun] = useState<Run | null>(null)
  const [logs, setLogs] = useState('')
  const [pod, setPod] = useState<string | null>(null)
  const [err, setErr] = useState('')

  async function load() {
    if (!id) return
    try {
      const r = await api.run(id)
      setRun(r)
      const l = await api.logs(id)
      setLogs(l.logs)
      setPod(l.pod_name || null)
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    load()
    const t = window.setInterval(load, 4000)
    return () => window.clearInterval(t)
  }, [id])

  if (!run && !err) {
    return <p className="text-[var(--muted)]">Loading…</p>
  }

  return (
    <div className="space-y-6">
      <div>
        <Link to="/" className="text-sm text-[var(--muted)] hover:text-[var(--accent)]">
          ← Runs
        </Link>
        <h1 className="mt-2 text-3xl font-bold">{run?.name || 'Run'}</h1>
        <p className="mono mt-1 text-sm text-[var(--muted)]">
          {run?.status?.toUpperCase()} · {run?.job_name} · {run?.namespace}
        </p>
      </div>
      {err && <p className="text-sm text-[var(--danger)]">{err}</p>}
      {run?.error_message && (
        <p className="rounded border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-sm">
          {run.error_message}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        {run?.cilikube_url && (
          <a
            href={run.cilikube_url}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-[var(--line)] px-3 py-1.5 text-sm hover:border-[var(--accent-dim)]"
          >
            Open in CiliKube
          </a>
        )}
      </div>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded border border-[var(--line)] bg-[var(--panel)] p-4 text-sm">
          <h2 className="font-semibold">Spec</h2>
          <dl className="mt-3 space-y-1 text-[var(--muted)]">
            <div>Template: <span className="text-[var(--text)]">{run?.template}</span></div>
            <div>Image: <span className="mono text-[var(--text)]">{run?.image}</span></div>
            <div>
              Resources:{' '}
              <span className="mono text-[var(--text)]">
                {run?.cpu} / {run?.memory}
              </span>
            </div>
            <div>
              Timeout: <span className="mono text-[var(--text)]">{run?.timeout_seconds}s</span>
            </div>
          </dl>
        </div>
        <div className="rounded border border-[var(--line)] bg-[var(--panel)] p-4 text-sm">
          <h2 className="font-semibold">Events</h2>
          <ul className="mono mt-3 max-h-40 space-y-1 overflow-auto text-xs text-[var(--muted)]">
            {(run?.events || []).length === 0 && <li>(none)</li>}
            {(run?.events || []).map((ev, i) => (
              <li key={i}>{ev}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="rounded border border-[var(--line)] bg-[var(--panel)] p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">Logs {pod ? `· ${pod}` : ''}</h2>
        </div>
        <pre className="mono max-h-[28rem] overflow-auto rounded bg-black/35 p-3 text-xs leading-relaxed text-[var(--text)]">
          {logs || '(empty)'}
        </pre>
      </section>

      {run?.job_yaml && (
        <section className="rounded border border-[var(--line)] bg-[var(--panel)] p-4">
          <h2 className="font-semibold">Job YAML</h2>
          <pre className="mono mt-3 max-h-80 overflow-auto text-xs text-[var(--muted)]">
            {run.job_yaml}
          </pre>
        </section>
      )}
    </div>
  )
}
