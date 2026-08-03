type Point = Record<string, number>

export default function MetricsChart({
  series,
  keys,
}: {
  series: Point[]
  keys: string[]
}) {
  if (!series.length || !keys.length) {
    return null
  }
  const w = 520
  const h = 180
  const pad = 28
  const colors = ['#3ecf8e', '#e6b84d', '#6cb6ff', '#e36d6d', '#c79bff']

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-xl rounded border border-[var(--line)] bg-black/25">
        {keys.map((key, ki) => {
          const vals = series.map((p) => Number(p[key])).filter((n) => Number.isFinite(n))
          if (!vals.length) return null
          const min = Math.min(...vals)
          const max = Math.max(...vals)
          const span = max - min || 1
          const pts = series
            .map((p, i) => {
              const v = Number(p[key])
              if (!Number.isFinite(v)) return null
              const x = pad + (i / Math.max(series.length - 1, 1)) * (w - pad * 2)
              const y = h - pad - ((v - min) / span) * (h - pad * 2)
              return `${x},${y}`
            })
            .filter(Boolean)
            .join(' ')
          return (
            <polyline
              key={key}
              fill="none"
              stroke={colors[ki % colors.length]}
              strokeWidth="2"
              points={pts}
            />
          )
        })}
      </svg>
      <div className="flex flex-wrap gap-3 text-xs text-[var(--muted)]">
        {keys.map((key, ki) => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: colors[ki % colors.length] }}
            />
            {key}
          </span>
        ))}
      </div>
    </div>
  )
}
