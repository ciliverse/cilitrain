import { useEffect, useRef } from 'react'

type Readout = { step: number; loss: number; lr: number }

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  trail: [number, number][]
  age: number
  settled: number
  fade: number
}

const TRAIL = 150
const PARTICLES = 5
const LR = 0.0042
const MOMENTUM = 0.9

function loss(x: number, y: number) {
  const bowl = 0.42 * (0.7 * x * x + y * y)
  const global = -0.95 * Math.exp(-((x - 0.38) ** 2 + (y + 0.22) ** 2) / 0.07)
  const local = -0.5 * Math.exp(-((x + 0.55) ** 2 + (y - 0.42) ** 2) / 0.045)
  const ridge = 0.32 * Math.exp(-((x + 0.05) ** 2 + (y - 0.05) ** 2) / 0.09)
  const ripple = 0.035 * Math.sin(5.2 * x) * Math.cos(4.4 * y)
  return bowl + global + local + ridge + ripple
}

function grad(x: number, y: number): [number, number] {
  const h = 1e-3
  return [
    (loss(x + h, y) - loss(x - h, y)) / (2 * h),
    (loss(x, y + h) - loss(x, y - h)) / (2 * h),
  ]
}

function spawn(): Particle {
  const a = Math.random() * Math.PI * 2
  const r = 0.85 + Math.random() * 0.35
  return { x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, trail: [], age: 0, settled: 0, fade: 0 }
}

function step(p: Particle) {
  const [gx, gy] = grad(p.x, p.y)
  const noise = 0.0022 * Math.exp(-p.age / 220)
  p.vx = MOMENTUM * p.vx - LR * gx + (Math.random() - 0.5) * noise
  p.vy = MOMENTUM * p.vy - LR * gy + (Math.random() - 0.5) * noise
  p.x += p.vx
  p.y += p.vy
  p.age++
  p.trail.push([p.x, p.y])
  if (p.trail.length > TRAIL) p.trail.shift()
  const back = p.trail[p.trail.length - 31]
  if (back && Math.hypot(p.x - back[0], p.y - back[1]) < 0.012) p.settled++
}

type Tone = 'dark' | 'light'

const PALETTES = {
  dark: {
    contour: (d: number) => [70 + 60 * d, 130 + 90 * d, 200 + 40 * d],
    contourAlpha: 1,
    trail: '140, 236, 255',
    head: '235, 252, 255',
    glow: '190, 248, 255',
    ember: '255, 192, 116',
  },
  light: {
    contour: (d: number) => [40 - 20 * d, 90 + 20 * d, 150 - 10 * d],
    contourAlpha: 0.85,
    trail: '0, 118, 150',
    head: '0, 84, 112',
    glow: '0, 150, 190',
    ember: '206, 118, 24',
  },
} as const

