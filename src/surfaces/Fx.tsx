import { useEffect, useRef } from 'react'
import { reducedMotion } from './Dock'
import { isNight, seasonOf } from './Ascii'

/* ── v2 전체화면 효과: 캔버스 2D 1장, 입자 ≤150, 30fps, 25초 뒤 페이드아웃 → 언마운트(onDone).
   실제 앱: 투명·클릭 통과 전체화면 창을 그때만 만들고 끝나면 파괴 (Rust, 시안 승인 후). */
export type FxKind = 'snow' | 'rain' | 'leaves' | 'sunset' | 'moon'
export const FX_LABEL: Record<FxKind, string> = { snow: '눈', rain: '비', leaves: '단풍', sunset: '노을', moon: '달·별' }
const DUR = 25_000
const FADE_OUT = 2_500

/** 달 위상 0..1 (0 = 삭, 0.5 = 보름). 기준 삭: 2000-01-06 18:14 UTC, 삭망월 29.530588853일 */
export const moonPhase = (d: Date) => {
  const m = 29.530588853
  const days = (d.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86_400_000
  return (((days % m) + m) % m) / m
}
export const moonName = (f: number) => ['삭', '초승달', '상현달', '차오르는 달', '보름달', '기우는 달', '하현달', '그믐달'][Math.round(f * 8) % 8]

// 시안 = 가짜 날씨 (네트워크 없음). 실제 앱 = Open-Meteo 30분 1회.
export type Weather = { text: '맑음' | '구름 조금' | '흐림' | '비' | '눈'; temp: number }
export const fakeWeather = (city: string): Weather => {
  const n = [...city].reduce((a, c) => a + c.charCodeAt(0), 0)
  return { text: (['맑음', '구름 조금', '흐림', '비', '눈'] as const)[n % 5], temp: 2 + (n % 14) }
}
/** '지금 보기': 날씨 > 시간대 > 계절 순으로 고른다 */
export function pickFx(d: Date, w: Weather): FxKind {
  if (w.text === '비') return 'rain'
  if (w.text === '눈') return 'snow'
  const h = d.getHours()
  if (h >= 17 && h < 19) return 'sunset'
  if (isNight(d)) return 'moon'
  if (seasonOf(d) === '가을') return 'leaves'
  return seasonOf(d) === '겨울' ? 'snow' : 'sunset'
}

const R = Math.random
const fadeIn = (p: P, t: number) => (p.b === undefined ? 1 : Math.min(1, (t - p.b) / 800))
type Frame = (t: number, dt: number, env: number) => void
type P = { x: number; y: number; v: number; s: number; a: number; r: number; c: number; b?: number }

function maple(color: string) {
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const g = c.getContext('2d')!
  g.translate(16, 17)
  g.beginPath()
  for (let i = 0; i <= 60; i++) {
    const t = (i / 60) * Math.PI * 2 - Math.PI / 2
    const r = 14 * (0.32 + 0.68 * Math.abs(Math.cos(2.5 * (t + Math.PI / 2))) ** 2.2) * (0.86 + 0.14 * Math.abs(Math.sin(12.5 * t)))
    g.lineTo(Math.cos(t) * r, Math.sin(t) * r)
  }
  g.fillStyle = color
  g.fill()
  g.strokeStyle = 'rgba(80,30,10,0.5)'
  g.beginPath()
  g.moveTo(0, 2), g.lineTo(0, 15)
  g.stroke()
  return c
}

/** 입자계: 목표 개수 = max × env(시작 4초 램프인, 끝 6초 램프아웃). 넘치는 입자는 화면을 벗어나면 다시 태어나지 않는다.
    램프인 중 새 입자(b = 태어난 시각)는 화면 어디서든 0.8초 동안 서서히 나타난다 → 시작이 뚝 끊기지 않게. */
function particles(ctx: CanvasRenderingContext2D, W: number, H: number, max: number, spawn: () => P, step: (p: P, dt: number, t: number) => void, draw: (ps: P[], t: number) => void, scatter = true): Frame {
  const ps: P[] = []
  return (t, dt, env) => {
    const target = Math.round(max * env)
    while (ps.length < target && ps.length < max) {
      const p = spawn()
      if (scatter && t < 6000) (p.y = R() * H * 0.95), (p.b = t)
      ps.push(p)
    }
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i]
      step(p, dt, t)
      if (p.y > H + 30 || p.x < -40 || p.x > W + 40) {
        if (ps.length > target) ps.splice(i, 1)
        else ps[i] = spawn()
      }
    }
    ctx.clearRect(0, 0, W, H)
    draw(ps, t)
  }
}

