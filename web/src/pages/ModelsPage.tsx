import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type ModelVersion, type ProviderInfo } from '../api'
import ProviderMark from '../components/ProviderMark'
import { formatLocalDateTime, useI18n } from '../i18n'
import '../styles/runs.css'
import '../styles/models.css'

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function formatMetric(v: number | string): string {
  if (typeof v !== 'number') return String(v)
  if (Number.isInteger(v)) return v.toLocaleString()
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(4)
}

const HEADLINE = ['val_loss', 'loss', 'acc', 'accuracy', 'score']

export function headlineMetrics(m: Record<string, number | string>): [string, number | string][] {
  return HEADLINE.filter((k) => typeof m[k] === 'number')
    .slice(0, 2)
    .map((k) => [k, m[k]])
}

export default function ModelsPage() {
  const { t, lang } = useI18n()
  const nav = useNavigate()
  const [models, setModels] = useState<ModelVersion[]>([])
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState('')
  const [adding, setAdding] = useState(false)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [provider, setProvider] = useState('')
  const [name, setName] = useState('')
  const [upstream, setUpstream] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [otherModel, setOtherModel] = useState(false)
  const [saving, setSaving] = useState(false)

  function reload() {
    return api
      .models()
      .then(setModels)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoaded(true))
  }

  useEffect(() => {
    reload()
  }, [])

  function openAdd() {
    setAdding(true)
    setErr('')
    if (providers.length === 0) {
      api
        .providers()
        .then(setProviders)
        .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
    }
  }

  async function submitProvider(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErr('')
    try {
      const created = await api.addProviderModel({
        name: name.trim(),
        provider,
        upstream_model: upstream.trim(),
        base_url: baseUrl.trim(),
        api_key: apiKey,
      })
      setApiKey('')
      setName('')
      setAdding(false)
      nav(`/models/${created.id}`)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setSaving(false)
    }
  }

  function pickProvider(row: ProviderInfo) {
    const listed = row.models ?? []
    const next = listed.includes(row.model_hint) ? row.model_hint : listed[0] || row.model_hint
    setProvider(row.id)
    setUpstream(next)
    setOtherModel(listed.length === 0)
    setBaseUrl('')
    setErr('')
  }

  const chosen = providers.find((row) => row.id === provider)
  const listed = chosen?.models ?? []
  const versions = chosen?.model_versions ?? {}
  const empty = loaded && models.length === 0

  function toggleAdd() {
    if (adding) setAdding(false)
    else openAdd()
  }

  const providerForm = adding ? (
        <form className="panel panel-pad provider-form" onSubmit={submitProvider}>
          <p className="panel-note">{t('providerPickHint')}</p>
          <ul className="provider-picks">
            {providers.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className={`provider-pick${provider === row.id ? ' is-on' : ''}`}
                  aria-pressed={provider === row.id}
                  onClick={() => pickProvider(row)}
                >
                  <span className="provider-mark">
                    <ProviderMark id={row.id} />
                  </span>
                  <span className="provider-pick-name">{row.label}</span>
                </button>
              </li>
            ))}
          </ul>
          {chosen && (
            <>
              <div className="provider-grid">
                <label>
                  <span>{t('providerName')}</span>
                  <input className="field" value={name} onChange={(e) => setName(e.target.value)} required pattern="[a-z0-9][a-z0-9-]{1,40}" />
                </label>
                <label>
                  <span>{t('providerKey')}</span>
                  <input className="field" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" required={provider !== 'ollama'} />
                </label>
                <label className="provider-span">
                  <span>{t('providerModelId')}</span>
                  {listed.length > 0 && (
                    <select
                      className="field"
                      value={otherModel ? '__other__' : upstream}
                      onChange={(e) => {
                        if (e.target.value === '__other__') {
                          setOtherModel(true)
                          setUpstream('')
                        } else {
                          setOtherModel(false)
                          setUpstream(e.target.value)
                        }
                      }}
                    >
                      {listed.map((id) => (
                        <option key={id} value={id}>
                          {versions[id] ? `${id} · ${versions[id]}` : id}
                        </option>
                      ))}
                      <option value="__other__">{t('providerModelOther')}</option>
                    </select>
                  )}
                  {(listed.length === 0 || otherModel) && (
                    <input
                      className={`field${listed.length > 0 ? ' provider-model-manual' : ''}`}
                      value={upstream}
                      onChange={(e) => setUpstream(e.target.value)}
                      required
                      placeholder={chosen.model_hint}
                    />
                  )}
                  {listed.length > 0 && <p className="panel-note provider-model-note">{t('providerModelList')}</p>}
                </label>
                <label>
                  <span>{t('providerBase')}</span>
                  <input
                    className="field"
                    value={provider === 'custom' ? baseUrl : baseUrl || chosen.base_url}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={chosen.base_url || 'https://'}
                    required={provider === 'custom'}
                  />
                </label>
              </div>
              <p className="panel-note">{t('providerBaseHint')}</p>
              <div className="provider-actions">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? t('modelsAdding') : t('modelsAddSubmit')}
                </button>
              </div>
            </>
          )}
        </form>
  ) : null

  return (
    <div className="runs-page models-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('modelsTitle')}</h1>
          <p className="page-desc">{t('modelsDesc')}</p>
        </div>
        {!empty && loaded && (
          <button type="button" className="btn btn-primary" onClick={toggleAdd}>
            {adding ? t('modelsAddHide') : t('modelsAdd')}
          </button>
        )}
      </div>

      {!empty && providerForm}

      {err && <p className="flash flash-err mb-4">{err}</p>}

      {empty ? (
        <div className="empty-state">
          <div>
            <p className="empty-title">{t('modelsEmptyTitle')}</p>
            <p className="runs-empty-desc">{t('modelsEmptyDesc')}</p>
          </div>
          <div className="empty-actions">
            <Link to="/" className="btn btn-secondary">
              {t('navRuns')}
            </Link>
            <button type="button" className="btn btn-primary" onClick={toggleAdd}>
              {adding ? t('modelsAddHide') : t('modelsAdd')}
            </button>
          </div>
          {providerForm}
        </div>
      ) : (
        <div className="data-table-wrap" aria-busy={!loaded}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('colModel')}</th>
                <th>{t('modelMetrics')}</th>
                <th>{t('modelFrom')}</th>
                <th>{t('modelInferCount')}</th>
                <th>{t('modelRegistered')}</th>
                <th className="runs-th-acts">{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {!loaded
                ? [0, 1].map((i) => (
                    <tr key={i}>
                      {[0, 1, 2, 3, 4, 5].map((j) => (
                        <td key={j}>
                          <span className="runs-skel runs-skel-md" />
                        </td>
                      ))}
                    </tr>
                  ))
                : models.map((m) => (
                    <tr key={m.id} className="data-row" onClick={() => nav(`/models/${m.id}`)}>
                      <td>
                        <Link to={`/models/${m.id}`} className="runs-name mono">
                          {m.name}
                          <span className="model-ver">v{m.version}</span>
                        </Link>
                        <div className="runs-sub mono">
                          {m.origin === 'provider'
                            ? `${m.provider || 'provider'} · ${m.upstream_model || ''}`
                            : `${m.template} · ${formatBytes(m.size_bytes)}`}
                        </div>
                      </td>
                      <td>
                        <div className="model-metrics">
                          {headlineMetrics(m.metrics).map(([k, v]) => (
                            <span key={k} className="model-metric mono">
                              <span className="k">{k}</span>
                              {formatMetric(v)}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {m.source_run_id ? (
                          <Link to={`/runs/${m.source_run_id}`} className="runs-act">
                            {m.source_run_name || m.source_run_id.slice(0, 8)}
                          </Link>
                        ) : m.origin === 'provider' ? (
                          <span className="model-ver">{t('modelsOriginProvider')}</span>
                        ) : (
                          <span className="runs-sub">—</span>
                        )}
                      </td>
                      <td className="mono runs-muted">{m.infer_count}</td>
                      <td className="runs-muted">{formatLocalDateTime(m.created_at, lang)}</td>
                      <td className="runs-td-acts" onClick={(e) => e.stopPropagation()}>
                        <div className="runs-acts">
                          <Link to={`/models/${m.id}`} className="runs-act runs-act-primary">
                            {t('inferTitle')}
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
