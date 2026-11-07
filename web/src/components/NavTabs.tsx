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
  { to: '/observe', key: 'navObserve' as const },
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

function scrollActiveIntoView(root: HTMLElement, scroller: HTMLElement) {
  const active = root.querySelector('a.tab.active') as HTMLElement | null
  if (!active) return
  const a = active.getBoundingClientRect()
  const s = scroller.getBoundingClientRect()
  const pad = 28
  if (a.left < s.left + pad) {
    scroller.scrollLeft -= s.left + pad - a.left
  } else if (a.right > s.right - pad) {
    scroller.scrollLeft += a.right - (s.right - pad)
  }
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  const d = dir === 'left' ? 'M10 3.5 5.5 8 10 12.5' : 'M6 3.5 10.5 8 6 12.5'
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
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
  const scrollerRef = useRef<HTMLDivElement>(null)
  const pathRef = useRef(loc.pathname)
  const [clip, setClip] = useState<Clip | null>(null)
  const [edges, setEdges] = useState({ left: false, right: false })

  function syncEdges() {
    const scroller = scrollerRef.current
    if (!scroller) return
    const max = scroller.scrollWidth - scroller.clientWidth
    const left = scroller.scrollLeft > 8
    const right = max - scroller.scrollLeft > 8
    scroller.toggleAttribute('data-more-left', left)
    scroller.toggleAttribute('data-more-right', right)
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
  }

  useLayoutEffect(() => {
    const root = rootRef.current
    const scroller = scrollerRef.current
    if (!root || !scroller) return
    const pathChanged = pathRef.current !== loc.pathname
    pathRef.current = loc.pathname
    const next = readClip(root, pathChanged)
    if (next) setClip(next)
    scrollActiveIntoView(root, scroller)
    syncEdges()
  }, [loc.pathname, lang])

  useLayoutEffect(() => {
    const root = rootRef.current
    const scroller = scrollerRef.current
    if (!root || !scroller) return
    const onResize = () => {
      const next = readClip(root, false)
      if (next) setClip(next)
      syncEdges()
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(root)
    ro.observe(scroller)
    root.querySelectorAll('a.tab').forEach((el) => ro.observe(el))
    scroller.addEventListener('scroll', syncEdges, { passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      ro.disconnect()
      scroller.removeEventListener('scroll', syncEdges)
      window.removeEventListener('resize', onResize)
    }
  }, [lang])

  function scrollByDir(dir: -1 | 1) {
    const scroller = scrollerRef.current
    const root = rootRef.current
    if (!scroller || !root) return
    const max = scroller.scrollWidth - scroller.clientWidth
    const viewLeft = scroller.getBoundingClientRect().left
    const origins = [...root.querySelectorAll('a.tab')].map(
      (tab) => scroller.scrollLeft + tab.getBoundingClientRect().left - viewLeft,
    )
    const step = Math.max(96, scroller.clientWidth * 0.72)
    const desired = Math.min(max, Math.max(0, scroller.scrollLeft + dir * step))
    const forward = origins.filter((x) =>
      dir > 0 ? x > scroller.scrollLeft + 4 && x <= max : x < scroller.scrollLeft - 4 && x >= 0,
    )
    const next = forward.reduce<number | null>((best, x) => {
      if (best == null) return x
      return Math.abs(x - desired) < Math.abs(best - desired) ? x : best
    }, null)
    let landed = next == null ? desired : next
    if (landed <= 8) landed = 0
    if (max - landed <= 8) landed = max
    scroller.scrollLeft = landed
  }

  const clipPath = clip?.ready
    ? `inset(${clip.top}px ${clip.right}px ${clip.bottom}px ${clip.left}px round 999px)`
    : 'inset(0 100% 0 0 round 999px)'

  return (
    <>
      <button
        type="button"
        className="nav-hint is-left"
        aria-label={t('navScrollPrev')}
        disabled={!edges.left}
        onClick={() => scrollByDir(-1)}
      >
        <Chevron dir="left" />
      </button>
      <div className="nav-scroller" ref={scrollerRef}>
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
      </div>
      <button
        type="button"
        className="nav-hint is-right"
        aria-label={t('navScrollNext')}
        disabled={!edges.right}
        onClick={() => scrollByDir(1)}
      >
        <Chevron dir="right" />
      </button>
    </>
  )
}
