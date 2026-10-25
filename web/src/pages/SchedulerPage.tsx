import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type AuthUser, type Priority, type SchedulerInfo, type SchedulerItem } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'
import SchedulerPanel from '../components/SchedulerPanel'
import StatusBadge from '../components/StatusBadge'
import { formatApiMessage, formatDuration, formatLocalDateTime, parseApiDate, useI18n } from '../i18n'
import '../styles/runs.css'
import '../styles/ops.css'

const PRIORITIES: Priority[] = [1, 0, -1]

function since(value?: string | null): number | null {
  if (!value) return null
  return Math.max(0, Math.round((Date.now() - parseApiDate(value).getTime()) / 1000))
}

function resources(it: SchedulerItem): string {
  return [it.cpu, it.memory, it.gpu_count ? `GPU ${it.gpu_count}` : ''].filter(Boolean).join(' · ')
}

function itemLink(it: SchedulerItem): string {
  return it.kind === 'service' ? `/services/${it.id}` : `/runs/${it.id}`
}

export default function SchedulerPage() {
  const { t, lang, statusLabel } = useI18n()
  const [info, setInfo] = useState<SchedulerInfo | null>(null)
  const [me, setMe] = useState<AuthUser | null>(null)
  const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<SchedulerItem | null>(null)

  const load = useCallback(
    () =>
      api
        .scheduler()
        .then((s) => {
          setInfo(s)
          setErr('')
        })
        .catch((e) => setErr(formatApiMessage(e instanceof Error ? e.message : String(e), t))),
    [t],
  )

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null))
    load()
    const timer = window.setInterval(load, 5000)
    return () => window.clearInterval(timer)
  }, [load])

  const isAdmin = me?.role === 'admin'
  const canEdit = (it: SchedulerItem) => me?.role !== 'viewer' && (it.mine || isAdmin)

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id)
    try {
      await fn()
      await load()
    } catch (e) {
      setErr(formatApiMessage(e instanceof Error ? e.message : String(e), t))
    } finally {
      setBusyId(null)
    }
  }

  function kindLabel(it: SchedulerItem) {
    return it.kind === 'service' ? t('kindService') : it.kind === 'infer' ? t('kindInfer') : t('kindTrain')
  }

  function waitText(it: SchedulerItem) {
    if (it.queue_reason === 'scheduled' && it.not_before) {
      return t('schedStartsAt').replace('{t}', formatLocalDateTime(it.not_before, lang))
    }
    return it.queue_reason ? t(`queueReason_${it.queue_reason}`) : '—'
  }

  return (
    <div className="runs-page sched-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('schedTitle')}</h1>
          <p className="page-desc">{t('schedDesc')}</p>
        </div>
      </div>
      {err && <p className="flash flash-err mb-4">{err}</p>}
      {!info ? null : (
        <>
          <SchedulerPanel info={info} />

          <h2 className="sched-h2">
            {t('schedQueue')}
            <span className="n mono">{info.queue.length}</span>
          </h2>
          {info.queue.length === 0 ? (
            <p className="sched-empty">{t('schedQueueEmpty')}</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('colName')}</th>
                    <th>{t('schedColPriority')}</th>
                    <th>{t('schedColWaiting')}</th>
                    <th>{t('schedColResources')}</th>
                    <th className="runs-th-acts">{t('actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {info.queue.map((it) => (
                    <tr key={it.id} className="data-row">
                      <td className="mono runs-muted">{it.queue_position ?? '—'}</td>
                      <td>
                        <Link to={itemLink(it)} className="runs-name">
                          {it.name}
                        </Link>
                        <div className="runs-sub">
                          {kindLabel(it)} · <span className="mono">{it.namespace}</span>
                          {it.owner && <> · {it.owner}</>}
                        </div>
                      </td>
                      <td>
                        {canEdit(it) ? (
                          <select
                            className="field sched-prio"
                            data-prio={it.priority}
                            value={it.priority}
                            disabled={busyId === it.id}
                            aria-label={t('schedColPriority')}
                            onChange={(e) =>
                              act(it.id, () => api.setRunPriority(it.id, Number(e.target.value) as Priority))
                            }
                          >
                            {PRIORITIES.map((p) => (
                              <option key={p} value={p} disabled={p > 0 && !isAdmin}>
                                {t(`prio_${p}`)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="sched-prio-tag" data-prio={it.priority}>
                            {t(`prio_${it.priority}`)}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="sched-wait">{waitText(it)}</div>
                        <div className="runs-sub mono">
                          {t('schedColWaited')} {formatDuration(since(it.created_at))}
                        </div>
                      </td>
                      <td className="mono runs-muted">{resources(it)}</td>
                      <td className="runs-td-acts">
                        {canEdit(it) && (
                          <div className="runs-acts">
                            {it.queue_reason === 'scheduled' && (
                              <button
                                type="button"
                                className="runs-act runs-act-primary"
                                disabled={busyId === it.id}
                                onClick={() => act(it.id, () => api.startRunNow(it.id))}
                              >
                                {t('schedStartNow')}
                              </button>
                            )}
                            <button
                              type="button"
                              className="runs-act runs-act-warn"
                              disabled={busyId === it.id}
                              onClick={() => setCancelling(it)}
                            >
                              {t('schedDequeue')}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2 className="sched-h2">
            {t('schedRunning')}
            <span className="n mono">{info.active.length}</span>
          </h2>
          {info.active.length === 0 ? (
            <p className="sched-empty">{t('schedRunningEmpty')}</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('colName')}</th>
                    <th>{t('colStatus')}</th>
                    <th>{t('schedColResources')}</th>
                    <th>{t('schedColRunFor')}</th>
                  </tr>
                </thead>
                <tbody>
                  {info.active.map((it) => (
                    <tr key={it.id} className="data-row" data-live="true">
                      <td>
                        <Link to={itemLink(it)} className="runs-name">
                          {it.name}
                        </Link>
                        <div className="runs-sub">
                          {kindLabel(it)} · <span className="mono">{it.namespace}</span>
                          {it.owner && <> · {it.owner}</>}
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={it.status} label={statusLabel(it.status)} />
                      </td>
                      <td className="mono runs-muted">{resources(it)}</td>
                      <td className="mono runs-muted">{formatDuration(since(it.started_at || it.created_at))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={cancelling != null}
        tone="warn"
        title={t('schedDequeueTitle')}
        description={cancelling ? t('schedDequeueDesc').replace('{name}', cancelling.name) : ''}
        confirmLabel={t('schedDequeue')}
        cancelLabel={t('confirmCancel')}
        busy={cancelling != null && busyId === cancelling.id}
        onConfirm={() => {
          const it = cancelling
          if (!it) return
          act(it.id, () => api.cancelRun(it.id)).finally(() => setCancelling(null))
        }}
        onClose={() => setCancelling(null)}
      />
    </div>
  )
}
