import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  applyTheme,
  cycleTheme,
  readTheme,
  storage,
  writeTheme,
  type Theme,
} from './theme'

const DARK_MQ = '(prefers-color-scheme: dark)'

type ThemeCtx = {
  theme: Theme
  toggle: () => void
  prefersDark: boolean
}

const ThemeContext = createContext<ThemeCtx | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => readTheme(storage()))
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia?.(DARK_MQ).matches ?? false,
  )

  useEffect(() => {
    const mql = window.matchMedia?.(DARK_MQ)
    if (!mql) return
    const onChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    applyTheme(document.documentElement, theme, prefersDark)
  }, [theme, prefersDark])

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = cycleTheme(prev)
      writeTheme(storage(), next)
      return next
    })
  }, [])

  const value = useMemo(
    () => ({ theme, toggle, prefersDark }),
    [theme, toggle, prefersDark],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
