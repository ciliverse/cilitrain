import { useEffect, useState, type FormEvent } from 'react'
import { api, type Cluster } from '../api'

export default function SettingsPage() {
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [cilikube, setCilikube] = useState('')
  const [name, setName] = useState('kind')
  const [path, setPath] = useState('/root/.kube/config')
  const [context, setContext] = useState('')
  const [content, setContent] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  async function refresh() {
    setClusters(await api.clusters())
    const s = await api.settings()
    setCilikube(s.cilikube_base_url || '')
  }

  useEffect(() => {
    refresh().catch((e) => setErr(String(e.message || e)))
  }, [])

  async function addCluster(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setMsg('')
    try {
      await api.createCluster({
        name,
        kubeconfig_path: content.trim() ? null : path || null,
        kubeconfig_content: content.trim() || null,
        context: context || null,
      })
      setMsg('Cluster added')
      setContent('')
      await refresh()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    }
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault()
    try {
      await api.putSettings(cilikube.trim() || null)
      setMsg('Settings saved')
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    }
  }

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Direct kubeconfig for Job submit · optional CiliKube deep-link
        </p>
      </div>
      {msg && <p className="text-sm text-[var(--accent)]">{msg}</p>}
      {err && <p className="text-sm text-[var(--danger)]">{err}</p>}

      <section className="rounded border border-[var(--line)] bg-[var(--panel)] p-5">
        <h2 className="text-lg font-semibold">Clusters</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {clusters.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 border-b border-[var(--line)]/60 py-2"
            >
              <div>
                <div className="font-medium">{c.name}</div>
                <div className="mono text-[11px] text-[var(--muted)]">
                  {c.kubeconfig_path || (c.has_kubeconfig_content ? '(inline kubeconfig)' : '')}
                  {c.context ? ` · ctx ${c.context}` : ''}
                </div>
              </div>
              <button
                type="button"
                className="text-xs text-[var(--danger)] hover:underline"
                onClick={async () => {
                  await api.deleteCluster(c.id)
                  await refresh()
                }}
              >
                Remove
              </button>
            </li>
          ))}
          {clusters.length === 0 && (
            <li className="text-[var(--muted)]">No clusters — add one below.</li>
          )}
        </ul>

        <form onSubmit={addCluster} className="mt-5 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-[var(--muted)]">Name</span>
            <input
              className="mt-1 w-full rounded border border-[var(--line)] bg-black/20 px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <label className="text-sm">
            <span className="text-[var(--muted)]">Context (optional)</span>
            <input
              className="mt-1 w-full rounded border border-[var(--line)] bg-black/20 px-3 py-2 mono"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="current-context if empty"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="text-[var(--muted)]">Kubeconfig path</span>
            <input
              className="mt-1 w-full rounded border border-[var(--line)] bg-black/20 px-3 py-2 mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="text-[var(--muted)]">Or paste kubeconfig</span>
            <textarea
              className="mt-1 h-28 w-full rounded border border-[var(--line)] bg-black/20 px-3 py-2 mono text-xs"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="optional — overrides path when set"
            />
          </label>
          <button
            type="submit"
            className="sm:col-span-2 rounded border border-[var(--accent-dim)] bg-[var(--accent)]/15 px-4 py-2 text-sm font-semibold text-[var(--accent)]"
          >
            Add cluster
          </button>
        </form>
      </section>

      <section className="rounded border border-[var(--line)] bg-[var(--panel)] p-5">
        <h2 className="text-lg font-semibold">CiliKube deep-link</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Optional. Only builds “Open in CiliKube” URLs — does not submit Jobs via CiliKube in v0.1.
        </p>
        <form onSubmit={saveSettings} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            className="flex-1 rounded border border-[var(--line)] bg-black/20 px-3 py-2 mono text-sm"
            value={cilikube}
            onChange={(e) => setCilikube(e.target.value)}
            placeholder="https://cilikube.example.com"
          />
          <button
            type="submit"
            className="rounded border border-[var(--line)] px-4 py-2 text-sm hover:border-[var(--accent-dim)]"
          >
            Save
          </button>
        </form>
      </section>
    </div>
  )
}
