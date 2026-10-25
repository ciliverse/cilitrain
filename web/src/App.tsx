import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { api, fetchShowcase, getToken, setToken, type AuthUser } from './api'
import { I18nProvider, useI18n } from './i18n'
import { ThemeProvider, useTheme } from './useTheme'
import type { Theme } from './theme'
import RunsPage from './pages/RunsPage'
import NewRunPage from './pages/NewRunPage'
import RunDetailPage from './pages/RunDetailPage'
import SettingsPage from './pages/SettingsPage'
import SchedulerPage from './pages/SchedulerPage'
import ClustersPage from './pages/ClustersPage'
import ComparePage from './pages/ComparePage'
import PipelinesPage from './pages/PipelinesPage'
import ModelsPage from './pages/ModelsPage'
import ModelDetailPage from './pages/ModelDetailPage'
import ServicesPage from './pages/ServicesPage'
import ServiceDetailPage from './pages/ServiceDetailPage'
import LoginPage from './pages/LoginPage'
import NavTabs from './components/NavTabs'
import PageEnter from './components/PageEnter'
import './styles/shell.css'

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === 'light') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M18.4 5.6l-1.1 1.1M6.7 17.3l-1.1 1.1" />
      </svg>
    )
  }
  if (theme === 'dark') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 7 7 0 1 0 20 14.5z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
      <path d="M3 12h9" opacity="0.35" />
    </svg>
  )
}

function Wordmark() {
  return (
    <Link to="/" className="wordmark" aria-label="CiliTrain">
      <span className="wordmark-prefix">ciliverse</span>
      <span className="wordmark-name">train</span>
    </Link>
  )
}

