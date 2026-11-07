import { useEffect, useRef } from 'react'

type Readout = { step: number; loss: number; lr: number }
type Tone = 'dark' | 'light'

type RunTrack = {
  lrLabel: string
  baseDecay: number
  floor: number
  phase: number
  amp: number
  freq: number
  primary: boolean
}

const TRACKS: RunTrack[] = [
  { lrLabel: '3.0e-4', baseDecay: 3.1, floor: 0.182, phase: 0.2, amp: 0.012, freq: 4.2, primary: true },
  { lrLabel: '1.5e-4', baseDecay: 2.35, floor: 0.248, phase: 1.7, amp: 0.01, freq: 3.4, primary: false },
  { lrLabel: '5.0e-4', baseDecay: 1.75, floor: 0.315, phase: 3.1, amp: 0.014, freq: 4.8, primary: false },
]

function evalLoss(track: RunTrack, u: number, drift: number): number {
  const start = 2.42
  const expTerm = (start - track.floor) * Math.exp(-track.baseDecay * u)
  const damp = Math.exp(-1.65 * u)
  const wave =
    track.amp *
    damp *
    (Math.sin(u * track.freq * Math.PI + track.phase + drift * 0.7) * 0.68 +
      Math.cos(u * (track.freq * 1.9) * Math.PI - track.phase * 0.6 + drift * 1.1) * 0.32)
  return track.floor + expTerm + wave
}

const PALETTES = {
  dark: {
    rule: '170, 198, 214',
    axisText: 'rgba(168, 196, 212, 0.55)',
    axisMuted: 'rgba(168, 196, 212, 0.32)',
    ghost: ['150, 196, 216', '150, 176, 206'],
    line: '132, 220, 242',
    band: '110, 206, 232',
    head: '#f4fdff',
    headRing: '148, 226, 246',
    tipBg: 'rgba(14, 22, 30, 0.92)',
    tipLine: 'rgba(180, 210, 224, 0.16)',
  },
  light: {
    rule: '36, 72, 92',
    axisText: 'rgba(48, 78, 96, 0.55)',
    axisMuted: 'rgba(48, 78, 96, 0.34)',
    ghost: ['28, 96, 122', '48, 84, 112'],
    line: '14, 116, 146',
    band: '18, 124, 156',
    head: '#0c6480',
    headRing: '16, 120, 152',
    tipBg: 'rgba(255, 255, 255, 0.94)',
    tipLine: 'rgba(36, 72, 92, 0.12)',
  },
} as const