function make(kind: FxKind, ctx: CanvasRenderingContext2D, W: number, H: number): Frame {
  if (kind === 'snow')
    return particles(ctx, W, H, 140,
      () => ({ x: R() * W, y: -10 - R() * H * 0.3, v: 40 + R() * 60, s: 1 + R() * 2.6, a: R() * 6, r: 0, c: 0 }),
      (p, dt, t) => ((p.y += p.v * dt), (p.x += Math.sin(p.a + t / 1400) * 18 * dt)),
      (ps, t) => {
        ctx.fillStyle = '#fff'
        for (const p of ps) {
          ctx.globalAlpha = 0.85 * fadeIn(p, t)
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.s, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.globalAlpha = 1
      })
  if (kind === 'rain')
    return particles(ctx, W, H, 150,
      () => ({ x: R() * (W + 200), y: -20 - R() * H * 0.4, v: 700 + R() * 400, s: 10 + R() * 14, a: 0, r: 0, c: 0 }),
      (p, dt) => ((p.y += p.v * dt), (p.x -= p.v * 0.16 * dt)),
      (ps) => {
        ctx.strokeStyle = 'rgba(170,195,230,0.55)'
        ctx.lineWidth = 1.2
        ctx.beginPath()
        for (const p of ps) ctx.moveTo(p.x, p.y), ctx.lineTo(p.x + p.s * 0.16, p.y - p.s)
        ctx.stroke()
      }, false)
  if (kind === 'leaves') {
    const sprites = ['#e2553a', '#f08a2c', '#f5c443', '#b8452e'].map(maple)
    return particles(ctx, W, H, 40,
      () => ({ x: R() * W, y: -30 - R() * H * 0.3, v: 40 + R() * 45, s: 0.6 + R() * 0.7, a: R() * 6, r: R() * 6, c: Math.floor(R() * 4) }),
      (p, dt, t) => ((p.y += p.v * dt), (p.x += Math.sin(p.a + t / 900) * 40 * dt), (p.r += dt * (0.6 + p.s))),
      (ps, t) => {
        for (const p of ps) {
          ctx.save()
          ctx.globalAlpha = fadeIn(p, t)
          ctx.translate(p.x, p.y)
          ctx.rotate(p.r)
          ctx.scale(p.s * Math.cos(p.r * 0.7), p.s) // 잎이 뒤집히는 느낌
          ctx.drawImage(sprites[p.c], -16, -16)
          ctx.restore()
        }
      })
  }
  // 노을·달은 바탕 그림이 정적 → 오프스크린에 1회
  const bgc = document.createElement('canvas')
  bgc.width = W * K
  bgc.height = H * K
  const b = bgc.getContext('2d')!
  b.scale(K, K)
  if (kind === 'sunset') {
    const lg = b.createLinearGradient(0, H, 0, 0)
    lg.addColorStop(0, 'rgba(255,122,64,0.42)')
    lg.addColorStop(0.3, 'rgba(255,94,120,0.22)')
    lg.addColorStop(0.65, 'rgba(140,90,200,0.08)')
    lg.addColorStop(1, 'rgba(0,0,0,0)')
    b.fillStyle = lg
    b.fillRect(0, 0, W, H)
    const rg = b.createRadialGradient(W * 0.3, H * 1.02, 0, W * 0.3, H * 1.02, H * 0.6)
    rg.addColorStop(0, 'rgba(255,214,140,0.65)')
    rg.addColorStop(1, 'rgba(255,170,90,0)')
    b.fillStyle = rg
    b.fillRect(0, 0, W, H)
    let drawn = false
    return () => {
      if (!drawn) ctx.drawImage(bgc, 0, 0, W, H), (drawn = true)
    }
  }
  // moon: 위쪽 밤빛 + 실제 위상의 달 + 반짝이는 별
  const lg = b.createLinearGradient(0, 0, 0, H)
  lg.addColorStop(0, 'rgba(8,14,40,0.5)')
  lg.addColorStop(0.7, 'rgba(8,14,40,0)')
  b.fillStyle = lg
  b.fillRect(0, 0, W, H)
  const mx = W * 0.8, my = H * 0.2, r = 40
  const glow = b.createRadialGradient(mx, my, r, mx, my, r * 4)
  glow.addColorStop(0, 'rgba(245,235,200,0.22)')
  glow.addColorStop(1, 'rgba(245,235,200,0)')
  b.fillStyle = glow
  b.fillRect(0, 0, W, H)
  drawMoon(b, mx, my, r, moonPhase(new Date()))
  const stars = Array.from({ length: 110 }, () => ({ x: R() * W, y: R() * H * 0.62, s: 0.6 + R() * 1.3, a: R() * 6, w: 0.6 + R() * 1.6 }))
  return (t) => {
    ctx.clearRect(0, 0, W, H)
    ctx.drawImage(bgc, 0, 0, W, H)
    for (const s of stars) {
      ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(s.a + (t / 1000) * s.w))
      ctx.fillStyle = '#fff'
      ctx.fillRect(s.x, s.y, s.s, s.s)
    }
    ctx.globalAlpha = 1
  }
}
let K = 1

