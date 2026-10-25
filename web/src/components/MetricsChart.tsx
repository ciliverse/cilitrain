import { useId, useMemo, useState, type MouseEvent } from 'react'
import { parseApiDate, useI18n } from '../i18n'

type Point = Record<string, number>

// Ordered for hue distance: adjacent series must never read as the same color.
const RAMP = ['var(--accent)', 'var(--warn)', 'var(--success)', 'var(--danger)', 'var(--info)']

/** Resource keys are pinned so CPU and memory keep one hue across the page. */
const KEY_COLORS: Record<string, string> = {
  cpu_m: 'var(--accent)',
  memory_mi: 'var(--info)',
}

function colorFor(key: string, index: number): string {
  return KEY_COLORS[key] || RAMP[index % RAMP.length]
}

function formatWallClock(ts: number): string {
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

/** Ticks land on 1 / 2 / 2.5 / 5 x 10^n so labels read as round numbers. */
function niceTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 0.1
    min -= pad
    max += pad
  }
  const raw = (max - min) / Math.max(1, target)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  while (step > 0 && (max - min) / step < 3) step /= 2
  const start = Math.ceil(min / step) * step
  const ticks: number[] = []
  for (let v = start; v <= max + step * 1e-6; v += step) {
    ticks.push(Number(v.toFixed(10)))
  }
  return ticks.length >= 2 ? ticks : [min, max]
}

function integerTicks(min: number, max: number, target = 6): number[] {
  const span = max - min
  if (span <= target) {
    const out: number[] = []
    for (let v = Math.ceil(min); v <= max; v++) out.push(v)
    return out.length ? out : [min]
  }
  return niceTicks(min, max, target).filter((v) => Number.isInteger(v))
}

function fmt(n: number) {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1000) return n.toFixed(0)
  if (abs >= 100) return n.toFixed(1)
  if (abs >= 1) return n.toFixed(2)
  return n.toFixed(3)
}

export function nextLegendHidden(
  keys: string[],
  prev: Set<string>,
  key: string,
  toggle: boolean,
): Set<string> {
  if (toggle) {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else {
      next.add(key)
      if (keys.every((k) => next.has(k))) next.delete(key)
    }
    return next
  }
  const othersOff = keys.filter((k) => k !== key).every((k) => prev.has(k))
  const thisOn = !prev.has(key)
  if (thisOn && othersOff) return new Set()
  return new Set(keys.filter((k) => k !== key))
}

function lastFinite(series: Point[], key: string): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = Number(series[i][key])
    if (Number.isFinite(v)) return v
  }
  return null
}

