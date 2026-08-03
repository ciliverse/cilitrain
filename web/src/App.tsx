import { Link, NavLink, Route, Routes } from 'react-router-dom'
import RunsPage from './pages/RunsPage'
import NewRunPage from './pages/NewRunPage'
import RunDetailPage from './pages/RunDetailPage'
import SettingsPage from './pages/SettingsPage'

function Shell({ children }: { children: React.ReactNode }) {
  const nav = 'px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)]'
  const active = 'text-[var(--accent)]'
  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--line)] bg-[color-mix(in_oklab,var(--panel)_88%,transparent)] backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <Link to="/" className="flex items-baseline gap-3">
            <span className="text-2xl font-bold tracking-tight text-[var(--accent)]">CiliTrain</span>
            <span className="hidden text-xs text-[var(--muted)] sm:inline">
              AI training on Kubernetes
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={({ isActive }) => `${nav} ${isActive ? active : ''}`}>
              Runs
            </NavLink>
            <NavLink to="/new" className={({ isActive }) => `${nav} ${isActive ? active : ''}`}>
              New run
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) => `${nav} ${isActive ? active : ''}`}
            >
              Settings
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  )
}

export default function App() {
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
