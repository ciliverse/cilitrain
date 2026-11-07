import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  api,
  fetchShowcase,
  type Cluster,
  type ClusterNodeBrief,
  type ClusterProbe,
  type TrainingWorkload,
  type WorkloadPod,
} from '../api'
import ConfirmDialog from '../components/ConfirmDialog'
import { hostText, RevealNodesButton, useRevealNodes } from '../components/NodePrivacy'
import StatusBadge from '../components/StatusBadge'
import { formatDuration, formatLocalDateTime, parseApiDate, useI18n, type Lang } from '../i18n'
import '../styles/ops.css'

type LoadState = { items: TrainingWorkload[]; nodes: ClusterNodeBrief[]; error?: string }
type StatusFilter = 'all' | 'running' | 'succeeded' | 'failed'

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`ops-chevron${open ? ' is-open' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function KubeDrop({
  value,
  onChange,
  hint,
  activeHint,
  pickLabel,
}: {
  value: string
  onChange: (text: string) => void
  hint: string
  activeHint: string
  pickLabel: string
}) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  async function take(file: File | null) {
    if (!file) return
    onChange(await file.text())
  }

  return (
    <div
      className={`ops-kube-drop${over ? ' is-over' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault()
        depth.current += 1
        setOver(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        depth.current -= 1
        if (depth.current <= 0) {
          depth.current = 0
          setOver(false)
        }
      }}
      onDrop={(e) => {
        e.preventDefault()
        depth.current = 0
        setOver(false)
        const fromList = e.dataTransfer.files?.[0]
        const fromItem = e.dataTransfer.items?.[0]?.kind === 'file' ? e.dataTransfer.items[0].getAsFile() : null
        void take(fromList || fromItem)
      }}
    >
      <textarea className="field mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      <div className="ops-kube-toolbar">
        <span>{over ? activeHint : hint}</span>
        <label className="btn btn-ghost btn-sm cursor-pointer">
          {pickLabel}
          <input
            type="file"
            className="sr-only"
            accept=".yaml,.yml,.conf,text/plain"
            onChange={(e) => {
              const file = e.target.files?.[0] || null
              e.target.value = ''
              void take(file)
            }}
          />
        </label>
      </div>
    </div>
  )
}

function prettyQty(raw?: string | null) {
  if (!raw) return '—'
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti)?$/.exec(raw)
  if (!match) return raw
  const n = Number(match[1])
  const unit = match[2]
  if (unit === 'Ki') {
    const gi = n / 1024 / 1024
    if (gi >= 10) return `${Math.round(gi)}Gi`
    if (gi >= 1) return `${gi.toFixed(1)}Gi`
    return `${Math.max(1, Math.round(n / 1024))}Mi`
  }
  return unit ? `${match[1]}${unit}` : raw
}

function resourceText(item: TrainingWorkload) {
  const parts = [item.cpu, item.memory].filter(Boolean)
  if ((item.gpu || 0) > 0) parts.push(`GPU ×${item.gpu}`)
  return parts.join(' · ') || '—'
}

function formatSeconds(value?: number | null) {
  if (value == null) return '—'
  return formatDuration(value)
}

function spanSeconds(start?: string | null, end?: string | null) {
  if (!start) return null
  const a = parseApiDate(start).getTime()
  const b = end ? parseApiDate(end).getTime() : Date.now()
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.max(0, Math.round((b - a) / 1000))
}

function phaseStatus(phase?: string | null) {
  const key = (phase || '').toLowerCase()
  if (key === 'running' || key === 'pending' || key === 'succeeded' || key === 'failed') return key
  return 'pending'
}

