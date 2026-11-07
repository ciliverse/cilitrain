import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'

const KEY = 'cilitrain_show_nodes'
let revealed = readStored()
const listeners = new Set<() => void>()

function readStored() {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

function publish(next: boolean) {
  revealed = next
  try {
    localStorage.setItem(KEY, next ? '1' : '0')
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn())
}

export function useRevealNodes() {
  const [show, setShow] = useState(revealed)
  useEffect(() => {
    const fn = () => setShow(revealed)
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }, [])
  return { show, toggle: () => publish(!revealed) }
}

/** Hide the whole node name or address. Partial octets stay identifiable. */
export function maskHost(value?: string | null): string {
  if (!value) return '—'
  return '*.*.*.*'
}

export function hostText(value: string | null | undefined, show: boolean): string {
  if (!value) return '—'
  return show ? value : maskHost(value)
}

export function RevealNodesButton() {
  const { t } = useI18n()
  const { show, toggle } = useRevealNodes()
  return (
    <button type="button" className="node-reveal" onClick={toggle} aria-pressed={show}>
      {show ? t('nodeHide') : t('nodeReveal')}
    </button>
  )
}
