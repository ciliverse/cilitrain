import type { ParamField } from '../api'
import { useI18n } from '../i18n'
import { useFieldLabel } from './InferForm'

export const SWEEP_MAX_RUNS = 12

export type ParamState = {
  values: Record<string, string>
  sweep: Record<string, string | null>
}

export function paramState(
  fields: ParamField[],
  preset?: Record<string, number | string> | null,
): ParamState {
  const values: Record<string, string> = {}
  for (const f of fields) {
    const v = preset?.[f.key] ?? f.default
    values[f.key] = v == null ? '' : String(v)
  }
  return { values, sweep: {} }
}

function coerce(f: ParamField, raw: string): number | string | null {
  if (f.type === 'text') return f.max_len != null && raw.length > f.max_len ? null : raw
  if (raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  if (f.type === 'int' && !Number.isInteger(n)) return null
  if (f.min != null && n < f.min) return null
  if (f.max != null && n > f.max) return null
  return n
}

export type ParsedParams = {
  params: Record<string, number | string>
  grid: Record<string, (number | string)[]>
  combos: number
  errors: Record<string, boolean>
}

export function parseParams(fields: ParamField[], state: ParamState): ParsedParams {
  const params: Record<string, number | string> = {}
  const grid: Record<string, (number | string)[]> = {}
  const errors: Record<string, boolean> = {}
  for (const f of fields) {
    const list = state.sweep[f.key]
    if (list != null) {
      const parts = list.split(',').map((x) => x.trim()).filter(Boolean)
      const vals = parts.map((x) => coerce(f, x))
      if (!parts.length || vals.some((v) => v == null)) errors[f.key] = true
      else grid[f.key] = Array.from(new Set(vals as (number | string)[]))
      continue
    }
    const v = coerce(f, state.values[f.key] ?? '')
    if (v == null) errors[f.key] = true
    else params[f.key] = v
  }
  const combos = Object.values(grid).reduce((n, vals) => n * vals.length, Object.keys(grid).length ? 1 : 0)
  return { params, grid, combos, errors }
}

export default function ParamsEditor({
  fields,
  state,
  onChange,
  allowSweep = true,
}: {
  fields: ParamField[]
  state: ParamState
  onChange: (next: ParamState) => void
  allowSweep?: boolean
}) {
  const { t } = useI18n()
  const label = useFieldLabel()
  const { errors } = parseParams(fields, state)

  function toggle(f: ParamField) {
    const on = state.sweep[f.key] != null
    onChange({
      ...state,
      sweep: { ...state.sweep, [f.key]: on ? null : state.values[f.key] ?? '' },
    })
  }

  return (
    <div className="param-grid">
      {fields.map((f) => {
        const sweeping = state.sweep[f.key] != null
        return (
          <div key={f.key} className="param-cell" data-sweep={sweeping ? 'true' : undefined}>
            <div className="param-head">
              <label className="param-label" htmlFor={`param-${f.key}`}>
                {label(f.key)}
              </label>
              {allowSweep && f.type !== 'text' && (
                <button
                  type="button"
                  className="param-mode"
                  aria-pressed={sweeping}
                  onClick={() => toggle(f)}
                >
                  {t('paramSweep')}
                </button>
              )}
            </div>
            {sweeping ? (
              <input
                id={`param-${f.key}`}
                className={`field mono${errors[f.key] ? ' is-error' : ''}`}
                placeholder={t('paramSweepPlaceholder')}
                value={state.sweep[f.key] ?? ''}
                onChange={(e) => onChange({ ...state, sweep: { ...state.sweep, [f.key]: e.target.value } })}
              />
            ) : (
              <input
                id={`param-${f.key}`}
                type={f.type === 'text' ? 'text' : 'number'}
                inputMode="decimal"
                className={`field mono${errors[f.key] ? ' is-error' : ''}`}
                min={f.min}
                max={f.max}
                step={f.type === 'int' ? 1 : 'any'}
                value={state.values[f.key] ?? ''}
                onChange={(e) => onChange({ ...state, values: { ...state.values, [f.key]: e.target.value } })}
              />
            )}
            <span className="param-foot mono">
              <span>CILITRAIN_{f.key.toUpperCase()}</span>
              {f.min != null && f.max != null && (
                <span>
                  {f.min} – {f.max}
                </span>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}
