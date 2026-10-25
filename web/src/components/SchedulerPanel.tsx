import type { SchedulerInfo } from '../api'
import { useI18n } from '../i18n'

export function formatSpan(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  return `${Math.round(seconds / 60)}m`
}

function Meter({ label, used, cap, unlimited }: { label: string; used: number; cap: number; unlimited: string }) {
  const pct = cap ? Math.min(100, (used / cap) * 100) : 0
  const level = !cap ? undefined : pct >= 100 ? 'full' : pct >= 80 ? 'high' : undefined
  return (
    <div className="sched-meter" data-level={level}>
      <div className="sched-meter-head">
        <span>{label}</span>
        <span className="mono">
          {Number(used.toFixed(2))} / {cap ? cap : unlimited}
        </span>
      </div>
      <span className="sched-meter-track">{cap ? <i style={{ width: `${pct}%` }} /> : null}</span>
    </div>
  )
}

/** Queue limits, the signed-in user's usage against the quota, and load per namespace. */
export default function SchedulerPanel({ info }: { info: SchedulerInfo }) {
  const { t } = useI18n()
  const { quota, usage } = info

  return (
    <div className="sched-grid">
      <section className="panel panel-pad">
        <h2 className="ops-section-title">
          {t('schedMine')}
          {info.my_queued > 0 && (
            <span className="sched-queued">{t('schedMyQueued').replace('{n}', String(info.my_queued))}</span>
          )}
        </h2>
        <div className="hint-row mt-3">
          <span className="hint-chip">{t('schedConc').replace('{n}', String(info.concurrency))}</span>
          <span className="hint-chip">{t('schedQueueMax').replace('{n}', String(info.max_queued))}</span>
          <span className="hint-chip">
            {t('schedQueueTimeout').replace('{t}', formatSpan(info.queue_timeout_seconds))}
          </span>
        </div>
        <div className="sched-meters mt-4">
          <Meter label={t('schedActive')} used={usage.active} cap={quota.active} unlimited={t('schedUnlimited')} />
          <Meter label={t('schedCpu')} used={usage.cpu} cap={quota.cpu} unlimited={t('schedUnlimited')} />
          <Meter
            label={t('schedMemory')}
            used={usage.memory_gi}
            cap={quota.memory_gi}
            unlimited={t('schedUnlimited')}
          />
          <Meter label={t('schedGpu')} used={usage.gpu} cap={quota.gpu} unlimited={t('schedUnlimited')} />
        </div>
      </section>

      <section className="panel panel-pad">
        <h2 className="ops-section-title">{t('schedNamespaces')}</h2>
        {info.namespaces.length === 0 ? (
          <p className="ops-section-desc mt-3">{t('schedNsEmpty')}</p>
        ) : (
          <ul className="sched-ns-list mt-3">
            {info.namespaces.map((n) => {
              const pct = Math.min(100, (n.active / Math.max(1, info.concurrency)) * 100)
              return (
                <li key={`${n.cluster_id}/${n.namespace}`}>
                  <div className="sched-meter-head">
                    <span className="mono">
                      {n.cluster_name} / {n.namespace}
                    </span>
                    <span className="mono">
                      {n.active} / {info.concurrency}
                      {n.queued > 0 && (
                        <span className="sched-ns-queued"> · {t('schedNsQueued').replace('{n}', String(n.queued))}</span>
                      )}
                    </span>
                  </div>
                  <span className="sched-meter-track" data-level={pct >= 100 ? 'full' : undefined}>
                    <i style={{ width: `${pct}%` }} />
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
