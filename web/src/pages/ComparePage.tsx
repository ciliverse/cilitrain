import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Run } from '../api'
import { formatDuration, useI18n } from '../i18n'

export default function ComparePage() {
  const { t, statusLabel } = useI18n()
  const [runs, setRuns] = useState<Run[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.compare>> | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    api
      .runs()
      .then(setRuns)
      .catch((e) => setErr(String(e.message || e)))
  }, [])

  function toggle(id: string) {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= 4) return prev
      return [...prev, id]
    })
  }

  async function doCompare() {
    setErr('')
    try {
      setResult(await api.compare(picked))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const finished = runs.filter((r) =>
    ['succeeded', 'failed', 'timeout', 'cancelled'].includes(r.status),
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">{t('compareTitle')}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{t('compareDesc')}</p>
      </div>
      {err && <p className="text-sm text-[var(--danger)]">{err}</p>}

      <section className="panel panel-pad">
        <h2 className="mb-3 font-semibold">{t('pickRuns')}</h2>
        <ul className="max-h-72 space-y-2 overflow-auto text-sm">
          {finished.map((r) => (
            <li key={r.id} className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={picked.includes(r.id)}
                onChange={() => toggle(r.id)}
              />
              <Link to={`/runs/${r.id}`} className="hover:text-[var(--accent)]">
                {r.name}
              </Link>
              <span className="mono text-xs text-[var(--muted)]">{statusLabel(r.status)}</span>
              <span className="mono text-xs text-[var(--muted)]">
                {formatDuration(r.duration_seconds)}
              </span>
            </li>
          ))}
          {finished.length === 0 && (
            <li className="text-[var(--muted)]">{t('emptyRuns')}</li>
          )}
        </ul>
        <button
          type="button"
          disabled={picked.length < 2}
          onClick={doCompare}
          className="mt-4 rounded border border-[var(--accent-dim)] bg-[var(--accent)]/15 px-4 py-2 text-sm font-semibold text-[var(--accent)] disabled:opacity-40"
        >
          {t('compareAction')} ({picked.length})
        </button>
      </section>

      {result && (
        <section className="data-table-wrap overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--line)] text-[var(--muted)]">
              <tr>
                <th className="px-4 py-3">Run</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Template</th>
                <th className="px-4 py-3">CPU/Mem</th>
                {(result.comparison.metric_keys || []).map((k) => (
                  <th key={k} className="px-4 py-3 mono">
                    {k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.runs.map((r) => {
                const row = result.comparison.rows.find((x) => x.run_id === r.id) || {}
                return (
                  <tr key={r.id} className="border-t border-[var(--line)]/60">
                    <td className="px-4 py-3">
                      <Link to={`/runs/${r.id}`} className="hover:text-[var(--accent)]">
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 mono">{statusLabel(r.status)}</td>
                    <td className="px-4 py-3">{r.template}</td>
                    <td className="px-4 py-3 mono text-xs">
                      {r.cpu}/{r.memory}
                    </td>
                    {(result.comparison.metric_keys || []).map((k) => (
                      <td key={k} className="px-4 py-3 mono text-[var(--accent)]">
                        {row[k] == null
                          ? '—'
                          : typeof row[k] === 'number'
                            ? (row[k] as number).toPrecision(4)
                            : String(row[k])}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