/** Animated loss surface: contour field with optimizer trajectories descending it. */
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
    let scale = 1
    let ox = 0
    let oy = 0
    let field: HTMLCanvasElement | null = null
    let min: [number, number] = [0.38, -0.22]
    let minLoss = loss(...min)
    let maxLoss = 1
    let raf = 0
    let frame = 0
    let globalStep = 0
    const particles: Particle[] = Array.from({ length: PARTICLES }, spawn)
    particles.forEach((p, i) => {
      for (let k = 0; k < i * 40; k++) step(p)
    })

    const toScreen = (x: number, y: number): [number, number] => [ox + x * scale, oy + y * scale]

    function findExtremes() {
      let lo = Infinity
      let hi = -Infinity
      for (let i = 0; i <= 120; i++) {
        for (let j = 0; j <= 120; j++) {
          const x = -1.4 + (2.8 * i) / 120
          const y = -1.4 + (2.8 * j) / 120
          const v = loss(x, y)
          if (v < lo) {
            lo = v
            min = [x, y]
          }
          if (v > hi) hi = v
        }
      }
      minLoss = lo
      maxLoss = hi
    }

    function renderField() {
      const res = 2
      const fw = Math.max(1, Math.ceil(w / res))
      const fh = Math.max(1, Math.ceil(h / res))
      const off = document.createElement('canvas')
      off.width = fw
      off.height = fh
      const octx = off.getContext('2d')
      if (!octx) return
      const img = octx.createImageData(fw, fh)
      const bands = 18
      const gw = fw + 1
      const ts = new Float32Array(gw * (fh + 1))
      for (let py = 0; py <= fh; py++) {
        for (let px = 0; px <= fw; px++) {
          const x = (px * res - ox) / scale
          const y = (py * res - oy) / scale
          ts[py * gw + px] = Math.min(1, Math.max(0, (loss(x, y) - minLoss) / (maxLoss - minLoss)))
        }
      }
      for (let py = 0; py < fh; py++) {
        for (let px = 0; px < fw; px++) {
          const t = ts[py * gw + px]
          const b = Math.pow(t, 0.7) * bands
          const bx = Math.pow(ts[py * gw + px + 1], 0.7) * bands
          const by = Math.pow(ts[(py + 1) * gw + px], 0.7) * bands
          const fwidth = Math.abs(bx - b) + Math.abs(by - b) + 1e-4
          const f = b - Math.floor(b)
          const edge = Math.min(f, 1 - f)
          const density = Math.max(0, 1 - fwidth / 0.45)
          const line = Math.max(0, 1 - edge / (fwidth * 0.9)) * density
          const depth = 1 - t
          const radial = Math.min(1, Math.hypot(px * res - ox, py * res - oy) / Math.max(w, h))
          const vis = (1 - radial * 0.9) * pal.contourAlpha
          const i = (py * fw + px) * 4
          const [r, g, bl] = pal.contour(depth)
          img.data[i] = r
          img.data[i + 1] = g
          img.data[i + 2] = bl
          img.data[i + 3] = Math.round((line * (0.16 + 0.42 * depth) + depth * depth * 0.07) * 255 * vis)
        }
      }
      octx.putImageData(img, 0, 0)
      field = off
    }

    function resize() {
      const rect = canvas!.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = rect.width
      h = rect.height
      canvas!.width = Math.round(w * dpr)
      canvas!.height = Math.round(h * dpr)
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      // Must match the form column width in login.css: clamp(24rem, 36vw, 34rem) above 800px.
      const reserveRight = w > 800 ? Math.min(544, Math.max(384, w * 0.36)) : 0
      const open = Math.max(1, w - reserveRight)
      if (reserveRight > 0) {
        scale = Math.max(open, h) * 0.44
        ox = open * 0.56
        oy = h * 0.44
      } else {
        scale = Math.max(w * 0.62, 150)
        ox = w * 0.56
        oy = Math.min(h * 0.22, 170)
      }
      renderField()
    }

    function draw() {
      ctx!.clearRect(0, 0, w, h)
      if (field) ctx!.drawImage(field, 0, 0, w, h)

      const [mx, my] = toScreen(...min)
      const pulse = reduced ? 0.5 : (Math.sin(frame / 38) + 1) / 2
      ctx!.strokeStyle = `rgba(${pal.ember}, ${0.35 + pulse * 0.35})`
      ctx!.lineWidth = 1
      ctx!.beginPath()
      ctx!.arc(mx, my, 10 + pulse * 6, 0, Math.PI * 2)
      ctx!.stroke()
      ctx!.fillStyle = `rgba(${pal.ember}, 0.95)`
      ctx!.beginPath()
      ctx!.arc(mx, my, 2.2, 0, Math.PI * 2)
      ctx!.fill()
      ctx!.strokeStyle = `rgba(${pal.ember}, 0.35)`
      ctx!.beginPath()
      ctx!.moveTo(mx - 22, my)
      ctx!.lineTo(mx - 15, my)
      ctx!.moveTo(mx + 15, my)
      ctx!.lineTo(mx + 22, my)
      ctx!.moveTo(mx, my - 22)
      ctx!.lineTo(mx, my - 15)
      ctx!.moveTo(mx, my + 15)
      ctx!.lineTo(mx, my + 22)
      ctx!.stroke()

      ctx!.lineWidth = 1.4
      ctx!.lineCap = 'round'
      ctx!.lineJoin = 'round'
      for (const p of particles) {
        const alpha = 1 - p.fade
        const n = p.trail.length
        const chunk = Math.max(2, Math.ceil(n / 12))
        for (let s = 0; s < n - 1; s += chunk) {
          const end = Math.min(n - 1, s + chunk)
          ctx!.strokeStyle = `rgba(${pal.trail}, ${(end / n) * 0.75 * alpha})`
          ctx!.beginPath()
          ctx!.moveTo(...toScreen(...p.trail[s]))
          for (let i = s + 1; i <= end; i++) ctx!.lineTo(...toScreen(...p.trail[i]))
          ctx!.stroke()
        }
        const [hx, hy] = toScreen(p.x, p.y)
        const glow = ctx!.createRadialGradient(hx, hy, 0, hx, hy, 12)
        glow.addColorStop(0, `rgba(${pal.glow}, ${0.55 * alpha})`)
        glow.addColorStop(1, `rgba(${pal.glow}, 0)`)
        ctx!.fillStyle = glow
        ctx!.beginPath()
        ctx!.arc(hx, hy, 12, 0, Math.PI * 2)
        ctx!.fill()
        ctx!.fillStyle = `rgba(${pal.head}, ${alpha})`
        ctx!.beginPath()
        ctx!.arc(hx, hy, 1.9, 0, Math.PI * 2)
        ctx!.fill()
      }
    }

    function emit() {
      const lead = particles[0]
      const progress = Math.min(1, lead.age / 600)
      readoutRef.current?.({
        step: globalStep,
        loss: loss(lead.x, lead.y) - minLoss + 0.0213 + Math.random() * 0.002,
        lr: 3e-4 * (0.5 * (1 + Math.cos(Math.PI * progress))) + 1e-5,
      })
    }

    function tick() {
      frame++
      globalStep++
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]
        if (p.settled > 70 || p.age > 520) {
          p.fade = Math.min(1, p.fade + 0.02)
          if (p.fade >= 1) particles[i] = spawn()
        } else {
          step(p)
        }
      }
      draw()
      if (frame % 6 === 0) emit()
      raf = requestAnimationFrame(tick)
    }

    findExtremes()
    resize()
    const ro = new ResizeObserver(() => {
      resize()
      if (reduced) draw()
    })
    ro.observe(canvas)

    if (reduced) {
      for (const p of particles) for (let k = 0; k < 120; k++) step(p)
      globalStep = 1280
      draw()
      emit()
    } else {
      raf = requestAnimationFrame(tick)
    }

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [tone])

  return <canvas ref={canvasRef} className="loss-field" aria-hidden />
}
