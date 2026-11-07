import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type ObserveView } from '../api'
import { hostText, RevealNodesButton, useRevealNodes } from '../components/NodePrivacy'
import Sparkline from '../components/Sparkline'
import StatusBadge from '../components/StatusBadge'
import { useI18n } from '../i18n'
import '../styles/runs.css'
import '../styles/observe.css'

function cores(used: number | null, alloc: number | null): string {
  const u = used == null ? '—' : used >= 10 ? used.toFixed(0) : used.toFixed(2)
  const a = alloc == null ? '—' : alloc >= 10 ? alloc.toFixed(0) : alloc.toFixed(2)
  return `${u} / ${a}`
}

function mem(mi: number | null): string {
  if (mi == null) return '—'
  if (mi >= 1024) return `${(mi / 1024).toFixed(mi >= 10240 ? 0 : 1)}Gi`
  return `${Math.round(mi)}Mi`
}

function memPair(used: number | null, alloc: number | null): string {
  return `${mem(used)} / ${mem(alloc)}`
}

function pct(used: number | null, alloc: number | null): number {
  if (used == null || !alloc) return 0
  return Math.max(0, Math.min(100, (used / alloc) * 100))
}

export default function ObservePage() {
  const { t, statusLabel } = useI18n()
  const { show: showNodes } = useRevealNodes()
  const [view, setView] = useState<ObserveView | null>(null)
  const [clusterId, setClusterId] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const next = await api.observe(clusterId || undefined)
        if (cancelled) return
        setView(next)
        setErr('')
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      }
    }
    load()
    const timer = window.setInterval(load, 8000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [clusterId])

  const totals = view?.totals
  const sources = view?.sources

  return (
    <div className="runs-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('obsTitle')}</h1>
          <p className="page-desc">{t('obsDesc')}</p>
        </div>
        {view && view.clusters.length > 1 && (
          <label className="obs-cluster">
            {t('obsCluster')}
            <select
              className="field"
              value={clusterId || view.cluster_id}
              onChange={(e) => setClusterId(e.target.value)}
            >
              {view.clusters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {err && <p className="flash flash-err">{err}</p>}
      {view?.cluster_error && (
        <p className="flash flash-warn">
          {t('obsClusterErr')}
          {view.cluster_error}
        </p>
      )}

      {view && !view.cluster_id ? (
        <div className="empty-state">
          <p className="empty-title">{t('obsNoCluster')}</p>
          <div className="empty-actions">
            <Link to="/clusters" className="btn btn-primary">
              {t('goClusters')}
            </Link>
          </div>
        </div>
      ) : view && totals && sources ? (
        <>
          <div className="obs-sources">
            {sources.simulated ? (
              <span className="obs-src is-on">{t('obsSimOn')}</span>
            ) : (
              <>
                <span className={sources.metrics_server ? 'obs-src is-on' : 'obs-src'}>
                  {sources.metrics_server ? t('obsMsOn') : t('obsMsOff')}
                </span>
                <span className={sources.prometheus ? 'obs-src is-on' : 'obs-src'}>
                  {sources.prometheus ? t('obsPromOn') : t('obsPromOff')}
                </span>
                <span className={sources.gpu_util ? 'obs-src is-on' : 'obs-src'}>
                  {sources.gpu_util ? t('obsGpuOn') : t('obsGpuOff')}
                </span>
              </>
            )}
          </div>

          <div className="metric-rail obs-rail">
            <div className="metric-cell">
              <div className="obs-k">{t('obsCpu')}</div>
              <div className="obs-v mono">{cores(totals.cpu_used, totals.cpu_alloc)}</div>
              <div className="obs-bar">
                <i style={{ width: `${pct(totals.cpu_used, totals.cpu_alloc)}%` }} />
              </div>
            </div>
            <div className="metric-cell">
              <div className="obs-k">{t('obsMemory')}</div>
              <div className="obs-v mono">{memPair(totals.mem_used_mi, totals.mem_alloc_mi)}</div>
              <div className="obs-bar">
                <i style={{ width: `${pct(totals.mem_used_mi, totals.mem_alloc_mi)}%` }} />
              </div>
            </div>
            <div className="metric-cell">
              <div className="obs-k">{t('obsGpu')}</div>
              <div className="obs-v mono">{totals.gpu_alloc}</div>
              <div className="obs-sub">{t('obsAlloc')}</div>
            </div>
            <div className="metric-cell">
              <div className="obs-k">{t('obsGpuUtil')}</div>
              <div className="obs-v mono">{totals.gpu_util == null ? '—' : `${totals.gpu_util}%`}</div>
              {totals.gpu_count ? <div className="obs-sub">{totals.gpu_count} GPU</div> : null}
            </div>
          </div>

          <div className="obs-h-row">
            <h2 className="obs-h">{t('obsNodes')}</h2>
            <RevealNodesButton />
          </div>
          {view.nodes.length === 0 ? (
            <p className="sched-empty">{t('obsEmptyNodes')}</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('colName')}</th>
                    <th>{t('obsReady')}</th>
                    <th>{t('obsCpu')}</th>
                    <th>{t('obsMemory')}</th>
                    <th>{t('obsGpu')}</th>
                    <th>{t('obsGpuUtil')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.nodes.map((n) => (
                    <tr key={n.name}>
                      <td className="mono">{hostText(n.name, showNodes)}</td>
                      <td>{n.ready ? t('connected') : t('disconnected')}</td>
                      <td className="mono">{cores(n.cpu_used, n.cpu_alloc)}</td>
                      <td className="mono">{memPair(n.mem_used_mi, n.mem_alloc_mi)}</td>
                      <td className="mono">{n.gpu_alloc}</td>
                      <td className="mono">{n.gpu_util == null ? '—' : `${n.gpu_util}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2 className="obs-h">{t('obsTraining')}</h2>
          {view.training.length === 0 ? (
            <p className="sched-empty">{t('obsEmptyTrain')}</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('colName')}</th>
                    <th>{t('colStatus')}</th>
                    <th>{t('obsLoss')}</th>
                    <th>{t('obsCpu')}</th>
                    <th>{t('obsMemory')}</th>
                    <th>{t('obsGpu')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.training.map((row) => (
                    <tr key={row.id} className="data-row">
                      <td>
                        <Link to={`/runs/${row.id}`} className="runs-name">
                          {row.name}
                        </Link>
                        <div className="runs-sub mono">{row.template}</div>
                      </td>
                      <td>
                        <StatusBadge status={row.status} label={statusLabel(row.status)} />
                      </td>
                      <td>
                        {row.points.length >= 2 ? (
                          <span className="obs-trend">
                            <Sparkline points={row.points} live={row.status === 'running'} />
                            <span className="mono runs-sub">
                              {row.metric_key} {row.metric_last}
                            </span>
                          </span>
                        ) : (
                          <span className="runs-sub">—</span>
                        )}
                      </td>
                      <td className="mono">{row.cpu_cores == null ? '—' : row.cpu_cores}</td>
                      <td className="mono">{mem(row.memory_mi)}</td>
                      <td className="mono">{row.gpu}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2 className="obs-h">{t('obsInference')}</h2>
          {view.inference.length === 0 ? (
            <p className="sched-empty">{t('obsEmptyInfer')}</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('colName')}</th>
                    <th>{t('colStatus')}</th>
                    <th>{t('obsRequests')}</th>
                    <th>{t('obsErrors')}</th>
                    <th>{t('obsLatency')}</th>
                    <th>{t('obsCpu')}</th>
                    <th>{t('obsMemory')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.inference.map((row) => (
                    <tr key={row.id} className="data-row">
                      <td>
                        <Link to={`/services/${row.id}`} className="runs-name">
                          {row.name}
                        </Link>
                        {row.provider && <div className="runs-sub">{t('obsProvider')}</div>}
                      </td>
                      <td>
                        <StatusBadge status={row.status} label={statusLabel(row.status)} />
                      </td>
                      <td className="mono">{row.requests}</td>
                      <td className="mono">{row.errors}</td>
                      <td className="mono">{row.avg_latency_ms == null ? '—' : `${row.avg_latency_ms} ms`}</td>
                      <td className="mono">{row.cpu_cores == null ? '—' : row.cpu_cores}</td>
                      <td className="mono">{mem(row.memory_mi)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <p className="sched-empty">Loading...</p>
      )}
    </div>
  )
}
