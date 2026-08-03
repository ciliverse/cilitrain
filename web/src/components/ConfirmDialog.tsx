import { useEffect, useId, useState } from 'react'

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
  const titleId = useId()
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (open) setTyped('')
  }, [open, requireText])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  if (!open) return null

  const needMatch = Boolean(requireText)
  const matched = !needMatch || typed.trim() === requireText
  const border =
    tone === 'danger' ? 'border-[var(--danger)]/55' : 'border-[var(--warn)]/55'
  const badge =
    tone === 'danger'
      ? 'bg-[var(--danger)]/15 text-[var(--danger)]'
      : 'bg-[var(--warn)]/15 text-[var(--warn)]'
  const confirmBtn =
    tone === 'danger'
      ? 'bg-[var(--danger)] text-white hover:brightness-110'
      : 'bg-[var(--warn)] text-black hover:brightness-110'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full max-w-md rounded-lg border ${border} bg-[var(--panel)] shadow-[0_20px_60px_rgba(0,0,0,0.55)]`}
      >
        <div className="border-b border-[var(--line)] px-5 py-4">
          <div className="mb-2">
            <span className={`rounded px-2 py-0.5 text-[11px] font-bold tracking-wide uppercase ${badge}`}>
              {tone === 'danger' ? 'DANGER' : 'WARNING'}
            </span>
          </div>
          <h2 id={titleId} className="text-lg font-bold text-[var(--text)]">
            {title}
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--muted)]">
            {description}
          </p>
        </div>

        {needMatch && (
          <div className="border-b border-[var(--line)] px-5 py-4">
            <label className="block text-sm text-[var(--muted)]">
              {requireHint}
              <span className="mono ml-1 font-semibold text-[var(--danger)]">{requireText}</span>
            </label>
            <input
              autoFocus
              className="mono mt-2 w-full rounded border border-[var(--danger)]/40 bg-black/30 px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--danger)]"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={requireText}
              disabled={busy}
            />
          </div>
        )}

        <div className="flex justify-end gap-2 px-5 py-4">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy || !matched}
            onClick={onConfirm}
            className={`rounded px-3 py-1.5 text-sm font-semibold disabled:opacity-40 ${confirmBtn}`}
          >
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
