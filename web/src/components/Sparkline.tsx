import { useId } from 'react'

/** Axis-free trend line. `live` adds a pulsing head on the latest point. */
export default function Sparkline({
  points,
  live = false,
  width = 96,
  height = 26,
}: {
  points: number[]
  live?: boolean
  width?: number
  height?: number
}) {
  const gid = useId()
  if (points.length < 2) return null
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const pad = 3
  const xy = points.map((v, i) => [
    pad + (i / (points.length - 1)) * (width - pad * 2),
    pad + (1 - (v - min) / span) * (height - pad * 2),
  ])
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const [hx, hy] = xy[xy.length - 1]
  const area = `${pad},${height} ${line} ${hx.toFixed(1)},${height}`

  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={hx} cy={hy} r="2.2" fill="var(--accent)" className={live ? 'sparkline-head is-live' : 'sparkline-head'} />
    </svg>
  )
}