export default function ClustersPage() {
  const { t, lang } = useI18n()
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [probes, setProbes] = useState<Record<string, ClusterProbe>>({})
  const [workloads, setWorkloads] = useState<Record<string, LoadState>>({})
  const [openClusters, setOpenClusters] = useState<Record<string, boolean>>({})
  const [openNodes, setOpenNodes] = useState<Record<string, boolean>>({})
  const [openLoads, setOpenLoads] = useState<Record<string, boolean>>({})
  const [filters, setFilters] = useState<Record<string, StatusFilter>>({})
  const [addOpen, setAddOpen] = useState(false)
  const [kubeOpen, setKubeOpen] = useState(false)
  const [cilikube, setCilikube] = useState('')
  const [name, setName] = useState('')
  const [context, setContext] = useState('')
  const [content, setContent] = useState('')
  const [kubePath, setKubePath] = useState('')
  const [pendingDelete, setPendingDelete] = useState<Cluster | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [cilikubeSaved, setCilikubeSaved] = useState(false)
  const [showcaseOn, setShowcaseOn] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const seeded = useRef(false)

  useEffect(() => {
    let cancelled = false
    fetchShowcase().then((info) => {
      if (!cancelled) setShowcaseOn(info.showcase)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function refresh() {
    setRefreshing(true)
    try {
      const cs = await api.clusters()
      setClusters(cs)
      if (!seeded.current && cs.length) {
        seeded.current = true
        const first = cs.find((c) => !c.simulated) || cs[0]
        setOpenClusters({ [first.id]: true })
      }
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
      const loads: Record<string, LoadState> = {}
      await Promise.all(
        cs.map(async (c) => {
          try {
            const res = await api.clusterWorkloads(c.id)
            loads[c.id] = { items: res.items, nodes: res.nodes || [] }
          } catch (e) {
            loads[c.id] = {
              items: [],
              nodes: [],
              error: e instanceof Error ? e.message : String(e),
            }
          }
        }),
      )
      setWorkloads(loads)
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    refresh().catch((e) => setErr(String(e.message || e)))
  }, [])

  async function addCluster(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setMsg('')
    const kube = content.trim()
    const path = kubePath.trim()
    if (!kube && !path) {
      setErr(t('kubePathHint'))
      return
    }
    try {
      await api.createCluster({
        name,
        kubeconfig_content: kube || null,
        kubeconfig_path: path || null,
        context: context || null,
      })
      setMsg(t('clusterAdded'))
      setContent('')
      setKubePath('')
      setName('')
      setContext('')
      setAddOpen(false)
      await refresh()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    }
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
  const real = clusters.filter((c) => !c.simulated)
  const allItems = real.flatMap((c) => workloads[c.id]?.items || [])
  const runningN = allItems.filter((item) => item.status === 'running').length
  const okN = allItems.filter((item) => item.status === 'succeeded').length
  const badN = allItems.filter((item) => item.status === 'failed').length

  return (
    <div className="ops-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('clustersTitle')}</h1>
          <p className="page-desc">{t('clustersDesc')}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => refresh()} disabled={refreshing}>
          {refreshing ? t('probing') : t('clusterRefresh')}
        </button>
      </div>
      {msg && <p className="flash flash-ok">{msg}</p>}
      {err && <p className="flash flash-err">{err}</p>}

      {clusters.length > 0 ? (
        <div className="ops-stats">
          <div className="ops-stat">
            <b>{clusters.length}</b>
            <span>{t('statClusters')}</span>
          </div>
          <div className="ops-stat">
            <b>{runningN}</b>
            <span>{t('statRunning')}</span>
          </div>
          <div className="ops-stat">
            <b>{okN}</b>
            <span>{t('statSucceeded')}</span>
          </div>
          <div className="ops-stat">
            <b>{badN}</b>
            <span>{t('statFailed')}</span>
          </div>
        </div>
      ) : null}

      <section className="ops-stack">
        {clusters.length === 0 ? (
          <div className="panel panel-pad">
            <p className="ops-section-desc">{showcaseOn ? t('showcaseClusterNote') : t('clusterEmptyHint')}</p>
          </div>
        ) : (
          clusters.map((c) => (
            <ClusterCard
              key={c.id}
              cluster={c}
              probe={probes[c.id]}
              load={workloads[c.id]}
              open={Boolean(openClusters[c.id])}
              nodesOpen={Boolean(openNodes[c.id])}
              filter={filters[c.id] || 'all'}
              openLoads={openLoads}
              lang={lang}
              onToggle={() => setOpenClusters((cur) => ({ ...cur, [c.id]: !cur[c.id] }))}
              onToggleNodes={() => setOpenNodes((cur) => ({ ...cur, [c.id]: !cur[c.id] }))}
              onFilter={(next) => setFilters((cur) => ({ ...cur, [c.id]: next }))}
              onToggleLoad={(key) => setOpenLoads((cur) => ({ ...cur, [key]: !cur[key] }))}
              onRemove={() => setPendingDelete(c)}
              onUpdated={() => refresh()}
            />
          ))
        )}

        {showcaseOn ? null : (
          <div className="ops-acc">
            <button type="button" className="ops-acc-head" onClick={() => setAddOpen((v) => !v)} aria-expanded={addOpen}>
              <Chevron open={addOpen} />
              <span className="ops-cluster-name">{t('clusterAddToggle')}</span>
            </button>
            {addOpen ? (
              <form id="ops-add-cluster" onSubmit={addCluster} className="ops-acc-body ops-inline-form">
                <label className="label ops-grow">
                  {t('name')}
                  <input ref={nameRef} className="field" value={name} onChange={(e) => setName(e.target.value)} required />
                </label>
                <label className="label ops-grow">
                  {t('ctxOptional')}
                  <input className="field mono" value={context} onChange={(e) => setContext(e.target.value)} />
                </label>
                <div className="ops-kube-field">
                  <span className="label">{t('kubeContent')}</span>
                  <KubeDrop
                    value={content}
                    onChange={setContent}
                    hint={t('clusterDropHint')}
                    activeHint={t('clusterDropActive')}
                    pickLabel={t('kubeFile')}
                  />
                </div>
                <label className="label ops-grow">
                  {t('kubePath')}
                  <input
                    className="field mono"
                    value={kubePath}
                    onChange={(e) => setKubePath(e.target.value)}
                    placeholder="~/.kube/config"
                  />
                  <span className="text-xs text-[var(--muted)]">{t('kubePathHint')}</span>
                </label>
                <button type="submit" className="btn btn-primary">
                  {t('addCluster')}
                </button>
              </form>
            ) : null}
          </div>
        )}
      </section>

      <div className="ops-acc" id="cilikube">
        <button type="button" className="ops-acc-head" onClick={() => setKubeOpen((v) => !v)} aria-expanded={kubeOpen}>
          <Chevron open={kubeOpen} />
          <span className="ops-cluster-name">{t('cilikubeRecommendTitle')}</span>
          <span className="ops-cluster-ctx">{t('cilikubeRecommendEyebrow')}</span>
        </button>
        {kubeOpen ? (
          <div className="ops-acc-body">
            <p className="ops-section-desc">{t('cilikubeRecommendDesc')}</p>
            <form onSubmit={saveCilikube} className="ops-recommend-form">
              <input
                className="field flex-1 mono"
                style={{ marginTop: 0 }}
                value={cilikube}
                readOnly={showcaseOn}
                onChange={(e) => setCilikube(e.target.value)}
                placeholder="https://cilikube.example.com"
              />
              {showcaseOn ? null : (
                <button type="submit" className="btn btn-ghost">
                  {cilikubeSaved ? t('saved') : t('save')}
                </button>
              )}
              {consoleUrl ? (
                <a href={`${consoleUrl}/overview`} target="_blank" rel="noreferrer" className="btn btn-secondary">
                  {t('openConsole')}
                </a>
              ) : null}
            </form>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        tone="danger"
        title={t('deleteClusterTitle')}
        description={`${t('deleteClusterConfirm')}\n\n${pendingDelete?.name || ''}`}
        confirmLabel={deleting ? t('deleting') : t('confirmDelete')}
        cancelLabel={t('confirmCancel')}
        busy={deleting}
        onClose={() => !deleting && setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return
          setDeleting(true)
          setErr('')
          try {
            await api.deleteCluster(pendingDelete.id)
            setPendingDelete(null)
            await refresh()
          } catch (ex) {
            setErr(ex instanceof Error ? ex.message : String(ex))
          } finally {
            setDeleting(false)
          }
        }}
      />
    </div>
  )
}

function ClusterCard({
  cluster,
  probe,
  load,
  open,
  nodesOpen,
  filter,
  openLoads,
  lang,
  onToggle,
  onToggleNodes,
  onFilter,
  onToggleLoad,
  onRemove,
  onUpdated,
}: {
  cluster: Cluster
  probe?: ClusterProbe
  load?: LoadState
  open: boolean
  nodesOpen: boolean
  filter: StatusFilter
  openLoads: Record<string, boolean>
  lang: Lang
  onToggle: () => void
  onToggleNodes: () => void
  onFilter: (next: StatusFilter) => void
  onToggleLoad: (key: string) => void
  onRemove: () => void
  onUpdated: () => Promise<void>
}) {
  const { t, statusLabel } = useI18n()
  const { show: showNodes } = useRevealNodes()
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(cluster.name)
  const [editContext, setEditContext] = useState(cluster.context || '')
  const [editUrl, setEditUrl] = useState(cluster.cilikube_base_url || '')
  const [editPath, setEditPath] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editErr, setEditErr] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [editSaved, setEditSaved] = useState(false)

  useEffect(() => {
    setEditName(cluster.name)
    setEditContext(cluster.context || '')
    setEditUrl(cluster.cilikube_base_url || '')
  }, [cluster.name, cluster.context, cluster.cilikube_base_url])
  const items = load?.items || []
  const visible = filter === 'all' ? items : items.filter((item) => item.status === filter)
  const counts = {
    running: items.filter((item) => item.status === 'running').length,
    succeeded: items.filter((item) => item.status === 'succeeded').length,
    failed: items.filter((item) => item.status === 'failed').length,
  }
  return (
    <article className={`ops-acc${open ? ' is-open' : ''}`}>
      <div className="ops-acc-bar">
        <button type="button" className="ops-acc-head" onClick={onToggle} aria-expanded={open}>
          <Chevron open={open} />
          <span className="ops-cluster-name">{cluster.name}</span>
          <span className="ops-acc-badges">
            <span className={`badge ${cluster.simulated || cluster.has_kubeconfig_content ? 'badge-success' : 'badge-warning'}`}>
              {cluster.simulated ? t('showcaseClusterBadge') : cluster.has_kubeconfig_content ? t('kubeSaved') : t('clusterKubeMissing')}
            </span>
            {probe ? (
              <span className={`badge ${probe.reachable ? 'badge-success' : 'badge-warning'}`} title={probe.message || undefined}>
                {probe.reachable ? t('clusterReachable') : t('clusterUnreachable')}
              </span>
            ) : (
              <span className="badge">{t('probing')}</span>
            )}
            {probe?.reachable && probe.gpu_allocatable != null ? (
              <span className="badge badge-neutral">{t('gpuAlloc').replace('{n}', String(probe.gpu_allocatable))}</span>
            ) : null}
            {!cluster.simulated && load && !load.error ? (
              <span className="ops-cluster-ctx">
                {t('statRunning')} {counts.running} · {t('statFailed')} {counts.failed}
              </span>
            ) : null}
          </span>
        </button>
        {cluster.simulated ? null : (
          <span className="ops-acc-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-expanded={editing}
              onClick={() => {
                setEditing((v) => !v)
                if (!open) onToggle()
              }}
            >
              {t('clusterEdit')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm ops-btn-ghost-danger" onClick={onRemove}>
              {t('remove')}
            </button>
          </span>
        )}
      </div>
      {open ? (
        <div className="ops-acc-body">
          <dl className="ops-meta ops-cluster-facts">
            <div>
              <dt>{t('ctxOptional')}</dt>
              <dd className="mono">{cluster.context || '—'}</dd>
            </div>
            <div>
              <dt>{t('clusterCreatedAt')}</dt>
              <dd>{formatLocalDateTime(cluster.created_at, lang)}</dd>
            </div>
            <div>
              <dt>{t('clusterApiserver')}</dt>
              <dd className="mono">{probe?.message || '—'}</dd>
            </div>
            <div>
              <dt>{t('kubeContent')}</dt>
              <dd className="mono">
                {cluster.simulated
                  ? t('showcaseClusterBadge')
                  : cluster.kubeconfig_path || (cluster.has_kubeconfig_content ? t('kubeSaved') : t('clusterKubeMissing'))}
              </dd>
            </div>
          </dl>
          {cluster.simulated ? null : editing ? (
            <form
              className="ops-edit"
              onSubmit={async (e) => {
                e.preventDefault()
                setEditErr('')
                setEditSaved(false)
                const nextName = editName.trim()
                if (!nextName) {
                  setEditErr(t('clusterNameRequired'))
                  return
                }
                const body: Record<string, unknown> = {
                  name: nextName,
                  context: editContext.trim() || null,
                  cilikube_base_url: editUrl.trim() || null,
                }
                if (editPath.trim()) body.kubeconfig_path = editPath.trim()
                if (editContent.trim()) body.kubeconfig_content = editContent.trim()
                setEditBusy(true)
                try {
                  await api.updateCluster(cluster.id, body)
                  setEditContent('')
                  setEditPath('')
                  setEditSaved(true)
                  await onUpdated()
                } catch (ex) {
                  setEditErr(ex instanceof Error ? ex.message : String(ex))
                } finally {
                  setEditBusy(false)
                }
              }}
            >
              {editErr ? <p className="flash flash-err">{editErr}</p> : null}
              <div className="ops-edit-grid">
                <label className="label">
                  {t('name')}
                  <input className="field" value={editName} onChange={(e) => setEditName(e.target.value)} required />
                </label>
                <label className="label">
                  {t('ctxOptional')}
                  <input className="field mono" value={editContext} onChange={(e) => setEditContext(e.target.value)} />
                </label>
                <label className="label ops-edit-span">
                  {t('clusterCilikube')}
                  <input
                    className="field mono"
                    value={editUrl}
                    onChange={(e) => setEditUrl(e.target.value)}
                    placeholder="https://cilikube.example.com"
                  />
                </label>
                <label className="label ops-edit-span">
                  {t('kubePath')}
                  <input
                    className="field mono"
                    value={editPath}
                    onChange={(e) => setEditPath(e.target.value)}
                    placeholder={cluster.kubeconfig_path || '~/.kube/config'}
                  />
                </label>
                <label className="label ops-edit-span">
                  {t('clusterKubeReplace')}
                  <span className="ops-edit-note">{t('clusterEditHint')}</span>
                  <KubeDrop
                    value={editContent}
                    onChange={setEditContent}
                    hint={t('clusterDropHint')}
                    activeHint={t('clusterDropActive')}
                    pickLabel={t('kubeFile')}
                  />
                </label>
              </div>
              <div className="ops-edit-actions">
                {editSaved ? <span className="ops-edit-saved">{t('clusterUpdated')}</span> : <span />}
                <button type="submit" className="btn btn-primary btn-sm" disabled={editBusy}>
                  {editBusy ? t('probing') : t('save')}
                </button>
              </div>
            </form>
          ) : null}
          {cluster.simulated ? <p className="ops-section-desc">{t('showcaseClusterNote')}</p> : null}
          {!load ? (
            <p className="ops-section-desc">{t('probing')}</p>
          ) : load.error ? (
            <p className="flash flash-err">
              {t('clusterWorkloadsErr')}
              {load.error ? ` · ${load.error}` : ''}
            </p>
          ) : (
            <>
              <div className="ops-subacc">
                <div className="ops-subacc-bar">
                  <button type="button" className="ops-subacc-head" onClick={onToggleNodes} aria-expanded={nodesOpen}>
                    <Chevron open={nodesOpen} />
                    <span>
                      {t('clusterNodes')} · {load.nodes.length}
                    </span>
                  </button>
                  <RevealNodesButton />
                </div>
                {nodesOpen ? (
                  load.nodes.length === 0 ? (
                    <p className="ops-section-desc">{t('clusterNodesEmpty')}</p>
                  ) : (
                    <table className="ops-pods">
                      <thead>
                        <tr>
                          <th>{t('colName')}</th>
                          <th>{t('colStatus')}</th>
                          <th>{t('nodeRole')}</th>
                          <th>{t('wlIp')}</th>
                          <th>CPU</th>
                          <th>{t('wlMemory')}</th>
                          <th>GPU</th>
                          <th>{t('nodeKubelet')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {load.nodes.map((node) => (
                          <tr key={node.name}>
                            <td className="mono">{hostText(node.name, showNodes)}</td>
                            <td>
                              {node.ready ? t('wlReady') : t('wlNotReady')}
                              {node.pressure ? <div className="ops-cluster-ctx">{node.pressure}</div> : null}
                            </td>
                            <td>{node.roles || '—'}</td>
                            <td className="mono">{hostText(node.ip, showNodes)}</td>
                            <td className="mono">{node.cpu || '—'}</td>
                            <td className="mono">{prettyQty(node.memory)}</td>
                            <td className="mono">{node.gpu}</td>
                            <td className="mono">{node.kubelet || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                ) : null}
              </div>

              <div className="ops-filters" role="tablist">
                {(
                  [
                    ['all', `${t('wlFilterAll')} ${items.length}`],
                    ['running', `${t('statRunning')} ${counts.running}`],
                    ['succeeded', `${t('statSucceeded')} ${counts.succeeded}`],
                    ['failed', `${t('statFailed')} ${counts.failed}`],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`ops-filter${filter === key ? ' is-on' : ''}`}
                    onClick={() => onFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="ops-section-desc">{t('clusterWorkloadsDesc')}</p>
              {visible.length === 0 ? (
                <p className="ops-section-desc">{t('clusterWorkloadsEmpty')}</p>
              ) : (
                <div className="ops-wl-list">
                  {visible.map((item) => {
                    const key = `${cluster.id}:${item.namespace}/${item.kind}/${item.name}`
                    return (
                      <WorkloadRow
                        key={key}
                        item={item}
                        open={Boolean(openLoads[key])}
                        lang={lang}
                        onToggle={() => onToggleLoad(key)}
                        statusLabel={statusLabel}
                      />
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      ) : null}
    </article>
  )
}

function WorkloadRow({
  item,
  open,
  lang,
  onToggle,
  statusLabel,
}: {
  item: TrainingWorkload
  open: boolean
  lang: Lang
  onToggle: () => void
  statusLabel: (status: string) => string
}) {
  const { t } = useI18n()
  const { show: showNodes } = useRevealNodes()
  const pods = item.pods || []
  const href = item.run_id ? `/runs/${item.run_id}` : item.service_id ? `/services/${item.service_id}` : ''
  return (
    <div className={`ops-wl${open ? ' is-open' : ''}`}>
      <div className="ops-wl-head">
        <button type="button" className="ops-wl-toggle" onClick={onToggle} aria-expanded={open} aria-label={item.name}>
          <Chevron open={open} />
        </button>
        <div className="ops-wl-main">
          <span className="ops-kind">{item.kind === 'Deployment' ? t('wlKindDeploy') : t('wlKindJob')}</span>
          {href ? (
            <Link to={href} className="ops-job-name">
              {item.display_name || item.name}
            </Link>
          ) : (
            <span className="ops-job-name">{item.display_name || item.name}</span>
          )}
          {item.display_name && item.display_name !== item.name ? (
            <span className="mono ops-cluster-ctx">{item.name}</span>
          ) : (
            <span className="mono ops-cluster-ctx">{item.namespace}</span>
          )}
        </div>
        <StatusBadge status={item.status} label={statusLabel(item.status)} />
        <span className="ops-wl-res mono">{resourceText(item)}</span>
        <span className="ops-wl-time">{formatLocalDateTime(item.created_at, lang)}</span>
      </div>
      {open ? (
        <div className="ops-wl-body">
          {item.message ? <p className="ops-wl-msg">{item.message}</p> : null}
          <dl className="ops-meta">
            <div>
              <dt>{t('namespace')}</dt>
              <dd className="mono">{item.namespace}</dd>
            </div>
            <div>
              <dt>{t('wlImage')}</dt>
              <dd className="mono" title={item.image || ''}>
                {item.image || '—'}
              </dd>
            </div>
            <div>
              <dt>{t('wlResources')}</dt>
              <dd className="mono">{resourceText(item)}</dd>
            </div>
            <div>
              <dt>{t('wlScheduler')}</dt>
              <dd>{item.scheduler || t('schedPlatform')}</dd>
            </div>
            {item.template ? (
              <div>
                <dt>{t('wlTemplate')}</dt>
                <dd className="mono">{item.template}</dd>
              </div>
            ) : null}
            <div>
              <dt>{t('wlStarted')}</dt>
              <dd>{formatLocalDateTime(item.started_at, lang)}</dd>
            </div>
            <div>
              <dt>{t('wlFinished')}</dt>
              <dd>{formatLocalDateTime(item.finished_at, lang)}</dd>
            </div>
            <div>
              <dt>{t('wlDuration')}</dt>
              <dd>{formatDuration(spanSeconds(item.started_at, item.finished_at))}</dd>
            </div>
            <div>
              <dt>{t('wlParallel')}</dt>
              <dd className="mono">{item.parallelism ?? '—'}</dd>
            </div>
            <div>
              <dt>{t('wlCompletions')}</dt>
              <dd className="mono">
                {item.succeeded ?? 0}/{item.completions ?? '—'}
                {(item.active || 0) > 0 ? ` · ${t('statRunning')} ${item.active}` : ''}
              </dd>
            </div>
            <div>
              <dt>{t('wlBackoff')}</dt>
              <dd className="mono">{item.backoff_limit ?? '—'}</dd>
            </div>
            <div>
              <dt>{t('wlDeadline')}</dt>
              <dd>{formatSeconds(item.deadline_seconds)}</dd>
            </div>
            <div>
              <dt>{t('wlRestart')}</dt>
              <dd className="mono">{item.restart_policy || '—'}</dd>
            </div>
          </dl>
          <div>
            <p className="ops-subhead">
              {t('wlEvents')} · {(item.events || []).length}
            </p>
            {(item.events || []).length === 0 ? (
              <p className="ops-section-desc">{t('wlNoEvents')}</p>
            ) : (
              <ul className="ops-events">
                {(item.events || []).map((ev, index) => (
                  <li key={`${ev.reason}-${index}`}>
                    <span className={`badge ${ev.type === 'Warning' ? 'badge-warning' : 'badge-neutral'}`}>{ev.type || 'Event'}</span>
                    <span className="ops-event-reason">{ev.reason || '—'}</span>
                    <span className="ops-event-msg">
                      {ev.message || '—'}
                      {ev.count > 1 ? ` ×${ev.count}` : ''}
                    </span>
                    <span className="ops-cluster-ctx">{formatLocalDateTime(ev.created_at, lang)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="ops-subhead">
              {t('wlPods')} · {pods.length}
            </p>
            {pods.length === 0 ? (
              <p className="ops-section-desc">{t('wlNoPods')}</p>
            ) : (
              <table className="ops-pods">
                <thead>
                  <tr>
                    <th>{t('colName')}</th>
                    <th>{t('colStatus')}</th>
                    <th>{t('wlNode')}</th>
                    <th>{t('wlIp')}</th>
                    <th>{t('wlResources')}</th>
                    <th>{t('wlRestarts')}</th>
                    <th>{t('wlReason')}</th>
                    <th>{t('wlStarted')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pods.map((pod) => (
                    <PodLine key={pod.name} pod={pod} lang={lang} statusLabel={statusLabel} showNodes={showNodes} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {href ? (
            <Link to={href} className="ops-job-name">
              {item.run_id ? t('wlOpenRun') : t('wlOpenService')}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function PodLine({
  pod,
  lang,
  statusLabel,
  showNodes,
}: {
  pod: WorkloadPod
  lang: Lang
  statusLabel: (status: string) => string
  showNodes: boolean
}) {
  const status = phaseStatus(pod.phase)
  const resources = [pod.cpu, pod.memory].filter(Boolean).join(' · ')
  return (
    <tr>
      <td className="mono" title={pod.image || ''}>
        {pod.name}
        {pod.qos ? <div className="ops-cluster-ctx">{pod.qos}</div> : null}
      </td>
      <td>
        <StatusBadge status={status} label={statusLabel(status)} />
      </td>
      <td className="mono">{hostText(pod.node, showNodes)}</td>
      <td className="mono">{hostText(pod.ip, showNodes)}</td>
      <td className="mono">{resources || '—'}</td>
      <td className="mono">{pod.restarts}</td>
      <td>{pod.reason || '—'}</td>
      <td>{formatLocalDateTime(pod.started_at, lang)}</td>
    </tr>
  )
}
