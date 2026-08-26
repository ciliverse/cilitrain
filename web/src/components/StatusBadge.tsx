type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral'

const map: Record<string, Tone> = {
  succeeded: 'success',
  running: 'warning',
  pending: 'info',
  failed: 'error',
  timeout: 'error',
  cancelled: 'neutral',
}

export function statusTone(status: string): Tone {
  return map[status] || 'neutral'
}

export default function StatusBadge({
  status,
  label,
}: {
  status: string
  label?: string
}) {
  const tone = statusTone(status)
  const text = label || status
  return (
    <span className={`badge badge-dot badge-${tone}`} data-status={status} title={text}>
      {text}
    </span>
  )
}
