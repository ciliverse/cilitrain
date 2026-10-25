import { useI18n } from '../i18n'

export type EnvRow = { key: string; value: string }

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export function envKeyError(key: string): boolean {
  if (!key.trim()) return false
  return !KEY_RE.test(key) || key.toUpperCase().startsWith('CILITRAIN_')
}

export function envFromRows(rows: EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) if (r.key.trim()) out[r.key.trim()] = r.value
  return out
}

export function rowsFromEnv(env?: Record<string, string> | null): EnvRow[] {
  return Object.entries(env || {}).map(([key, value]) => ({ key, value }))
}

export default function EnvEditor({ rows, onChange }: { rows: EnvRow[]; onChange: (rows: EnvRow[]) => void }) {
  const { t } = useI18n()
  const set = (i: number, patch: Partial<EnvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const bad = rows.some((r) => envKeyError(r.key))

  return (
    <div className="env-editor">
      {rows.length > 0 && (
        <div className="env-rows">
          {rows.map((r, i) => (
            <div key={i} className="env-row">
              <input
                className={`field mono${envKeyError(r.key) ? ' is-error' : ''}`}
                placeholder={t('envKey')}
                aria-label={t('envKey')}
                value={r.key}
                onChange={(e) => set(i, { key: e.target.value })}
              />
              <input
                className="field mono"
                placeholder={t('envValue')}
                aria-label={t('envValue')}
                value={r.value}
                onChange={(e) => set(i, { value: e.target.value })}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm env-remove"
                aria-label={`${t('envRemove')} ${r.key}`}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {bad && <p className="env-error">{t('envBadKey')}</p>}
      <button
        type="button"
        className="btn btn-secondary btn-sm env-add"
        disabled={rows.length >= 32}
        onClick={() => onChange([...rows, { key: '', value: '' }])}
      >
        + {t('envAdd')}
      </button>
    </div>
  )
}
