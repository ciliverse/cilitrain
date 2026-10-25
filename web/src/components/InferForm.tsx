import { useMemo, useState } from 'react'
import type { InferField, InferSpec } from '../api'
import { useI18n } from '../i18n'

type Values = Record<string, string>

function defaults(spec: InferSpec): Values {
  const out: Values = {}
  for (const f of spec.fields) out[f.key] = f.default == null ? '' : String(f.default)
  return out
}

function fieldError(f: InferField, raw: string): boolean {
  if (f.type === 'text') return f.max_len != null && raw.length > f.max_len
  if (raw.trim() === '') return f.default == null
  const n = Number(raw)
  if (!Number.isFinite(n)) return true
  if (f.type === 'int' && !Number.isInteger(n)) return true
  if (f.min != null && n < f.min) return true
  if (f.max != null && n > f.max) return true
  return false
}

export function useFieldLabel() {
  const { t } = useI18n()
  return (key: string) => {
    const k = `field_${key}` as Parameters<typeof t>[0]
    const label = t(k)
    return label === k ? key : label
  }
}

export default function InferForm({
  spec,
  busy,
  disabled,
  onSubmit,
}: {
  spec: InferSpec
  busy?: boolean
  disabled?: boolean
  onSubmit: (input: Record<string, string | number>) => void
}) {
  const { t } = useI18n()
  const label = useFieldLabel()
  const [values, setValues] = useState<Values>(() => defaults(spec))
  const errors = useMemo(
    () => Object.fromEntries(spec.fields.map((f) => [f.key, fieldError(f, values[f.key] ?? '')])),
    [spec, values],
  )
  const invalid = Object.values(errors).some(Boolean)
  const numeric = spec.fields.filter((f) => f.type !== 'text')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (invalid || disabled || busy) return
    const input: Record<string, string | number> = {}
    for (const f of spec.fields) {
      const raw = values[f.key] ?? ''
      if (f.type === 'text') input[f.key] = raw
      else if (raw.trim() !== '') input[f.key] = Number(raw)
    }
    onSubmit(input)
  }

  return (
    <form className="infer-form" onSubmit={submit}>
      {spec.fields
        .filter((f) => f.type === 'text')
        .map((f) => (
          <label key={f.key} className="label">
            <span className="infer-label-row">
              {label(f.key)}
              {f.max_len != null && (
                <span className="infer-count mono" data-over={errors[f.key] ? 'true' : undefined}>
                  {(values[f.key] ?? '').length}/{f.max_len}
                </span>
              )}
            </span>
            <textarea
              className={`field infer-textarea${errors[f.key] ? ' is-error' : ''}`}
              rows={3}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              disabled={disabled}
            />
          </label>
        ))}
      {numeric.length > 0 && (
        <div className="infer-grid" data-count={numeric.length}>
          {numeric.map((f) => (
            <label key={f.key} className="label">
              {label(f.key)}
              <input
                type="number"
                inputMode="decimal"
                className={`field mono${errors[f.key] ? ' is-error' : ''}`}
                min={f.min}
                max={f.max}
                step={f.type === 'int' ? 1 : 'any'}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                disabled={disabled}
              />
              {f.min != null && f.max != null && (
                <span className="infer-range mono">
                  {f.min} – {f.max}
                </span>
              )}
            </label>
          ))}
        </div>
      )}
      <div className="infer-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setValues(defaults(spec))}
          disabled={disabled || busy}
        >
          {t('inferReset')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={disabled || busy || invalid}>
          {busy ? t('inferSubmitting') : t('inferSubmit')}
        </button>
      </div>
    </form>
  )
}
