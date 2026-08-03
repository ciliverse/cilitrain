import { Link, NavLink, Route, Routes } from 'react-router-dom'
import { I18nProvider, useI18n } from './i18n'
import RunsPage from './pages/RunsPage'
import NewRunPage from './pages/NewRunPage'
import RunDetailPage from './pages/RunDetailPage'
import SettingsPage from './pages/SettingsPage'

function Shell({ children }: { children: React.ReactNode }) {
  const { t, lang, setLang } = useI18n()
  const nav = 'px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)]'
  const active = 'text-[var(--accent)]'
  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--line)] bg-[color-mix(in_oklab,var(--panel)_88%,transparent)] backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <Link to="/" className="flex items-baseline gap-3">
            <span className="text-2xl font-bold tracking-tight text-[var(--accent)]">CiliTrain</span>
            <span className="hidden text-xs text-[var(--muted)] sm:inline">{t('tagline')}</span>
          </Link>
          <div className="flex items-center gap-2">
            <nav className="flex items-center gap-1">
              <NavLink to="/" end className={({ isActive }) => `${nav} ${isActive ? active : ''}`}>
                {t('navRuns')}
              </NavLink>
              <NavLink to="/new" className={({ isActive }) => `${nav} ${isActive ? active : ''}`}>
                {t('navNew')}
              </NavLink>
              <NavLink
                to="/settings"
                className={({ isActive }) => `${nav} ${isActive ? active : ''}`}
              >
                {t('navSettings')}
              </NavLink>
            </nav>
            <div className="ml-2 flex overflow-hidden rounded border border-[var(--line)] text-xs">
              <button
                type="button"
                className={`px-2 py-1 ${lang === 'zh' ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'text-[var(--muted)]'}`}
                onClick={() => setLang('zh')}
              >
                中文
              </button>
              <button
                type="button"
                className={`px-2 py-1 ${lang === 'en' ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'text-[var(--muted)]'}`}
                onClick={() => setLang('en')}
              >
                EN
              </button>
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  )
}

function AppRoutes() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<RunsPage />} />
        <Route path="/new" element={<NewRunPage />} />
        <Route path="/runs/:id" element={<RunDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </Shell>
  )
}

export default function App() {
  return (
    <I18nProvider>
      <AppRoutes />
    </I18nProvider>
  )
}