/** Coordinate grid and converging runs. The plot stays in the upper band, above the headline. */
export default function LossField({ tone, onReadout }: { tone: Tone; onReadout?: (r: Readout) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const readoutRef = useRef(onReadout)
  readoutRef.current = onReadout

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const pal = PALETTES[tone]

    let w = 0
    let h = 0
    let raf = 0
    let tickCount = 0
    let hoverU: number | null = null
    let plotLeft = 0
    let plotRight = 0
    let plotTop = 0
    let plotBottom = 0

    const maxLoss = 2.6
    const minLoss = 0

    function resize() {
      const rect = canvas!.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = rect.width
      h = rect.height
      canvas!.width = Math.round(w * dpr)
      canvas!.height = Math.round(h * dpr)
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)

      // Form column matches login.css: clamp(24rem, 36vw, 33rem) above 840px.
      const reserveRight = w > 840 ? Math.min(528, Math.max(384, w * 0.36)) : 0
      const openW = Math.max(260, w - reserveRight)
      plotLeft = Math.round(Math.max(58, openW * 0.1))
      plotRight = Math.round(openW - Math.max(36, openW * 0.08))
      // Leave the lower third for the headline and the metric card.
      plotTop = Math.round(h * (reserveRight ? 0.18 : 0.12))
      plotBottom = Math.round(h * (reserveRight ? 0.52 : 0.38))
    }

    function xAt(u: number): number {
      return plotLeft + u * (plotRight - plotLeft)
    }

    function yAt(val: number): number {
      const norm = (val - minLoss) / (maxLoss - minLoss)
      return plotBottom - Math.max(0, Math.min(1, norm)) * (plotBottom - plotTop)
    }

    /** Horizontal hairline that dissolves at both ends, so the plot has no box. */
    function rule(y: number, alpha: number) {
      const g = ctx!.createLinearGradient(plotLeft, 0, plotRight, 0)
      g.addColorStop(0, `rgba(${pal.rule}, 0)`)
      g.addColorStop(0.06, `rgba(${pal.rule}, ${alpha})`)
      g.addColorStop(0.94, `rgba(${pal.rule}, ${alpha})`)
      g.addColorStop(1, `rgba(${pal.rule}, 0)`)
      ctx!.strokeStyle = g
      ctx!.lineWidth = 1
      ctx!.beginPath()
      ctx!.moveTo(plotLeft, y)
      ctx!.lineTo(plotRight, y)
      ctx!.stroke()
    }

    function trace(pts: [number, number][]) {
      ctx!.beginPath()
      ctx!.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2
        const my = (pts[i][1] + pts[i + 1][1]) / 2
        ctx!.quadraticCurveTo(pts[i][0], pts[i][1], mx, my)
      }
      const last = pts[pts.length - 1]
      ctx!.lineTo(last[0], last[1])
    }

    function series(track: RunTrack, uEnd: number, drift: number): [number, number][] {
      const n = Math.max(24, Math.round(160 * uEnd))
      const pts: [number, number][] = []
      for (let i = 0; i <= n; i++) {
        const u = (i / n) * uEnd
        pts.push([xAt(u), yAt(evalLoss(track, u, drift))])
      }
      return pts
    }

    function marker(x: number, y: number, strong: boolean) {
      ctx!.strokeStyle = `rgba(${pal.headRing}, ${strong ? 0.7 : 0.45})`
      ctx!.lineWidth = 1
      ctx!.beginPath()
      ctx!.arc(x, y, strong ? 4.5 : 3.5, 0, Math.PI * 2)
      ctx!.stroke()
      ctx!.fillStyle = pal.head
      ctx!.beginPath()
      ctx!.arc(x, y, strong ? 2 : 1.6, 0, Math.PI * 2)
      ctx!.fill()
    }

    function tooltip(x: number, y: number, text: string) {
      ctx!.font = '11px "IBM Plex Mono", ui-monospace, monospace'
      const padX = 8
      const width = ctx!.measureText(text).width + padX * 2
      const height = 22
      let left = x + 12
      let top = y - height - 10
      if (left + width > plotRight - 4) left = x - width - 12
      if (top < plotTop) top = y + 12
      ctx!.beginPath()
      ctx!.roundRect(left, top, width, height, 5)
      ctx!.fillStyle = pal.tipBg
      ctx!.fill()
      ctx!.strokeStyle = pal.tipLine
      ctx!.lineWidth = 1
      ctx!.stroke()
      ctx!.fillStyle = pal.axisText
      ctx!.textAlign = 'left'
      ctx!.textBaseline = 'middle'
      ctx!.fillText(text, left + padX, top + height / 2)
    }

    function draw(progress: number, drift: number, scrub = false) {
      ctx!.clearRect(0, 0, w, h)
      if (plotRight - plotLeft <= 40 || plotBottom - plotTop <= 40) return
      ctx!.lineJoin = 'round'
      ctx!.lineCap = 'round'
      ctx!.font = '10px "IBM Plex Mono", ui-monospace, monospace'

      const yTicks = [2.4, 1.2, 0]
      ctx!.textAlign = 'right'
      ctx!.textBaseline = 'middle'
      ctx!.fillStyle = pal.axisText
      for (const tick of yTicks) {
        const y = Math.round(yAt(tick)) + 0.5
        rule(y, tick === 0 ? 0.16 : 0.08)
        ctx!.fillText(tick.toFixed(1), plotLeft - 14, y)
      }

      ctx!.textAlign = 'center'
      ctx!.textBaseline = 'top'
      ctx!.fillStyle = pal.axisMuted
      for (const step of [0, 1000, 2000, 3000, 4000]) {
        const label = step === 0 ? '0' : `${step / 1000}k`
        ctx!.fillText(label, xAt(step / 4000), plotBottom + 12)
      }

      let ghostIdx = 0
      for (const track of TRACKS) {
        if (track.primary) continue
        const pts = series(track, 1, drift * 0.4)
        const fade = ctx!.createLinearGradient(plotLeft, 0, plotRight, 0)
        const rgb = pal.ghost[ghostIdx % pal.ghost.length]
        ghostIdx++
        fade.addColorStop(0, `rgba(${rgb}, 0.05)`)
        fade.addColorStop(0.2, `rgba(${rgb}, 0.22)`)
        fade.addColorStop(0.8, `rgba(${rgb}, 0.16)`)
        fade.addColorStop(1, `rgba(${rgb}, 0)`)
        ctx!.strokeStyle = fade
        ctx!.lineWidth = 1
        trace(pts)
        ctx!.stroke()
      }

      const span = scrub ? 1 : progress
      const pts = series(TRACKS[0], span, drift)
      const cut = scrub ? Math.max(1, Math.min(pts.length - 1, Math.round((pts.length - 1) * progress))) : pts.length - 1
      const head = pts[cut]
      const shown = scrub ? pts.slice(0, cut + 1) : pts
      const band = 14
      ctx!.beginPath()
      ctx!.moveTo(shown[0][0], shown[0][1])
      for (let i = 1; i < shown.length - 1; i++) {
        const mx = (shown[i][0] + shown[i + 1][0]) / 2
        const my = (shown[i][1] + shown[i + 1][1]) / 2
        ctx!.quadraticCurveTo(shown[i][0], shown[i][1], mx, my)
      }
      ctx!.lineTo(head[0], head[1])
      for (let i = shown.length - 1; i >= 0; i--) ctx!.lineTo(shown[i][0], shown[i][1] + band)
      ctx!.closePath()
      const wash = ctx!.createLinearGradient(0, head[1] - 8, 0, head[1] + band)
      wash.addColorStop(0, `rgba(${pal.band}, 0.08)`)
      wash.addColorStop(1, `rgba(${pal.band}, 0)`)
      ctx!.fillStyle = wash
      ctx!.fill()

      const ink = ctx!.createLinearGradient(plotLeft, 0, head[0], 0)
      ink.addColorStop(0, `rgba(${pal.line}, 0.4)`)
      ink.addColorStop(0.3, `rgba(${pal.line}, 0.72)`)
      ink.addColorStop(1, `rgba(${pal.line}, 0.95)`)
      ctx!.strokeStyle = ink
      ctx!.lineWidth = 1.5
      trace(shown)
      ctx!.stroke()

      if (scrub && cut < pts.length - 1) {
        ctx!.strokeStyle = `rgba(${pal.line}, 0.28)`
        ctx!.lineWidth = 1.25
        trace(pts.slice(cut))
        ctx!.stroke()
        const guide = ctx!.createLinearGradient(0, plotTop, 0, plotBottom)
        guide.addColorStop(0, `rgba(${pal.rule}, 0)`)
        guide.addColorStop(0.18, `rgba(${pal.rule}, 0.45)`)
        guide.addColorStop(0.82, `rgba(${pal.rule}, 0.45)`)
        guide.addColorStop(1, `rgba(${pal.rule}, 0)`)
        ctx!.strokeStyle = guide
        ctx!.lineWidth = 1
        ctx!.beginPath()
        ctx!.moveTo(Math.round(head[0]) + 0.5, plotTop)
        ctx!.lineTo(Math.round(head[0]) + 0.5, plotBottom)
        ctx!.stroke()
      }

      marker(head[0], head[1], scrub)
      if (scrub) {
        const step = Math.round(progress * 4000).toLocaleString('en-US')
        const loss = evalLoss(TRACKS[0], progress, drift)
        tooltip(head[0], head[1], `${step}   ${loss.toFixed(4)}`)
      }
    }

    function emit(progress: number, drift: number) {
      const currentLoss = evalLoss(TRACKS[0], progress, drift)
      readoutRef.current?.({
        step: Math.round(progress * 4000),
        loss: Math.max(0.16, currentLoss),
        lr: 3e-4 * (0.5 * (1 + Math.cos(Math.PI * progress))) + 1.2e-5,
      })
    }

    function frameProgress() {
      const raw = (tickCount % 1440) / 1440
      return 0.22 + 0.76 * (1 - Math.pow(1 - raw, 2.2))
    }

    function paint(forceEmit = false) {
      const scrub = hoverU != null
      const progress = scrub ? hoverU! : reduced ? 0.86 : frameProgress()
      const drift = scrub ? 0 : tickCount * 0.008
      draw(progress, drift, scrub)
      if (forceEmit || scrub || tickCount % 8 === 0) emit(progress, drift)
    }

    function loop() {
      tickCount++
      paint()
      raf = requestAnimationFrame(loop)
    }

    function uAt(event: PointerEvent) {
      const rect = canvas!.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      if (x < plotLeft - 12 || x > plotRight + 12) return null
      if (y < plotTop - 24 || y > plotBottom + 36) return null
      return Math.min(1, Math.max(0, (x - plotLeft) / Math.max(1, plotRight - plotLeft)))
    }

    function onMove(event: PointerEvent) {
      const next = uAt(event)
      hoverU = next
      canvas!.style.cursor = next == null ? '' : 'crosshair'
      if (reduced) paint(true)
    }

    function onLeave() {
      hoverU = null
      canvas!.style.cursor = ''
      if (reduced) paint(true)
    }

    resize()
    const ro = new ResizeObserver(() => {
      resize()
      paint(true)
    })
    ro.observe(canvas)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeave)

    if (reduced) {
      paint(true)
    } else {
      emit(0.4, 0)
      raf = requestAnimationFrame(loop)
    }

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
    }
  }, [tone])

  return <canvas ref={canvasRef} className="loss-field" aria-hidden />
}
