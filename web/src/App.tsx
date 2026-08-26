import { useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { api, getToken, setToken, type AuthUser } from './api'
import { I18nProvider, useI18n } from './i18n'
import { ThemeProvider, useTheme } from './useTheme'
import type { Theme } from './theme'
import RunsPage from './pages/RunsPage'
import NewRunPage from './pages/NewRunPage'
import RunDetailPage from './pages/RunDetailPage'
import SettingsPage from './pages/SettingsPage'
import ClustersPage from './pages/ClustersPage'
import ComparePage from './pages/ComparePage'
import PipelinesPage from './pages/PipelinesPage'
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

  const themeLabel =
    theme === 'light' ? t('themeLight') : theme === 'dark' ? t('themeDark') : t('themeSystem')

  useEffect(() => {
    api
      .clusters()
      .then((cs) => setClusterLabel(cs[0]?.name || null))
      .catch(() => setClusterLabel(null))
  }, [])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-left">
          <Wordmark />
          <Link
            to="/clusters"
            className={`cluster-chip${clusterLabel ? ' is-live' : ' is-offline'}`}
            title={clusterLabel || t('needCluster')}
            aria-label={
              clusterLabel
                ? `${clusterLabel}, ${t('connected')}`
                : t('chipNoCluster')
            }
          >
            <span className={`dot${clusterLabel ? '' : ' off'}`} />
            <span className="cluster-chip-name truncate mono">
              {clusterLabel || t('chipNoCluster')}
            </span>
            {clusterLabel ? <span className="cluster-chip-live">{t('connected')}</span> : null}
          </Link>
        </div>

        <nav className="app-header-center" aria-label="main">
          <NavTabs />
        </nav>

        <div className="app-header-right">
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
                <Route path="/runs/:id" element={<RunDetailPage />} />
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
