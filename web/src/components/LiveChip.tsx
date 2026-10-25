import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'

/** Shows that a page polls by itself, how stale the data is, and lets the user pause. */
export default function LiveChip({
  active,
  paused,
  lastSync,
  onToggle,
  onRefresh,
}: {
  active: boolean
  paused: boolean
  lastSync: number | null
  onToggle: () => void
  onRefresh: () => void
}) {
  const { t } = useI18n()
  const [, tick] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [])

  const age = lastSync == null ? null : Math.max(0, Math.round((Date.now() - lastSync) / 1000))

  return (
    <span className="live-chip" data-live={active && !paused ? 'true' : 'false'}>
      <span className="live-dot" aria-hidden="true" />
      <span className="live-label">{paused ? t('livePaused') : t('liveOn')}</span>
      {age != null && (
        <span className="live-age mono">{t('lastUpdated').replace('{n}', String(age))}</span>
      )}
      <button type="button" className="live-btn" onClick={onRefresh} title={t('refreshNow')}>
        {t('refreshNow')}
      </button>
      <button
        type="button"
        className="live-btn"
        onClick={onToggle}
        title={paused ? t('liveResume') : t('livePause')}
      >
        {paused ? t('liveResume') : t('livePause')}
      </button>
    </span>
  )
}
