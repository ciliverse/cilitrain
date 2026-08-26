import { useEffect, useId, useState } from 'react'
import { useI18n } from '../i18n'
import '../styles/ops.css'

type Tone = 'danger' | 'warn'

type Props = {
  open: boolean
  tone?: Tone
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  /** When set, user must type this exact string to enable confirm (GitHub-style). */
  requireText?: string
  requireHint?: string
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}

export default function ConfirmDialog({
  open,
  tone = 'danger',
  title,
  description,
  confirmLabel,
  cancelLabel,
  requireText,
  requireHint,
  busy,
  onConfirm,
  onClose,
}: Props) {
  const { t } = useI18n()
  const titleId = useId()
  const [typed, setTyped] = useState('')
  const [shown, setShown] = useState(open)
  const [visible, setVisible] = useState(open)

  useEffect(() => {
    if (open) {
      setShown(true)
      setTyped('')
      const id = window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => setVisible(true))
      })
      return () => window.cancelAnimationFrame(id)
    }
    setVisible(false)
    const id = window.setTimeout(() => setShown(false), 160)
    return () => window.clearTimeout(id)
  }, [open, requireText])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  if (!shown) return null

  const needMatch = Boolean(requireText)
  const matched = !needMatch || typed.trim() === requireText
  const border =
    tone === 'danger' ? 'border-[var(--danger)]/55' : 'border-[var(--warn)]/55'
  const badge =
    tone === 'danger'
      ? 'ops-confirm-tone bg-[var(--danger)]/15 text-[var(--danger)]'
      : 'ops-confirm-tone bg-[var(--warn)]/15 text-[var(--warn)]'
  const confirmBtn = tone === 'danger' ? 'btn btn-danger btn-sm' : 'btn btn-warn btn-sm'

  return (
    <div
      className="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] p-4"
      data-open={visible}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`modal-dialog ops-confirm w-full rounded-[var(--radius-xl)] border ${border} bg-[var(--bg-surface)] shadow-[var(--shadow-lg)]`}
      >
        <div className="ops-confirm-head">
          <span className={badge}>{tone === 'danger' ? t('confirmDanger') : t('confirmWarning')}</span>
          <h2 id={titleId} className="ops-confirm-title">
            {title}
          </h2>
          <p className="ops-confirm-desc">{description}</p>
        </div>

        {needMatch && (
          <div className="ops-confirm-match">
            <label className="label">
              {requireHint}
              <span className="mono ml-1 font-semibold text-[var(--danger)]">{requireText}</span>
            </label>
            <input
              autoFocus
              className="field mono border-[var(--danger)]/40 focus:border-[var(--danger)]"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={requireText}
              disabled={busy}
            />
          </div>
        )}

        <div className="ops-confirm-actions">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="btn btn-ghost btn-sm"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy || !matched}
            onClick={onConfirm}
            className={confirmBtn}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