export default function MetricsChart({
  series,
  keys,
  xKey = 'epoch',
  xLabel = 'Epoch',
  wallTsKey = 'ts',
  wallOrigin,
  hidden: hiddenProp,
  onHiddenChange,
}: {
  series: Point[]
  keys: string[]
  xKey?: string
  xLabel?: string
  wallTsKey?: string
  wallOrigin?: number | string | null
  hidden?: Set<string>
  onHiddenChange?: (next: Set<string>) => void
}) {
  const { t } = useI18n()
  const areaId = useId()
  const [hover, setHover] = useState<number | null>(null)
  const [hiddenLocal, setHiddenLocal] = useState<Set<string>>(() => new Set())
  const hidden = hiddenProp ?? hiddenLocal
  const setHidden = onHiddenChange ?? setHiddenLocal

  const originUnix = useMemo(() => {
    if (wallOrigin == null || wallOrigin === '') return null
    if (typeof wallOrigin === 'number' && Number.isFinite(wallOrigin)) {
      return wallOrigin < 1e12 ? wallOrigin : wallOrigin / 1000
    }
    const ms = parseApiDate(String(wallOrigin)).getTime()
    return Number.isFinite(ms) ? ms / 1000 : null
  }, [wallOrigin])

  const visibleKeys = useMemo(() => {
    const on = keys.filter((k) => !hidden.has(k))
    return on.length ? on : keys
  }, [keys, hidden])

  const model = useMemo(() => {
    if (!series.length || !visibleKeys.length) return null
    const w = 720
    const h = 176
    const padL = 44
    const padR = 12
    const padT = 8
    const padB = 22
    const plotW = w - padL - padR
    const plotH = h - padT - padB

    const xs = series.map((p, i) => (Number.isFinite(Number(p[xKey])) ? Number(p[xKey]) : i + 1))
    const xMin = Math.min(...xs)
    const xMax = Math.max(...xs)
    const xSpan = xMax - xMin || 1

    const allVals = visibleKeys.flatMap((k) =>
      series.map((p) => Number(p[k])).filter((n) => Number.isFinite(n)),
    )
    if (!allVals.length) return null

    let yMin = Math.min(...allVals)
    let yMax = Math.max(...allVals)
    const resource = visibleKeys.includes('cpu_m') || visibleKeys.includes('memory_mi')
    if (resource) {
      yMin = 0
      const floor = visibleKeys.includes('cpu_m') ? 100 : 64
      yMax = Math.max(floor, yMax * 1.15 || floor)
    } else {
      const pad = (yMax - yMin) * 0.12 || 0.05
      yMin -= pad
      yMax += pad
      if (yMin > 0 && yMin < 0.2) yMin = 0
      if (yMax < 1 && yMax > 0.85) yMax = 1
    }

    const yTicks = niceTicks(yMin, yMax, 4)
    const yLo = Math.min(yMin, yTicks[0])
    const yHi = Math.max(yMax, yTicks[yTicks.length - 1])
    const xTicks =
      xs.every((v) => Number.isInteger(v)) && xMax - xMin <= 12
        ? integerTicks(xMin, xMax, series.length > 8 ? 6 : series.length)
        : niceTicks(xMin, xMax, 4)

    const px = (x: number) => padL + ((x - xMin) / xSpan) * plotW
    const py = (y: number) => padT + (1 - (y - yLo) / (yHi - yLo || 1)) * plotH

    const lines = visibleKeys
      .map((key) => {
        const ki = keys.indexOf(key)
        const pts = series
          .map((p, i) => {
            const v = Number(p[key])
            if (!Number.isFinite(v)) return null
            return { i, x: px(xs[i]), y: py(v), v }
          })
          .filter(Boolean) as { i: number; x: number; y: number; v: number }[]
        return { key, color: colorFor(key, ki < 0 ? 0 : ki), pts }
      })
      .filter((l) => l.pts.length > 0)

    return { w, h, padL, padR, padT, padB, plotW, plotH, xTicks, yTicks, lines, xs, px, py }
  }, [series, keys, visibleKeys, xKey])

  function onLegendClick(key: string, e: MouseEvent) {
    e.preventDefault()
    setHidden(nextLegendHidden(keys, hidden, key, e.metaKey || e.ctrlKey))
  }

  if (!model) {
    return <p className="chart-empty">{t('chartEmpty')}</p>
  }

  const { w, h, padL, padT, padB, plotW, plotH, xTicks, yTicks, lines, xs, px, py } = model
  const hoverPt = hover != null ? lines.map((l) => l.pts.find((p) => p.i === hover)).find(Boolean) : null

  return (
    <div className="chart">
      <div className="chart-plot">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          role="img"
          aria-label={`${visibleKeys.join(', ')} / ${xLabel}`}
          onMouseLeave={() => setHover(null)}
        >
          {yTicks.map((v) => (
            <g key={`y-${v}`}>
              <line
                x1={padL}
                x2={padL + plotW}
                y1={py(v)}
                y2={py(v)}
                className="chart-gridline"
              />
              <text x={padL - 8} y={py(v) + 3.5} textAnchor="end" className="chart-tick">
                {fmt(v)}
              </text>
            </g>
          ))}

          {xTicks.map((v) => (
            <text key={`x-${v}`} x={px(v)} y={h - padB + 14} textAnchor="middle" className="chart-tick">
              {Number.isInteger(v) ? String(v) : fmt(v)}
            </text>
          ))}

          <line
            x1={padL}
            y1={padT + plotH}
            x2={padL + plotW}
            y2={padT + plotH}
            className="chart-axis"
          />

          {hover != null && xs[hover] != null && (
            <line
              x1={px(xs[hover])}
              x2={px(xs[hover])}
              y1={padT}
              y2={padT + plotH}
              className="chart-crosshair"
            />
          )}

          {lines[0] && lines[0].pts.length > 1 && (
            <>
              <defs>
                <linearGradient id={areaId} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={lines[0].color} stopOpacity="0.2" />
                  <stop offset="100%" stopColor={lines[0].color} stopOpacity="0" />
                </linearGradient>
              </defs>
              <polygon
                fill={`url(#${areaId})`}
                points={[
                  `${lines[0].pts[0].x},${padT + plotH}`,
                  ...lines[0].pts.map((p) => `${p.x},${p.y}`),
                  `${lines[0].pts[lines[0].pts.length - 1].x},${padT + plotH}`,
                ].join(' ')}
              />
            </>
          )}

          {lines.map((line) => (
            <g key={line.key}>
              <polyline
                fill="none"
                stroke={line.color}
                strokeWidth="1.8"
                strokeDasharray={line.key.startsWith('val_') ? '5 4' : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={line.pts.map((p) => `${p.x},${p.y}`).join(' ')}
              />
              {line.key.startsWith('val_') &&
                line.pts.map((p) => (
                  <circle key={`${line.key}-${p.i}`} cx={p.x} cy={p.y} r="2" fill={line.color} />
                ))}
              {hoverPt &&
                line.pts
                  .filter((p) => p.i === hover)
                  .map((p) => (
                    <circle
                      key={`${line.key}-h`}
                      cx={p.x}
                      cy={p.y}
                      r="3.2"
                      fill={line.color}
                      stroke="var(--panel)"
                      strokeWidth="1.4"
                    />
                  ))}
            </g>
          ))}

          {series.map((_, i) => (
            <rect
              key={`hit-${i}`}
              x={px(xs[i]) - plotW / series.length / 2}
              y={padT}
              width={Math.max(plotW / series.length, 10)}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>

        {hover != null && series[hover] && (
          <ChartTip
            series={series}
            hover={hover}
            keys={keys}
            visibleKeys={visibleKeys}
            xKey={xKey}
            xLabel={xLabel}
            wallTsKey={wallTsKey}
            originUnix={originUnix}
            leftPct={(px(xs[hover]) / w) * 100}
          />
        )}
      </div>

      <div className="chart-legend" title={t('chartLegendHint')}>
        {keys.map((key, ki) => {
          const last = lastFinite(series, key)
          const off = hidden.has(key) && visibleKeys.length !== keys.length
          const isolated = hidden.size > 0 && !hidden.has(key) && hidden.size === keys.length - 1
          const name = labelFor(key, t)
          return (
            <button
              key={key}
              type="button"
              className="chart-legend-item"
              data-off={off ? 'true' : undefined}
              data-on={isolated ? 'true' : undefined}
              aria-pressed={!off}
              aria-label={`${name} ${last == null ? '' : fmt(last)}`}
              onClick={(e) => onLegendClick(key, e)}
            >
              <span className="chart-series-mark" style={{ background: colorFor(key, ki) }} />
              <span className="chart-legend-name">{labelFor(key, t)}</span>
              <span className="chart-legend-last mono">{last == null ? '—' : fmt(last)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ChartTip({
  series,
  hover,
  keys,
  visibleKeys,
  xKey,
  xLabel,
  wallTsKey,
  originUnix,
  leftPct,
}: {
  series: Point[]
  hover: number
  keys: string[]
  visibleKeys: string[]
  xKey: string
  xLabel: string
  wallTsKey: string
  originUnix: number | null
  leftPct: number
}) {
  const { t } = useI18n()
  const pt = series[hover]
  const rel = Number.isFinite(Number(pt[xKey])) ? Number(pt[xKey]) : hover + 1
  let wallTs = Number(pt[wallTsKey])
  if (!(Number.isFinite(wallTs) && wallTs > 1e9) && originUnix != null) {
    wallTs = originUnix + rel
  }
  const wall = Number.isFinite(wallTs) && wallTs > 1e9 ? formatWallClock(wallTs) : ''
  const header = wall
    ? t('timeRelWall').replace('{rel}', String(rel)).replace('{wall}', wall)
    : `${xLabel} ${rel}`
  const flip = leftPct > 62
  const showKeys = visibleKeys.length ? visibleKeys : keys
  return (
    <div className="chart-tip" data-flip={flip ? 'true' : 'false'} style={{ left: `${leftPct}%` }}>
      <div className="chart-tip-head mono">{header}</div>
      {showKeys.map((k) => {
        const ki = keys.indexOf(k)
        return (
          <div key={k} className="chart-tip-row">
            <span className="chart-series-mark" style={{ background: colorFor(k, ki) }} />
            <span className="chart-tip-key">{labelFor(k, t)}</span>
            <span className="chart-tip-val mono">
              {Number.isFinite(Number(pt[k])) ? fmt(Number(pt[k])) : '—'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function labelFor(key: string, t: (k: 'cpuMilli' | 'memMi') => string): string {
  if (key === 'cpu_m') return t('cpuMilli')
  if (key === 'memory_mi') return t('memMi')
  return key
}
