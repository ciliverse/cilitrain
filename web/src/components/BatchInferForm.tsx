import { useRef, useState } from 'react'
import type { InferSpec } from '../api'
import { useI18n } from '../i18n'

const MAX_BYTES = 256 * 1024

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function sampleCsv(spec: InferSpec): string {
  const keys = spec.fields.map((f) => f.key)
  const row = spec.fields.map((f) => csvCell(f.default ?? ''))
  return `${keys.join(',')}\n${row.join(',')}\n`
}

/** Rough count for the hint only; the server parses quoted newlines properly. */
function roughRows(text: string): number {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  return Math.max(0, lines.length - 1)
}

export default function BatchInferForm({
  spec,
  busy,
  disabled,
  onSubmit,
}: {
  spec: InferSpec
  busy?: boolean
  disabled?: boolean
  onSubmit: (csv: string) => void
}) {
  const { t } = useI18n()
  const fileRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const maxRows = spec.batch_max_rows ?? 100
  const bytes = new Blob([text]).size
  const rows = roughRows(text)
  const tooBig = bytes > MAX_BYTES
  const tooMany = rows > maxRows
  const empty = rows === 0

  function downloadSample() {
    const url = URL.createObjectURL(new Blob([sampleCsv(spec)], { type: 'text/csv' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'inputs-sample.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setFileName(file.name)
    setText(await file.text())
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (disabled || busy || empty || tooBig || tooMany) return
    onSubmit(text)
  }

  return (
    <form className="infer-form" onSubmit={submit}>
      <p className="panel-note batch-cols">
        {t('batchColumns')} <span className="mono">{spec.fields.map((f) => f.key).join(', ')}</span>
      </p>
      <div className="batch-pick">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={pick}
          disabled={disabled}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => fileRef.current?.click()}
          disabled={disabled}
        >
          {t('batchChoose')}
        </button>
        <span className="batch-file mono">{fileName || t('batchOrPaste')}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={downloadSample}>
          {t('batchSampleCsv')}
        </button>
      </div>
      <textarea
        className={`field infer-textarea batch-textarea${tooBig || tooMany ? ' is-error' : ''}`}
        rows={6}
        spellCheck={false}
        placeholder={sampleCsv(spec)}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setFileName('')
        }}
        disabled={disabled}
        aria-label={t('batchCsvLabel')}
      />
      <div className="infer-actions batch-actions">
        <span className="batch-hint mono" data-over={tooBig || tooMany ? 'true' : undefined}>
          {tooBig
            ? t('batchTooBig')
            : t('batchHint').replace('{n}', String(rows)).replace('{max}', String(maxRows))}
        </span>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={disabled || busy || empty || tooBig || tooMany}
        >
          {busy ? t('inferSubmitting') : t('batchSubmit')}
        </button>
      </div>
    </form>
  )
}
