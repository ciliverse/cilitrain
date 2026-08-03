import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Cluster, type Template } from '../api'

export default function NewRunPage() {
  const nav = useNavigate()
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [clusterId, setClusterId] = useState('')
  const [templateId, setTemplateId] = useState('sklearn-cpu')
  const [name, setName] = useState('sklearn-demo')
  const [namespace, setNamespace] = useState('default')
  const [image, setImage] = useState('')
  const [command, setCommand] = useState('[]')
  const [args, setArgs] = useState('[]')
  const [cpu, setCpu] = useState('1')
  const [memory, setMemory] = useState('1Gi')
  const [timeout, setTimeoutSec] = useState(3600)
  const [pvc, setPvc] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    Promise.all([api.clusters(), api.templates()])
      .then(([cs, ts]) => {
        setClusters(cs)
        setTemplates(ts)
        if (cs[0]) setClusterId(cs[0].id)
        const t = ts.find((x) => x.id === 'sklearn-cpu') || ts[0]
        if (t) applyTemplate(t)
      })
      .catch((e) => setErr(String(e.message || e)))
  }, [])

  function applyTemplate(t: Template) {
    setTemplateId(t.id)
    setImage(t.image)
    setCommand(JSON.stringify(t.command, null, 0))
    setArgs(JSON.stringify(t.args, null, 0))
    setCpu(t.cpu)
    setMemory(t.memory)
    setTimeoutSec(t.timeout_seconds)
    if (t.id !== 'custom') setName(`${t.id}-${Date.now().toString().slice(-4)}`)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const run = await api.createRun({
        cluster_id: clusterId,
        name,
        namespace,
        template: templateId,
        image,
        command: JSON.parse(command),
        args: JSON.parse(args),
        cpu,
        memory,
        timeout_seconds: timeout,
        pvc_name: pvc.trim() || null,
      })
      nav(`/runs/${run.id}`)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  const field =
    'mt-1 w-full rounded border border-[var(--line)] bg-black/20 px-3 py-2 text-sm'

  return (
    <div>
      <h1 className="text-3xl font-bold">New run</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Guardrails: CPU ≤ 2 · memory ≤ 4Gi · timeout ≤ 2h
      </p>
      {err && <p className="mt-4 text-sm text-[var(--danger)]">{err}</p>}
      {clusters.length === 0 && (
        <p className="mt-4 text-sm text-[var(--warn)]">Add a cluster in Settings first.</p>
      )}

      <form onSubmit={onSubmit} className="mt-6 grid max-w-3xl gap-4">
        <label className="text-sm">
          <span className="text-[var(--muted)]">Cluster</span>
          <select
            className={field}
            value={clusterId}
            onChange={(e) => setClusterId(e.target.value)}
            required
          >
            {clusters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="text-[var(--muted)]">Template</span>
          <select
            className={field}
            value={templateId}
            onChange={(e) => {
              const t = templates.find((x) => x.id === e.target.value)
              if (t) applyTemplate(t)
            }}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} — {t.description}
              </option>
            ))}
          </select>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-[var(--muted)]">Name</span>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="text-sm">
            <span className="text-[var(--muted)]">Namespace</span>
            <input
              className={`${field} mono`}
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              required
            />
          </label>
        </div>

        <label className="text-sm">
          <span className="text-[var(--muted)]">Image</span>
          <input className={`${field} mono`} value={image} onChange={(e) => setImage(e.target.value)} required />
        </label>

        <label className="text-sm">
          <span className="text-[var(--muted)]">Command (JSON array)</span>
          <textarea
            className={`${field} mono h-20`}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="text-[var(--muted)]">Args (JSON array)</span>
          <textarea
            className={`${field} mono h-28`}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="text-sm">
            <span className="text-[var(--muted)]">CPU</span>
            <input className={`${field} mono`} value={cpu} onChange={(e) => setCpu(e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="text-[var(--muted)]">Memory</span>
            <input
              className={`${field} mono`}
              value={memory}
              onChange={(e) => setMemory(e.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="text-[var(--muted)]">Timeout (s)</span>
            <input
              type="number"
              className={`${field} mono`}
              value={timeout}
              onChange={(e) => setTimeoutSec(Number(e.target.value))}
            />
          </label>
        </div>

        <label className="text-sm">
          <span className="text-[var(--muted)]">PVC name (optional)</span>
          <input className={`${field} mono`} value={pvc} onChange={(e) => setPvc(e.target.value)} />
        </label>

        <button
          type="submit"
          disabled={busy || !clusterId}
          className="rounded border border-[var(--accent-dim)] bg-[var(--accent)]/15 px-4 py-2.5 text-sm font-semibold text-[var(--accent)] disabled:opacity-40"
        >
          {busy ? 'Submitting…' : 'Submit training Job'}
        </button>
      </form>
    </div>
  )
}