/** 위상 f(0..1) 의 달. 북반구 기준: 차오를 때 오른쪽이 밝다. 명암 경계 = 가로 반지름 r·|cos 2πf| 인 반타원 */
export function drawMoon(g: CanvasRenderingContext2D, x: number, y: number, r: number, f: number) {
  g.save()
  g.translate(x, y)
  g.fillStyle = 'rgba(200,210,235,0.1)' // 어두운 면 (지구조)
  g.beginPath()
  g.arc(0, 0, r, 0, Math.PI * 2)
  g.fill()
  g.scale(f < 0.5 ? 1 : -1, 1)
  const k = Math.cos(2 * Math.PI * f)
  g.beginPath()
  g.arc(0, 0, r, -Math.PI / 2, Math.PI / 2)
  g.ellipse(0, 0, r * Math.abs(k), r, 0, Math.PI / 2, -Math.PI / 2, k > 0)
  g.fillStyle = '#f6efd6'
  g.shadowColor = 'rgba(255,245,210,0.8)'
  g.shadowBlur = 18
  g.fill()
  g.restore()
}

export function Fx({ kind, onDone }: { kind: FxKind; onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    const c = ref.current!, ctx = c.getContext('2d')!
    const W = innerWidth, H = innerHeight
    K = Math.min(devicePixelRatio, 1.5)
    c.width = W * K
    c.height = H * K
    ctx.scale(K, K)
    const frame = make(kind, ctx, W, H)
    c.getBoundingClientRect()
    c.dataset.show = 'true' // CSS 페이드 인
    let raf = 0, last = 0
    const t0 = performance.now()
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - last < 33) return // 30fps
      const t = now - t0
      frame(t, Math.min(0.05, (now - (last || now)) / 1000), Math.max(0, Math.min(1, t / 4000, (DUR - t) / 6000)))
      last = now
    }
    if (reducedMotion()) for (let i = 0; i < 120; i++) frame(8000 + i * 50, 0.05, 1) // 움직임 없이: 6초 진행시킨 한 장면만
    else raf = requestAnimationFrame(loop)
    const out = setTimeout(() => (c.dataset.show = 'false'), DUR - FADE_OUT)
    return () => (cancelAnimationFrame(raf), clearTimeout(out))
  }, [kind])
  return <canvas ref={ref} className="fx" aria-hidden onTransitionEnd={(e) => e.propertyName === 'opacity' && ref.current?.dataset.show === 'false' && done.current()} />
}
