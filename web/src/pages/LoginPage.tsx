import { useEffect, useState, type FormEvent } from 'react'
import { api, fetchShowcase, setToken, type AuthUser, type ShowcaseInfo } from '../api'
import { useI18n } from '../i18n'
import { useTheme } from '../useTheme'
import { resolveTheme, type Theme } from '../theme'
import LossField from '../components/LossField'
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

function LossRail() {
  const { t } = useI18n()
  const { theme, prefersDark } = useTheme()
  const [r, setR] = useState({ step: 0, loss: 0, lr: 3e-4 })
  const stats = [
    { k: 'step', v: r.step.toLocaleString('en-US') },
    { k: 'loss', v: r.loss.toFixed(4) },
    { k: 'lr', v: r.lr.toExponential(1) },
  ]

  return (
    <aside className="login-rail">
      <LossField tone={resolveTheme(theme, prefersDark)} onReadout={setR} />
      <div className="login-rail-top">
        <div className="wordmark login-wordmark" aria-label="CiliTrain">
          <span className="wordmark-prefix">ciliverse</span>
          <span className="wordmark-name">train</span>
        </div>
        <p className="login-signal">
          <span className="login-signal-dot" aria-hidden />
          {t('loginSignal')}
        </p>
      </div>
      <div className="login-rail-bottom">
        <h2 className="login-headline">{t('loginHeadline')}</h2>
        <p className="login-lead">{t('tagline')}</p>
        <dl className="login-readout" aria-hidden>
          {stats.map((s) => (
            <div key={s.k}>
              <dt>{s.k}</dt>
              <dd>{s.v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </aside>
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
  const [showcase, setShowcase] = useState<ShowcaseInfo>({ showcase: false })

  useEffect(() => {
    let cancelled = false
    fetchShowcase().then((info) => {
      if (!cancelled) setShowcase(info)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const themeLabel =
    theme === 'light' ? t('themeLight') : theme === 'dark' ? t('themeDark') : t('themeSystem')

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
      <LossRail />

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
          <p className="login-card-kicker">{t('loginCardKicker')}</p>
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
            {showcase.showcase && showcase.accounts?.length ? (
              <div className="login-showcase">
                <p className="page-desc">{t('showcaseLoginHint')}</p>
                <div className="login-showcase-accounts">
                  {showcase.accounts.map((account) => (
                    <button
                      key={account.username}
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        setUsername(account.username)
                        setPassword(account.password)
                        setErr('')
                      }}
                    >
                      {t('showcaseUseAccount')} {account.username}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </form>
        </div>
      </div>
    </div>
  )
}
