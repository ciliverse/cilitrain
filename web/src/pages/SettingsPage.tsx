import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, fetchShowcase, type AuthUser, type Cluster } from '../api'
import { useI18n } from '../i18n'
import '../styles/ops.css'

function roleBadgeClass(role: string) {
  if (role === 'admin') return 'badge badge-info'
  if (role === 'viewer') return 'badge badge-neutral'
  return 'badge badge-success'
}

export default function SettingsPage() {
  const { t } = useI18n()
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [guardrails, setGuardrails] = useState<{
    max_cpu?: number
    max_memory_gi?: number
    max_gpu?: number
    default_concurrency?: number
    prometheus_url?: string | null
  } | null>(null)
  const [me, setMe] = useState<AuthUser | null>(null)
  const [users, setUsers] = useState<AuthUser[]>([])
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'operator' })
  const [grant, setGrant] = useState({ userId: '', clusterId: '', namespace: 'default' })
  const [showcaseOn, setShowcaseOn] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  async function refresh() {
    const [cs, st, sc] = await Promise.all([api.clusters(), api.settings(), fetchShowcase()])
    setClusters(cs)
    setGuardrails(st)
    setShowcaseOn(sc.showcase)
    try {
      const u = await api.me()
      setMe(u)
      if (u.role === 'admin') {
        setUsers(await api.users())
      }
    } catch {
      setMe(null)
    }
  }

  useEffect(() => {
    refresh().catch((e) => setErr(String(e.message || e)))
  }, [])

  return (
    <div className="ops-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('settingsTitle')}</h1>
          <p className="page-desc">{t('settingsDesc')}</p>
        </div>
      </div>
      {msg && <p className="flash flash-ok">{msg}</p>}
      {err && <p className="flash flash-err">{err}</p>}

      {guardrails && (
        <section className="panel panel-pad">
          <h2 className="ops-section-title">{t('settingsGuardrails')}</h2>
          <div className="hint-row mt-3">
            <span className="hint-chip">CPU ≤ {guardrails.max_cpu}</span>
            <span className="hint-chip">Mem ≤ {guardrails.max_memory_gi}Gi</span>
            <span className="hint-chip">GPU ≤ {guardrails.max_gpu}</span>
          </div>
          <p className="ops-section-desc mt-3">
            {t('settingsProm')}:{' '}
            <span className="mono">{guardrails.prometheus_url || '—'}</span>
          </p>
          <p className="text-xs text-[var(--muted)]">{t('resourceSetupHint')}</p>
        </section>
      )}
      {me?.role === 'admin' ? (
        <section className="panel panel-pad">
          <h2 className="ops-section-title">{t('usersAdmin')}</h2>

          {users.length === 0 ? (
            <div className="empty-state ops-empty">
              <p className="empty-title">{t('usersEmpty')}</p>
            </div>
          ) : (
            <ul className="ops-row-list">
              {users.map((u) => (
                <li key={u.id} className="ops-row">
                  <div className="ops-cluster-main">
                    <span className="ops-user-name">{u.username}</span>
                    <span className={roleBadgeClass(u.role)}>{u.role}</span>
                    {u.is_active ? null : (
                      <span className="badge badge-warning">{t('usersInactive')}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {showcaseOn ? (
            <p className="ops-section-desc mt-3">{t('showcaseReadonlyUsers')}</p>
          ) : (
            <>
              <h3 className="ops-subhead">{t('usersCreateHeading')}</h3>
              <form
                className="ops-inline-form"
                onSubmit={async (e) => {
                  e.preventDefault()
                  try {
                    await api.createUser(newUser)
                    setMsg(t('saved'))
                    setNewUser({ username: '', password: '', role: 'operator' })
                    await refresh()
                  } catch (ex) {
                    setErr(ex instanceof Error ? ex.message : String(ex))
                  }
                }}
              >
                <label className="label ops-grow">
                  {t('username')}
                  <input
                    className="field"
                    value={newUser.username}
                    onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                    required
                  />
                </label>
                <label className="label ops-grow">
                  {t('password')}
                  <input
                    type="password"
                    className="field"
                    value={newUser.password}
                    onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                    required
                  />
                </label>
                <label className="label ops-grow">
                  {t('role')}
                  <select
                    className="field"
                    value={newUser.role}
                    onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                  >
                    <option value="operator">operator</option>
                    <option value="viewer">viewer</option>
                    <option value="admin">admin</option>
                  </select>
                </label>
                <button type="submit" className="btn btn-primary">
                  {t('createUser')}
                </button>
              </form>

              <h3 className="ops-subhead">{t('usersGrantHeading')}</h3>
              <form
                className="ops-inline-form"
                onSubmit={async (e) => {
                  e.preventDefault()
                  try {
                    await api.addGrant(grant.userId, grant.clusterId, grant.namespace)
                    setMsg(t('saved'))
                  } catch (ex) {
                    setErr(ex instanceof Error ? ex.message : String(ex))
                  }
                }}
              >
                <label className="label ops-grow">
                  {t('username')}
                  <select
                    className="field"
                    value={grant.userId}
                    onChange={(e) => setGrant({ ...grant, userId: e.target.value })}
                    required
                  >
                    <option value="">{t('username')}</option>
                    {users
                      .filter((u) => u.role !== 'admin')
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.username}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="label ops-grow">
                  {t('cluster')}
                  <select
                    className="field"
                    value={grant.clusterId}
                    onChange={(e) => setGrant({ ...grant, clusterId: e.target.value })}
                    required
                  >
                    <option value="">{t('cluster')}</option>
                    {clusters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="label ops-grow">
                  {t('grantNs')}
                  <input
                    className="field mono"
                    value={grant.namespace}
                    onChange={(e) => setGrant({ ...grant, namespace: e.target.value })}
                    required
                  />
                </label>
                <button type="submit" className="btn btn-secondary">
                  {t('addGrant')}
                </button>
              </form>
            </>
          )}
        </section>
      ) : (
        <p className="text-sm text-[var(--muted)]">{t('settingsAccountHint')}</p>
      )}

      <p className="text-sm text-[var(--muted)]">
        {t('settingsClustersHint')}{' '}
        <Link to="/clusters" className="text-[var(--accent-text)] underline-offset-2 hover:underline">
          {t('navClusters')}
        </Link>
      </p>
    </div>
  )
}
