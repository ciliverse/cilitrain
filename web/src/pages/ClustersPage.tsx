import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react'
import { api, type Cluster, type ClusterProbe } from '../api'
import { useI18n } from '../i18n'
import '../styles/ops.css'

export default function ClustersPage() {
  const { t } = useI18n()
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [probes, setProbes] = useState<Record<string, ClusterProbe>>({})
  const [cilikube, setCilikube] = useState('')
  const [name, setName] = useState('')
  const [context, setContext] = useState('')
  const [content, setContent] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [cilikubeSaved, setCilikubeSaved] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  async function refresh() {
    const cs = await api.clusters()
    setClusters(cs)
    const s = await api.settings()
    setCilikube(s.cilikube_base_url || '')
    const next: Record<string, ClusterProbe> = {}
    await Promise.all(
      cs.map(async (c) => {
        try {
          next[c.id] = await api.clusterProbe(c.id)
        } catch (e) {
          next[c.id] = {
            cluster_id: c.id,
            name: c.name,
            reachable: false,
            message: e instanceof Error ? e.message : String(e),
          }
        }
      }),
    )
    setProbes(next)
  }

  useEffect(() => {
    refresh().catch((e) => setErr(String(e.message || e)))
  }, [])

  async function addCluster(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setMsg('')
    const kube = content.trim()
    if (!kube) {
      setErr(t('kubeContentHint'))
      return
    }
    try {
      await api.createCluster({
        name,
        kubeconfig_content: kube,
        context: context || null,
      })
      setMsg(t('clusterAdded'))
      setContent('')
      setName('')
      setContext('')
      await refresh()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    }
  }

  async function readKubeFile(file: File) {
    try {
      setContent(await file.text())
      setErr('')
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    }
  }

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    await readKubeFile(file)
  }

  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    dragDepth.current += 1
    setDragOver(true)
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDragOver(false)
    }
  }

  async function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) await readKubeFile(file)
  }

  async function saveCilikube(e: FormEvent) {
    e.preventDefault()
    setErr('')
    try {
      await api.putSettings(cilikube.trim() || null)
      setCilikubeSaved(true)
      window.setTimeout(() => setCilikubeSaved(false), 1600)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    }
  }

  const consoleUrl = cilikube.trim().replace(/\/$/, '')

  return (
    <div className="ops-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('clustersTitle')}</h1>
          <p className="page-desc">{t('clustersDesc')}</p>
        </div>
      </div>
      {msg && <p className="flash flash-ok">{msg}</p>}
      {err && <p className="flash flash-err">{err}</p>}

      <section id="cilikube" className="panel panel-pad ops-recommend scroll-mt-24">
        <p className="ops-recommend-kicker">{t('cilikubeRecommendEyebrow')}</p>
        <h2 className="ops-recommend-title">{t('cilikubeRecommendTitle')}</h2>
        <p className="ops-recommend-desc">{t('cilikubeRecommendDesc')}</p>
        <form onSubmit={saveCilikube} className="ops-recommend-form">
          <input
            className="field flex-1 mono"
            style={{ marginTop: 0 }}
            value={cilikube}
            onChange={(e) => setCilikube(e.target.value)}
            placeholder="https://cilikube.example.com"
          />
          <button type="submit" className="btn btn-ghost">
            {cilikubeSaved ? t('saved') : t('save')}
          </button>
          {consoleUrl && (
            <a
              href={`${consoleUrl}/overview`}
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary"
            >
              {t('openConsole')}
            </a>
          )}
        </form>
      </section>

      <section className="panel panel-pad">
        <h2 className="ops-section-title">{t('clusters')}</h2>
        <p className="ops-section-desc">
          {clusters.length === 0 ? t('clusterEmptyHint') : t('clustersListDesc')}
        </p>

        {clusters.length === 0 ? null : (
          <ul className="ops-cluster-list">
            {clusters.map((c) => (
              <li key={c.id} className="ops-cluster-row">
                <div className="ops-cluster-main">
                  <span className="ops-cluster-name">{c.name}</span>
                  <span
                    className={`badge ${c.has_kubeconfig_content ? 'badge-success' : 'badge-warning'}`}
                  >
                    {c.has_kubeconfig_content ? t('kubeSaved') : t('clusterKubeMissing')}
                  </span>
                  {probes[c.id] ? (
                    <span
                      className={`badge ${probes[c.id].reachable ? 'badge-success' : 'badge-warning'}`}
                      title={probes[c.id].message || undefined}
                    >
                      {probes[c.id].reachable ? t('clusterReachable') : t('clusterUnreachable')}
                    </span>
                  ) : (
                    <span className="badge">{t('probing')}</span>
                  )}
                  {c.context ? <span className="mono ops-cluster-ctx">{c.context}</span> : null}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm ops-btn-ghost-danger"
                  onClick={async () => {
                    await api.deleteCluster(c.id)
                    await refresh()
                  }}
                >
                  {t('remove')}
                </button>
              </li>
            ))}
          </ul>
        )}

        <form id="ops-add-cluster" onSubmit={addCluster} className="ops-add">
          <h3 className="ops-add-title">{t('clusterAddHeading')}</h3>
          <div className="ops-inline-form">
            <label className="label ops-grow">
              {t('name')}
              <input
                ref={nameRef}
                className="field"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            <label className="label ops-grow">
              {t('ctxOptional')}
              <input
                className="field mono"
                value={context}
                onChange={(e) => setContext(e.target.value)}
              />
            </label>
            <div className="ops-kube-field">
              <span className="label">{t('kubeContent')}</span>
              <div
                className={`ops-kube-drop${dragOver ? ' is-over' : ''}`}
                onDragEnter={onDragEnter}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
              >
                <textarea
                  className="field mono text-xs"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  required
                  spellCheck={false}
                />
                <div className="ops-kube-toolbar">
                  <span>{dragOver ? t('clusterDropActive') : t('clusterDropHint')}</span>
                  <label className="btn btn-ghost btn-sm cursor-pointer">
                    {t('kubeFile')}
                    <input
                      type="file"
                      className="sr-only"
                      accept=".yaml,.yml,.conf,text/plain"
                      onChange={onPickFile}
                    />
                  </label>
                </div>
              </div>
            </div>
            <button type="submit" className="btn btn-primary">
              {t('addCluster')}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
