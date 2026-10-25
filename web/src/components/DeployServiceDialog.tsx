import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../i18n'
import '../styles/ops.css'
import '../styles/models.css'

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/

export default function DeployServiceDialog({
  open,
  initialName,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean
  initialName: string
  busy?: boolean
  error?: string
  onSubmit: (name: string, replicas: number) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const titleId = useId()
  const [name, setName] = useState(initialName)
  const [replicas, setReplicas] = useState(1)

  useEffect(() => {
    if (open) {
      setName(initialName)
      setReplicas(1)
    }
  }, [open, initialName])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  if (!open) return null
  const valid = NAME_RE.test(name)

  return createPortal(
    <div
      className="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] p-4"
      data-open="true"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal-dialog ops-confirm w-full rounded-[var(--radius-xl)] border border-[var(--line)] bg-[var(--bg-surface)] shadow-[var(--shadow-lg)]"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid && !busy) onSubmit(name, replicas)
        }}
      >
        <div className="ops-confirm-head">
          <h2 id={titleId} className="ops-confirm-title">
            {t('svcDeployTitle')}
          </h2>
          <p className="ops-confirm-desc">{t('svcDeployDesc')}</p>
        </div>
        <div className="ops-confirm-match svc-deploy-fields">
          <label className="label">
            {t('svcDeployName')}
            <input
              autoFocus
              className={`field mono${name && !valid ? ' is-error' : ''}`}
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              disabled={busy}
              spellCheck={false}
            />
          </label>
          <div className="label">
            {t('svcDeployReplicas')}
            <div className="runs-kind svc-replica-pick" role="group" aria-label={t('svcDeployReplicas')}>
              {[1, 2, 3].map((n) => (
                <button key={n} type="button" aria-pressed={replicas === n} disabled={busy} onClick={() => setReplicas(n)}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          {error && <p className="flash flash-err register-err">{error}</p>}
        </div>
        <div className="ops-confirm-actions">
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-ghost btn-sm">
            {t('confirmCancel')}
          </button>
          <button type="submit" disabled={busy || !valid} className="btn btn-primary btn-sm">
            {busy ? t('svcDeploying') : t('svcDeploySubmit')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
