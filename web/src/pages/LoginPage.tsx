import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, setToken } from '../api'
import { useI18n } from '../i18n'
import { useTheme } from '../useTheme'
import type { Theme } from '../theme'

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
    </svg>
  )
}

export default function LoginPage() {
  const { t } = useI18n()
  const { theme, toggle } = useTheme()
  const nav = useNavigate()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const themeLabel =
    theme === 'light' ? t('themeLight') : theme === 'dark' ? t('themeDark') : t('themeSystem')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const out = await api.login(username, password)
      setToken(out.access_token)
      nav('/', { replace: true })
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card relative">
        <button
          type="button"
          className="btn-icon absolute top-4 right-4"
          onClick={toggle}
          title={`${t('themeToggle')}: ${themeLabel}`}
          aria-label={`${t('themeToggle')}: ${themeLabel}`}
        >
          <ThemeIcon theme={theme} />
        </button>
        <div className="wordmark" aria-label="CiliTrain">
          <span className="wordmark-prefix">ciliverse</span>
          <span className="wordmark-name">train</span>
        </div>
        <p className="page-desc mt-4">{t('loginDesc')}</p>
        <form onSubmit={onSubmit} className="mt-6 space-y-3">
          <label className="label">
            {t('username')}
            <input
              className="field"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label className="label">
            {t('password')}
            <input
              type="password"
              className="field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {err && <p className="text-sm text-[var(--danger)]">{err}</p>}
          <button type="submit" disabled={busy} className="btn btn-primary w-full">
            {busy ? t('loggingIn') : t('login')}
          </button>
        </form>
      </div>
    </div>
  )
}
