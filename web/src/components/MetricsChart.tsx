import { useMemo, useState } from 'react'
import { parseApiDate, useI18n } from '../i18n'

type Point = Record<string, number>

const COLORS = ['#3ecf8e', '#e6b84d', '#6cb6ff', '#e36d6d', '#c79bff']

function formatWallClock(ts: number): string {
  // Unix seconds → local wall clock (MLflow/TensorBoard "Wall" style in tooltip)
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 0.1
    min -= pad
    max += pad
  }
  const span = max - min
  const step = span / count
  const ticks: number[] = []
  for (let i = 0; i <= count; i++) ticks.push(min + step * i)
  return ticks
}

function fmt(n: number) {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 100) return n.toFixed(0)
  if (Math.abs(n) >= 10) return n.toFixed(1)
  return n.toFixed(3)
}

export default function MetricsChart({
  series,
  keys,
  xKey = 'epoch',
  xLabel = 'Epoch',
  wallTsKey = 'ts',
  /** Fallback origin (unix seconds or ISO date) when points lack absolute ts */
  wallOrigin,
}: {
  series: Point[]
  keys: string[]
  xKey?: string
  xLabel?: string
  /** Absolute unix timestamp field; when present, tooltip also shows wall clock */
  wallTsKey?: string
  wallOrigin?: number | string | null
}) {
  const { t } = useI18n()
  const [hover, setHover] = useState<number | null>(null)

  const originUnix = useMemo(() => {
    if (wallOrigin == null || wallOrigin === '') return null
    if (typeof wallOrigin === 'number' && Number.isFinite(wallOrigin)) {
      return wallOrigin < 1e12 ? wallOrigin : wallOrigin / 1000
    }
    const d = parseApiDate(String(wallOrigin))
    const ms = d.getTime()
    return Number.isFinite(ms) ? ms / 1000 : null
  }, [wallOrigin])

  const model = useMemo(() => {
    if (!series.length || !keys.length) return null
    const w = 640
    const h = 280
    const padL = 52
    const padR = 18
    const padT = 18
    const padB = 42
    const plotW = w - padL - padR
    const plotH = h - padT - padB

    const xs = series.map((p, i) =>
      Number.isFinite(Number(p[xKey])) ? Number(p[xKey]) : i + 1,
    )
    const xMin = Math.min(...xs)
    const xMax = Math.max(...xs)
    const xSpan = xMax - xMin || 1

    const allVals = keys.flatMap((k) =>
      series.map((p) => Number(p[k])).filter((n) => Number.isFinite(n)),
    )
    if (!allVals.length) return null
    let yMin = Math.min(...allVals)
    let yMax = Math.max(...allVals)
    // pad vertical range so lines aren't glued to edges
    const pad = (yMax - yMin) * 0.08 || 0.05
    yMin -= pad
    yMax += pad
    // keep [0,1]-ish metrics readable
    if (yMin > 0 && yMin < 0.2) yMin = 0
    if (yMax < 1 && yMax > 0.8) yMax = Math.min(1, yMax + 0.02)

    const xTicks = niceTicks(xMin, xMax, Math.min(series.length - 1, 6) || 1)
    const yTicks = niceTicks(yMin, yMax, 4)

    const px = (x: number) => padL + ((x - xMin) / xSpan) * plotW
    const py = (y: number) => padT + (1 - (y - yMin) / (yMax - yMin || 1)) * plotH

    const lines = keys.map((key, ki) => {
      const pts = series
        .map((p, i) => {
          const v = Number(p[key])
          if (!Number.isFinite(v)) return null
          return { i, x: px(xs[i]), y: py(v), v, xv: xs[i] }
        })
        .filter(Boolean) as { i: number; x: number; y: number; v: number; xv: number }[]
      return { key, color: COLORS[ki % COLORS.length], pts }
    })

    return { w, h, padL, padR, padT, padB, plotW, plotH, xTicks, yTicks, lines, xs, px, py }
  }, [series, keys, xKey])

  if (!model) return null

  const { w, h, padL, padT, padB, plotW, plotH, xTicks, yTicks, lines, xs, px } = model

  return (
    <div className="space-y-2">
      <div className="relative w-full max-w-3xl">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="w-full rounded border border-[var(--line)] bg-black/30"
          onMouseLeave={() => setHover(null)}
        >
          {/* grid + axes */}
          {yTicks.map((t) => {
            const y = model.py(t)
            return (
              <g key={`y-${t}`}>
                <line
                  x1={padL}
                  x2={padL + plotW}
                  y1={y}
                  y2={y}
                  stroke="rgba(138,163,152,0.18)"
                  strokeDasharray="3 3"
                />
                <text
                  x={padL - 8}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-[var(--muted)]"
                  style={{ fontSize: 10, fontFamily: 'IBM Plex Mono, monospace' }}
                >
                  {fmt(t)}
                </text>
              </g>
            )
          })}
          {xTicks.map((t) => {
            const x = px(t)
            return (
              <g key={`x-${t}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={padT}
                  y2={padT + plotH}
                  stroke="rgba(138,163,152,0.1)"
                />
                <text
                  x={x}
                  y={h - padB + 16}
                  textAnchor="middle"
                  className="fill-[var(--muted)]"
                  style={{ fontSize: 10, fontFamily: 'IBM Plex Mono, monospace' }}
                >
                  {Number.isInteger(t) ? String(Math.round(t)) : fmt(t)}
                </text>
              </g>
            )
          })}

          {/* axis lines */}
          <line
            x1={padL}
            y1={padT}
            x2={padL}
            y2={padT + plotH}
            stroke="rgba(138,163,152,0.45)"
          />
          <line
            x1={padL}
            y1={padT + plotH}
            x2={padL + plotW}
            y2={padT + plotH}
            stroke="rgba(138,163,152,0.45)"
          />
          <text
            x={padL + plotW / 2}
            y={h - 8}
            textAnchor="middle"
            className="fill-[var(--muted)]"
            style={{ fontSize: 11 }}
          >
            {xLabel}
          </text>

          {/* series */}
          {lines.map((line) => (
            <g key={line.key}>
              <polyline
                fill="none"
                stroke={line.color}
                strokeWidth="2.25"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={line.pts.map((p) => `${p.x},${p.y}`).join(' ')}
              />
              {line.pts.map((p) => (
                <circle
                  key={`${line.key}-${p.i}`}
                  cx={p.x}
                  cy={p.y}
                  r={hover === p.i ? 4.5 : 3}
                  fill={line.color}
                  stroke="var(--bg)"
                  strokeWidth="1"
                />
              ))}
            </g>
          ))}

          {/* hover guide */}
          {hover != null && xs[hover] != null && (
            <line
              x1={px(xs[hover])}
              x2={px(xs[hover])}
              y1={padT}
              y2={padT + plotH}
              stroke="rgba(62,207,142,0.45)"
              strokeDasharray="4 3"
            />
          )}

          {/* invisible hit targets */}
          {series.map((_, i) => (
            <rect
              key={`hit-${i}`}
              x={px(xs[i]) - plotW / series.length / 2}
              y={padT}
              width={Math.max(plotW / series.length, 12)}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>

        {hover != null && series[hover] && (() => {
          const pt = series[hover]
          const rel = Number.isFinite(Number(pt[xKey])) ? Number(pt[xKey]) : hover + 1
          let wallTs = Number(pt[wallTsKey])
          if (!(Number.isFinite(wallTs) && wallTs > 1e9) && originUnix != null) {
            wallTs = originUnix + rel
          }
          const wall =
            Number.isFinite(wallTs) && wallTs > 1e9 ? formatWallClock(wallTs) : ''
          const xHeader = wall
            ? t('timeRelWall').replace('{rel}', String(rel)).replace('{wall}', wall)
            : `${xLabel} ${rel}`
          return (
            <div className="pointer-events-none absolute top-3 right-3 rounded border border-[var(--line)] bg-[var(--panel)]/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
              <div className="mb-1 mono text-[var(--muted)]">{xHeader}</div>
              {keys.map((k, ki) => (
                <div key={k} className="flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: COLORS[ki % COLORS.length] }}
                  />
                  <span className="text-[var(--muted)]">{k}</span>
                  <span className="mono text-[var(--text)]">
                    {Number.isFinite(Number(pt[k])) ? fmt(Number(pt[k])) : '—'}
                  </span>
                </div>
              ))}
            </div>
          )
        })()}
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-[var(--muted)]">
        {keys.map((key, ki) => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: COLORS[ki % COLORS.length] }}
            />
            {key}
          </span>
        ))}
      </div>
    </div>
  )
}