function Shell({
  children,
  user,
  onLogout,
}: {
  children: React.ReactNode
  user: AuthUser | null
  onLogout: () => void
}) {
  const { t, lang, setLang } = useI18n()
  const { theme, toggle: toggleTheme } = useTheme()
  const [clusterLabel, setClusterLabel] = useState<string | null>(null)
  const [clusterReachable, setClusterReachable] = useState<boolean | null>(null)
  const [clusterGpu, setClusterGpu] = useState<number | null>(null)
  const [cilikubeUrl, setCilikubeUrl] = useState<string | null>(null)
  const [showcaseOn, setShowcaseOn] = useState(false)
  const probedId = useRef<string | null>(null)

  const themeLabel =
    theme === 'light' ? t('themeLight') : theme === 'dark' ? t('themeDark') : t('themeSystem')

  useEffect(() => {
    let cancelled = false
    fetchShowcase().then((info) => {
      if (!cancelled) setShowcaseOn(info.showcase)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function tick() {
      try {
        const [cs, st] = await Promise.all([api.clusters(), api.settings()])
        if (cancelled) return
        setCilikubeUrl(st.cilikube_configured && st.cilikube_base_url ? st.cilikube_base_url : null)
        const preferred = window.localStorage.getItem('cilitrain.preferredCluster')
        const first = cs.find((c) => c.id === preferred) || cs[0]
        if (!first) {
          probedId.current = null
          setClusterLabel(null)
          setClusterReachable(null)
          setClusterGpu(null)
          return
        }
        setClusterLabel(first.name)
        if (probedId.current !== first.id) {
          probedId.current = first.id
          setClusterReachable(null)
          setClusterGpu(null)
        }
        const probe = await api.clusterProbe(first.id)
        if (cancelled) return
        setClusterReachable(probe.reachable)
        setClusterGpu(typeof probe.gpu_allocatable === 'number' ? probe.gpu_allocatable : null)
      } catch {
        if (!cancelled) {
          setClusterLabel(null)
          setClusterReachable(null)
          setClusterGpu(null)
        }
      }
    }
    tick()
    const id = window.setInterval(tick, 20000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  return (
    <div className="app-shell">
      {showcaseOn ? (
        <div className="showcase-banner" role="status">
          {t('showcaseBanner')}
        </div>
      ) : null}
      <header className="app-header">
        <div className="app-header-left">
          <Wordmark />
          <Link
            to="/clusters"
            className={`cluster-chip${
              clusterLabel && clusterReachable === true
                ? ' is-live'
                : ' is-offline'
            }`}
            title={
              clusterLabel
                ? clusterReachable === true
                  ? `${clusterLabel}, ${t('connected')}`
                  : clusterReachable === false
                    ? `${clusterLabel}, ${t('disconnected')}`
                    : `${clusterLabel}, ${t('probing')}`
                : t('needCluster')
            }
            aria-label={
              clusterLabel
                ? `${clusterLabel}, ${
                    clusterReachable === true
                      ? t('connected')
                      : clusterReachable === false
                        ? t('disconnected')
                        : t('probing')
                  }`
                : t('chipNoCluster')
            }
          >
            <span
              className={`dot${clusterReachable === true ? '' : ' off'}${
                clusterReachable === false ? ' down' : ''
              }`}
            />
            <span className="cluster-chip-name truncate mono">
              {clusterLabel || t('chipNoCluster')}
            </span>
            {clusterLabel ? (
              <span className="cluster-chip-live">
                {clusterReachable === true
                  ? t('connected')
                  : clusterReachable === false
                    ? t('disconnected')
                    : t('probing')}
                {clusterReachable === true && clusterGpu != null
                  ? ` · ${t('gpuAlloc').replace('{n}', String(clusterGpu))}`
                  : ''}
              </span>
            ) : null}
          </Link>
        </div>

        <nav className="app-header-center" aria-label="main">
          <NavTabs />
        </nav>

        <div className="app-header-right">
          {cilikubeUrl ? (
            <a
              href={cilikubeUrl}
              target="_blank"
              rel="noreferrer"
              className="header-logout"
              title={t('cilikubeNavHint')}
            >
              {t('headerCilikube')}
            </a>
          ) : (
            <Link to="/clusters#cilikube" className="header-logout" title={t('cilikubeNotConfigured')}>
              {t('headerCilikube')}
            </Link>
          )}
          <button
            type="button"
            className="btn-icon"
            onClick={toggleTheme}
            title={`${t('themeToggle')}: ${themeLabel}`}
            aria-label={`${t('themeToggle')}: ${themeLabel}`}
          >
            <ThemeIcon theme={theme} />
          </button>
          <div className="seg" role="group" aria-label="language">
            <button type="button" className={lang === 'zh' ? 'on' : ''} onClick={() => setLang('zh')}>
              中文
            </button>
            <button type="button" className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>
              EN
            </button>
          </div>
          {user && (
            <div className="header-account">
              <span className="header-user mono" title={`${user.username} · ${user.role}`}>
                {user.username}
              </span>
              <button type="button" className="header-logout" onClick={onLogout}>
                {t('logout')}
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="app-content">
        <PageEnter>{children}</PageEnter>
      </main>
    </div>
  )
}

function AppRoutes() {
  const [ready, setReady] = useState(false)
  const [authRequired, setAuthRequired] = useState(true)
  const [user, setUser] = useState<AuthUser | null>(null)
  const nav = useNavigate()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const st = await api.authStatus()
        if (cancelled) return
        setAuthRequired(st.auth_required)
        if (!st.auth_required) {
          setUser({
            id: 'dev',
            username: 'dev',
            role: 'admin',
            is_active: true,
            must_change_password: false,
          })
          setReady(true)
          return
        }
        if (!getToken()) {
          setReady(true)
          return
        }
        const me = await api.me()
        if (!cancelled) setUser(me)
      } catch {
        setToken(null)
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  function onLoggedIn(next: AuthUser) {
    setUser(next)
    nav('/', { replace: true })
  }

  async function onLogout() {
    try {
      await api.logout()
    } catch {
      /* ignore */
    }
    setToken(null)
    setUser(null)
    nav('/login', { replace: true })
  }

  if (!ready) {
    return (
      <div className="boot-screen">
        <p className="text-sm text-[var(--muted)]">Loading...</p>
      </div>
    )
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          authRequired && user ? (
            <Navigate to="/" replace />
          ) : authRequired ? (
            <LoginPage onLoggedIn={onLoggedIn} />
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route
        path="/*"
        element={
          authRequired && !user ? (
            <Navigate to="/login" replace />
          ) : (
            <Shell user={user} onLogout={onLogout}>
              <Routes>
                <Route path="/" element={<RunsPage />} />
                <Route path="/new" element={<NewRunPage />} />
                <Route path="/runs/new" element={<Navigate to="/new" replace />} />
                <Route path="/runs/:id" element={<RunDetailPage />} />
                <Route path="/scheduler" element={<SchedulerPage />} />
                <Route path="/models" element={<ModelsPage />} />
                <Route path="/models/:id" element={<ModelDetailPage />} />
                <Route path="/services" element={<ServicesPage />} />
                <Route path="/services/:id" element={<ServiceDetailPage />} />
                <Route path="/compare" element={<ComparePage />} />
                <Route path="/pipelines" element={<PipelinesPage />} />
                <Route path="/clusters" element={<ClustersPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </Shell>
          )
        }
      />
    </Routes>
  )
}

export default function App() {
  return (
    <I18nProvider>
      <ThemeProvider>
        <AppRoutes />
      </ThemeProvider>
    </I18nProvider>
  )
}
