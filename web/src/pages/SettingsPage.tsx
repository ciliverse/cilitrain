import { useEffect, useState, type FormEvent } from 'react'
import { api, type AuthUser, type Cluster } from '../api'
import { useI18n } from '../i18n'

export default function SettingsPage() {
  const { t } = useI18n()
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [me, setMe] = useState<AuthUser | null>(null)
  const [users, setUsers] = useState<AuthUser[]>([])
  const [cilikube, setCilikube] = useState('')
  const [name, setName] = useState('kind')
  const [path, setPath] = useState('/root/.kube/config')
  const [context, setContext] = useState('')
  const [content, setContent] = useState('')
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'operator' })
  const [grant, setGrant] = useState({ userId: '', clusterId: '', namespace: 'default' })
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  async function refresh() {
    setClusters(await api.clusters())
    const s = await api.settings()
    setCilikube(s.cilikube_base_url || '')
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

  async function addCluster(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setMsg('')
    try {
      await api.createCluster({
        name,
        kubeconfig_path: content.trim() ? null : path || null,
        kubeconfig_content: content.trim() || null,
        context: context || null,
      })
      setMsg(t('clusterAdded'))
      setContent('')
      await refresh()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    }
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault()
    try {
      await api.putSettings(cilikube.trim() || null)
      setMsg(t('saved'))
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    }
  }

  return (
    <div className="space-y-10">
      <div>
        <h1 className="page-title">{t('settingsTitle')}</h1>
        <p className="page-desc">{t('settingsDesc')}</p>
      </div>
      {msg && <p className="text-sm text-[var(--accent)]">{msg}</p>}
      {err && <p className="text-sm text-[var(--danger)]">{err}</p>}

      <section
        id="cilikube"
        className="panel panel-pad scroll-mt-24 border-[var(--accent)]/25"
      >
        <h2 className="text-base font-semibold">{t('cilikubeTitle')}</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">{t('cilikubeDesc')}</p>
        <form onSubmit={saveSettings} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            className="field flex-1 mono"
            style={{ marginTop: 0 }}
            value={cilikube}
            onChange={(e) => setCilikube(e.target.value)}
            placeholder="https://cilikube.example.com"
          />
          <button type="submit" className="btn btn-ghost">
            {t('save')}
          </button>
          {cilikube.trim() && (
            <a
              href={`${cilikube.trim().replace(/\/$/, '')}/overview`}
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary"
            >
              {t('openConsole')}
            </a>
          )}
        </form>
      </section>

      <section className="panel panel-pad">
        <h2 className="text-base font-semibold">{t('clusters')}</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {clusters.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 border-b border-[var(--line)]/60 py-2"
            >
              <div>
                <div className="font-medium">{c.name}</div>
                <div className="mono text-[11px] text-[var(--muted)]">
                  {c.kubeconfig_path || (c.has_kubeconfig_content ? '(inline kubeconfig)' : '')}
                  {c.context ? ` · ctx ${c.context}` : ''}
                </div>
              </div>
              <button
                type="button"
                className="text-xs text-[var(--danger)] hover:underline"
                onClick={async () => {
                  await api.deleteCluster(c.id)
                  await refresh()
                }}
              >
                {t('remove')}
              </button>
            </li>
          ))}
          {clusters.length === 0 && (
            <li className="text-[var(--muted)]">{t('noClusters')}</li>
          )}
        </ul>

        <form onSubmit={addCluster} className="mt-5 grid gap-3 sm:grid-cols-2">
          <label className="label">
            {t('name')}
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="label">
            {t('ctxOptional')}
            <input className="field mono" value={context} onChange={(e) => setContext(e.target.value)} />
          </label>
          <label className="label sm:col-span-2">
            {t('kubePath')}
            <input className="field mono" value={path} onChange={(e) => setPath(e.target.value)} />
          </label>
          <label className="label sm:col-span-2">
            {t('kubePaste')}
            <textarea
              className="field mono h-28 text-xs"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-secondary sm:col-span-2">
            {t('addCluster')}
          </button>
        </form>
      </section>

      {me?.role === 'admin' && (
        <section className="panel panel-pad">
          <h2 className="text-lg font-semibold">{t('usersAdmin')}</h2>
          <ul className="mt-3 space-y-1 text-sm">
            {users.map((u) => (
              <li key={u.id} className="mono text-xs text-[var(--muted)]">
                {u.username} · {u.role}
                {u.is_active ? '' : ' · inactive'}
              </li>
            ))}
          </ul>
          <form
            className="mt-4 grid gap-2 sm:grid-cols-4"
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
            <input
              className="rounded border border-[var(--line)] bg-black/20 px-2 py-1.5 text-sm"
              placeholder={t('username')}
              value={newUser.username}
              onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
              required
            />
            <input
              type="password"
              className="rounded border border-[var(--line)] bg-black/20 px-2 py-1.5 text-sm"
              placeholder={t('password')}
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              required
            />
            <select
              className="rounded border border-[var(--line)] bg-black/20 px-2 py-1.5 text-sm"
              value={newUser.role}
              onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
            >
              <option value="operator">operator</option>
              <option value="viewer">viewer</option>
              <option value="admin">admin</option>
            </select>
            <button
              type="submit"
              className="rounded border border-[var(--accent-dim)] bg-[var(--accent)]/15 px-3 py-1.5 text-sm text-[var(--accent)]"
            >
              {t('createUser')}
            </button>
          </form>
          <form
            className="mt-4 grid gap-2 sm:grid-cols-4"
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
            <select
              className="rounded border border-[var(--line)] bg-black/20 px-2 py-1.5 text-sm"
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
            <select
              className="rounded border border-[var(--line)] bg-black/20 px-2 py-1.5 text-sm"
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
            <input
              className="rounded border border-[var(--line)] bg-black/20 px-2 py-1.5 text-sm mono"
              placeholder={t('grantNs')}
              value={grant.namespace}
              onChange={(e) => setGrant({ ...grant, namespace: e.target.value })}
              required
            />
            <button
              type="submit"
              className="rounded border border-[var(--line)] px-3 py-1.5 text-sm"
            >
              {t('addGrant')}
            </button>
          </form>
        </section>
      )}
    </div>
  )
}
