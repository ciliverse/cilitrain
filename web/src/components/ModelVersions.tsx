import { Link, useNavigate } from 'react-router-dom'
import type { ModelVersion } from '../api'
import { formatLocalDateTime, useI18n } from '../i18n'
import { formatMetric } from '../pages/ModelsPage'
import { useFieldLabel } from './InferForm'

const MAX_COMPARE = 12

function better(key: string): 'low' | 'high' | null {
  const k = key.toLowerCase()
  if (k.includes('loss') || k.includes('error')) return 'low'
  if (k.includes('acc') || k.includes('score') || k === 'f1' || k === 'auc') return 'high'
  return null
}

/** Every registered version under one model name, side by side. */
export default function ModelVersions({ current, versions }: { current: ModelVersion; versions: ModelVersion[] }) {
  const { t, lang } = useI18n()
  const fieldLabel = useFieldLabel()
  const nav = useNavigate()
  const rows = [...versions].sort((a, b) => b.version - a.version)
  const metricKeys = Array.from(
    new Set(rows.flatMap((m) => Object.keys(m.metrics).filter((k) => typeof m.metrics[k] === 'number'))),
  ).slice(0, 5)
  const paramKeys = Array.from(new Set(rows.flatMap((m) => Object.keys(m.source_params || {}))))
  const best: Record<string, number> = {}
  for (const k of metricKeys) {
    const dir = better(k)
    const vals = rows.map((m) => m.metrics[k]).filter((v): v is number => typeof v === 'number')
    if (dir && new Set(vals).size > 1) best[k] = dir === 'low' ? Math.min(...vals) : Math.max(...vals)
  }
  const sources = Array.from(new Set(rows.map((m) => m.source_run_id).filter((x): x is string => Boolean(x))))

  return (
    <section className="panel">
      <div className="panel-head infer-history-head">
        <h2 className="panel-title">{t('modelVersions')}</h2>
        {sources.length >= 2 && (
          <Link to={`/compare?ids=${sources.slice(0, MAX_COMPARE).join(',')}`} className="panel-meta">
            {t('modelVersionsCompare')}
          </Link>
        )}
      </div>
      <div className="infer-history-wrap">
        <table className="data-table infer-history model-versions">
          <thead>
            <tr>
              <th>{t('modelVersion')}</th>
              {metricKeys.map((k) => (
                <th key={k} className="mono">
                  {k}
                </th>
              ))}
              {paramKeys.map((k) => (
                <th key={`p-${k}`}>{fieldLabel(k)}</th>
              ))}
              <th>{t('modelFrom')}</th>
              <th>{t('modelInferCount')}</th>
              <th>{t('modelRegistered')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr
                key={m.id}
                className="data-row"
                aria-current={m.id === current.id ? 'true' : undefined}
                onClick={() => nav(`/models/${m.id}`)}
              >
                <td>
                  <span className="model-ver">v{m.version}</span>
                  {m.id === current.id && <span className="model-ver-now">{t('modelVersionCurrent')}</span>}
                </td>
                {metricKeys.map((k) => (
                  <td key={k} className="mono cmp-num" data-best={best[k] === m.metrics[k] ? 'true' : undefined}>
                    {m.metrics[k] == null ? '—' : formatMetric(m.metrics[k])}
                  </td>
                ))}
                {paramKeys.map((k) => (
                  <td key={`p-${k}`} className="mono cmp-num">
                    {m.source_params?.[k] ?? '—'}
                  </td>
                ))}
                <td onClick={(e) => e.stopPropagation()}>
                  {m.source_run_id ? (
                    <Link to={`/runs/${m.source_run_id}`} className="runs-act">
                      {m.source_run_name || m.source_run_id.slice(0, 8)}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="mono runs-muted">{m.infer_count}</td>
                <td className="runs-muted">{formatLocalDateTime(m.created_at, lang)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
