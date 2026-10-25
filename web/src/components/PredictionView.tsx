import { useState } from 'react'
import { api, downloadFile, type BatchPrediction, type Prediction } from '../api'
import { useI18n } from '../i18n'
import { useFieldLabel } from './InferForm'

export function predictionSummary(p?: Prediction | null): string {
  if (!p) return ''
  if (p.type === 'classification') {
    const prob = p.probabilities?.[p.label]
    return prob != null ? `${p.label} · ${(prob * 100).toFixed(1)}%` : p.label
  }
  if (p.type === 'text') {
    const body = p.text.slice((p.prompt || '').length).replace(/\s+/g, ' ').trim()
    return body.length > 60 ? `${body.slice(0, 60)}…` : body
  }
  if (p.type === 'batch') {
    const counts = Object.entries(p.counts || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(' · ')
    const first = (p.sample[0]?.generated || '').replace(/\s+/g, ' ').trim()
    return counts || (first.length > 60 ? `${first.slice(0, 60)}…` : first)
  }
  return JSON.stringify(p).slice(0, 60)
}

function BatchView({ prediction, runId }: { prediction: BatchPrediction; runId?: string }) {
  const { t } = useI18n()
  const fieldLabel = useFieldLabel()
  const [err, setErr] = useState('')
  const counts = Object.entries(prediction.counts || {}).sort((a, b) => b[1] - a[1])
  const keys = Object.keys(prediction.sample[0]?.input || {})
  const text = prediction.output === 'text'

  function download() {
    if (!runId) return
    setErr('')
    downloadFile(api.artifactUrl(runId, prediction.file), prediction.file).catch((e) =>
      setErr(e instanceof Error ? e.message : String(e)),
    )
  }

  return (
    <div className="pred-batch">
      <div className="pred-batch-head">
        <span className="pred-label-k">{t('batchRows').replace('{n}', String(prediction.rows))}</span>
        {runId && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={download}>
            {t('batchDownload')}
          </button>
        )}
      </div>
      {err && <p className="flash flash-err">{err}</p>}
      {counts.length > 0 && (
        <ul className="pred-bars">
          {counts.map(([name, n], i) => (
            <li key={name} data-top={i === 0 ? 'true' : undefined}>
              <span className="pred-bar-name mono">{name}</span>
              <span className="pred-bar-track">
                <i style={{ width: `${Math.max(0.5, (n / prediction.rows) * 100)}%` }} />
              </span>
              <span className="pred-bar-v mono">{n}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="pred-batch-wrap">
        <table className="pred-batch-table">
          <caption>{t('batchSample').replace('{n}', String(prediction.sample.length))}</caption>
          <thead>
            <tr>
              {(text ? ['prompt'] : keys).map((k) => (
                <th key={k}>{fieldLabel(k)}</th>
              ))}
              {text ? <th>{t('batchGenerated')}</th> : <th>{t('inferPredicted')}</th>}
            </tr>
          </thead>
          <tbody>
            {prediction.sample.map((row, i) => (
              <tr key={i}>
                {(text ? ['prompt'] : keys).map((k) => (
                  <td key={k} className="mono">
                    {String(row.input[k] ?? '')}
                  </td>
                ))}
                {text ? (
                  <td className="pred-batch-gen">{row.generated}</td>
                ) : (
                  <td className="mono">
                    {row.label}
                    {row.confidence != null && (
                      <span className="pred-batch-conf"> {(row.confidence * 100).toFixed(1)}%</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function PredictionView({ prediction, runId }: { prediction: Prediction; runId?: string }) {
  const { t } = useI18n()

  if (prediction.type === 'batch') return <BatchView prediction={prediction} runId={runId} />

  if (prediction.type === 'classification') {
    const rows = Object.entries(prediction.probabilities || {}).sort((a, b) => b[1] - a[1])
    return (
      <div className="pred-class">
        <div className="pred-label">
          <span className="pred-label-k">{t('inferPredicted')}</span>
          <span className="pred-label-v">{prediction.label}</span>
        </div>
        <ul className="pred-bars">
          {rows.map(([name, p]) => (
            <li key={name} data-top={name === prediction.label ? 'true' : undefined}>
              <span className="pred-bar-name mono">{name}</span>
              <span className="pred-bar-track">
                <i style={{ width: `${Math.max(0.5, p * 100)}%` }} />
              </span>
              <span className="pred-bar-v mono">{(p * 100).toFixed(1)}%</span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  if (prediction.type === 'text') {
    const prompt = prediction.prompt || ''
    const known = prediction.text.startsWith(prompt) ? prompt : ''
    return (
      <div className="pred-text">
        <pre className="pred-pre">
          {known && <mark className="pred-prompt">{known}</mark>}
          {prediction.text.slice(known.length)}
        </pre>
        <div className="pred-meta mono">
          {prediction.new_tokens != null && (
            <span>{t('inferNewTokens').replace('{n}', String(prediction.new_tokens))}</span>
          )}
          {prediction.dropped_chars ? (
            <span>{t('inferDropped').replace('{n}', String(prediction.dropped_chars))}</span>
          ) : null}
        </div>
      </div>
    )
  }

  return <pre className="pred-pre mono">{JSON.stringify(prediction, null, 2)}</pre>
}
