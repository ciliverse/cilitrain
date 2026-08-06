/** Theme preference — mirrors kubeside: system | light | dark, persisted locally. */

export type Theme = 'system' | 'light' | 'dark'

export const THEME_KEY = 'cilitrain.theme'
export const DEFAULT_THEME: Theme = 'system'

export function isTheme(v: unknown): v is Theme {
  return v === 'system' || v === 'light' || v === 'dark'
}

export function readTheme(storage: Storage | null): Theme {
  try {
    const raw = storage?.getItem(THEME_KEY)
    if (!raw) return DEFAULT_THEME
    const parsed: unknown = JSON.parse(raw)
    if (isTheme(parsed)) return parsed
    if (typeof parsed === 'object' && parsed !== null && isTheme((parsed as { theme?: unknown }).theme)) {
      return (parsed as { theme: Theme }).theme
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME
}

export function writeTheme(storage: Storage | null, theme: Theme): void {
  try {
    storage?.setItem(THEME_KEY, JSON.stringify(theme))
  } catch {
    /* ignore */
  }
}

export function resolveTheme(theme: Theme, prefersDark: boolean): 'light' | 'dark' {
  if (theme === 'system') return prefersDark ? 'dark' : 'light'
  return theme
}

export function applyTheme(root: HTMLElement, theme: Theme, prefersDark: boolean): void {
  const resolved = resolveTheme(theme, prefersDark)
  root.setAttribute('data-theme', resolved)
  root.setAttribute('data-theme-pref', theme)
  root.style.colorScheme = resolved
}

export function cycleTheme(theme: Theme): Theme {
  if (theme === 'system') return 'light'
  if (theme === 'light') return 'dark'
  return 'system'
}

export function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
