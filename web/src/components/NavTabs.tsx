import { useLayoutEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useI18n } from '../i18n'

const LINKS = [
  { to: '/', end: true, key: 'navRuns' as const },
  { to: '/new', key: 'navNew' as const },
  { to: '/scheduler', key: 'navScheduler' as const },
  { to: '/models', key: 'navModels' as const },
  { to: '/services', key: 'navServices' as const },
  { to: '/pipelines', key: 'navPipelines' as const },
  { to: '/compare', key: 'navCompare' as const },
  { to: '/clusters', key: 'navClusters' as const },
  { to: '/settings', key: 'navSettings' as const },
]

type Clip = {
  top: number
  right: number
  bottom: number
  left: number
  ready: boolean
  animate: boolean
}

function readClip(root: HTMLElement, animate: boolean): Clip | null {
  const active = root.querySelector('a.tab.active') as HTMLElement | null
  if (!active) return null
  const r = active.getBoundingClientRect()
  const p = root.getBoundingClientRect()
  return {
    top: r.top - p.top,
    right: p.right - r.right,
    bottom: p.bottom - r.bottom,
    left: r.left - p.left,
    ready: true,
    animate,
  }
}

export default function NavTabs() {
  const { t, lang } = useI18n()
  const loc = useLocation()
  const rootRef = useRef<HTMLDivElement>(null)
  const pathRef = useRef(loc.pathname)
  const [clip, setClip] = useState<Clip | null>(null)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const pathChanged = pathRef.current !== loc.pathname
    pathRef.current = loc.pathname
    const next = readClip(root, pathChanged)
    if (next) setClip(next)
  }, [loc.pathname, lang])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onResize = () => {
      const next = readClip(root, false)
      if (next) setClip(next)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(root)
    root.querySelectorAll('a.tab').forEach((el) => ro.observe(el))
    window.addEventListener('resize', onResize)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [lang])

  const clipPath = clip?.ready
    ? `inset(${clip.top}px ${clip.right}px ${clip.bottom}px ${clip.left}px round 999px)`
    : 'inset(0 100% 0 0 round 999px)'

  return (
    <div className="tabs" ref={rootRef}>
      <div
        className="tabs-active"
        data-ready={Boolean(clip?.ready)}
        data-animate={Boolean(clip?.animate)}
        style={{ clipPath }}
        aria-hidden
      >
        {LINKS.map((item) => (
          <span key={item.to} className="tab">
            {t(item.key)}
          </span>
        ))}
      </div>
      {LINKS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
        >
          {t(item.key)}
        </NavLink>
      ))}
    </div>
  )
}
