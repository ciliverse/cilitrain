import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'

/** Read-only source view: line numbers, copy, download. Used for YAML and scripts. */
export default function CodeBlock({
  text,
  filename,
  language,
  maxLines,
}: {
  text: string
  filename: string
  language?: string
  /** Collapse longer sources behind a "show all" toggle. */
  maxLines?: number
}) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text])
  const limit = maxLines && !expanded ? maxLines : lines.length
  const shown = lines.slice(0, limit)
  const hidden = lines.length - shown.length

  async function copy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-name mono">{filename}</span>
        <span className="code-meta mono">
          {language ? `${language} · ` : ''}
          {t('codeLines').replace('{n}', String(lines.length))}
        </span>
        <div className="code-acts">
          <button type="button" className="code-act" onClick={copy}>
            {copied ? t('copied') : t('copy')}
          </button>
          <button type="button" className="code-act" onClick={download}>
            {t('download')}
          </button>
        </div>
      </div>
      <div className="code-body">
        {shown.map((line, i) => (
          <div key={i} className="code-line">
            <span className="code-no mono">{i + 1}</span>
            <span className="code-txt mono">{line || ' '}</span>
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <button type="button" className="code-more" onClick={() => setExpanded(true)}>
          {t('codeShowAll').replace('{n}', String(hidden))}
        </button>
      )}
    </div>
  )
}
