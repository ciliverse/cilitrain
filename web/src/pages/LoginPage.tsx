import { useState, type FormEvent } from 'react'
import { api, setToken, type AuthUser } from '../api'
import { useI18n } from '../i18n'
import { useTheme } from '../useTheme'
import type { Theme } from '../theme'
import '../styles/login.css'

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

export default function LoginPage({ onLoggedIn }: { onLoggedIn: (user: AuthUser) => void }) {
  const { t, lang, setLang } = useI18n()
  const { theme, toggle } = useTheme()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [shake, setShake] = useState(0)
  const [busy, setBusy] = useState(false)
  const themeLabel =
    theme === 'light' ? t('themeLight') : theme === 'dark' ? t('themeDark') : t('themeSystem')

  const ops = [
    { title: t('loginOpsSubmit'), hint: t('loginOpsSubmitHint') },
    { title: t('loginOpsWatch'), hint: t('loginOpsWatchHint') },
    { title: t('loginOpsCompare'), hint: t('loginOpsCompareHint') },
  ] as const

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const out = await api.login(username, password)
      setToken(out.access_token)
      onLoggedIn(out.user)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
      setShake((n) => n + 1)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <aside className="login-rail">
        <div className="login-rail-brand">
          <p className="login-kicker">{t('navSectionTrain')}</p>
          <div className="wordmark login-wordmark" aria-label="CiliTrain">
            <span className="wordmark-prefix">ciliverse</span>
            <span className="wordmark-name">train</span>
          </div>
          <p className="login-lead">{t('tagline')}</p>
        </div>
        <ol className="login-ops" aria-label={t('loginOpsAria')}>
          {ops.map((step, i) => (
            <li key={step.title} className="login-ops-item">
              <span className="login-ops-idx" aria-hidden>
                {i + 1}
              </span>
              <div>
                <p className="login-ops-title">{step.title}</p>
                <p className="login-ops-hint">{step.hint}</p>
              </div>
            </li>
          ))}
        </ol>
      </aside>

      <div className="login-form-col">
        <div key={shake} className={`login-card${err ? ' shake' : ''}`}>
          <div className="login-toolbar">
            <div className="seg" role="group" aria-label="language">
              <button type="button" className={lang === 'zh' ? 'on' : ''} onClick={() => setLang('zh')}>
                中文
              </button>
              <button type="button" className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>
                EN
              </button>
            </div>
            <button
              type="button"
              className="btn-icon"
              onClick={toggle}
              title={`${t('themeToggle')}: ${themeLabel}`}
              aria-label={`${t('themeToggle')}: ${themeLabel}`}
            >
              <ThemeIcon theme={theme} />
            </button>
          </div>
          <h1 className="login-form-title">{t('login')}</h1>
          <p className="page-desc">{t('loginDesc')}</p>
          <form onSubmit={onSubmit} className="login-form">
            <label className="label" htmlFor="login-username">
              {t('username')}
              <input
                id="login-username"
                className="field"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                required
              />
            </label>
            <div>
              <label className="label" htmlFor="login-password">
                {t('password')}
                <input
                  id="login-password"
                  type="password"
                  className={`field login-field-password${err ? ' is-error' : ''}`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  aria-invalid={err ? true : undefined}
                  aria-describedby={err ? 'login-error' : undefined}
                  required
                />
              </label>
              {err ? (
                <p id="login-error" className="flash flash-err login-field-err" role="alert">
                  {err}
                </p>
              ) : null}
            </div>
            <button type="submit" disabled={busy} className="btn btn-primary w-full">
              {busy ? t('loggingIn') : t('login')}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
