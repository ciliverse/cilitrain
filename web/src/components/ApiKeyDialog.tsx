import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../i18n'
import '../styles/ops.css'
import '../styles/models.css'

export default function ApiKeyDialog({ apiKey, onClose }: { apiKey: string | null; onClose: () => void }) {
  const { t } = useI18n()
  const titleId = useId()
  const [copied, setCopied] = useState(false)

  useEffect(() => setCopied(false), [apiKey])

  if (!apiKey) return null

  async function copy() {
    await navigator.clipboard.writeText(apiKey || '')
    setCopied(true)
  }

  return createPortal(
    <div
      className="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] p-4"
      data-open="true"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal-dialog ops-confirm w-full rounded-[var(--radius-xl)] border border-[var(--line)] bg-[var(--bg-surface)] shadow-[var(--shadow-lg)]"
      >
        <div className="ops-confirm-head">
          <h2 id={titleId} className="ops-confirm-title">
            {t('svcKeyTitle')}
          </h2>
          <p className="ops-confirm-desc">{t('svcKeyDesc')}</p>
        </div>
        <div className="ops-confirm-match">
          <div className="svc-key-box">
            <code className="mono">{apiKey}</code>
            <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>
              {copied ? t('svcKeyCopied') : t('svcKeyCopy')}
            </button>
          </div>
        </div>
        <div className="ops-confirm-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
            {t('svcKeyDone')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
