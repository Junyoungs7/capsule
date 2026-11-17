import { useEffect, useRef } from 'react'
import { reducedMotion } from './Tile'
import { isNight, moonPhase, seasonOf } from './Ascii'

/* ── v2 전체화면 효과: 캔버스 2D 1장, 입자 ≤150, 30fps, 25초 뒤 페이드아웃 → 언마운트(onDone).
   실제 앱: 투명·클릭 통과 전체화면 창(surface=fx)을 Rust 가 그때만 만들고, onDone 에서 창을 파괴. */
export type FxKind = 'snow' | 'rain' | 'leaves' | 'dawn' | 'sunset' | 'moon'
export const FX_LABEL: Record<FxKind, string> = { snow: '눈', rain: '비', leaves: '단풍', dawn: '새벽', sunset: '노을', moon: '달·별' }
// 하늘 효과는 바탕화면에 덧칠하지 않고 하늘을 통째로 그린다(불투명도 85%) → 어떤 바탕화면이든 같은 그림. 눈·비·단풍은 투명 오버레이.
const SKY = new Set<FxKind>(['dawn', 'sunset', 'moon'])
const DUR = 25_000
const FADE_OUT = 2_500

// 시안 = 가짜 날씨 (네트워크 없음). 실제 앱 = Open-Meteo 30분 1회 (독 창이 받아 store `fx.weather` 에 — Rust 효과 판정·패널 표시 공용).
export type Weather = { text: '맑음' | '구름 조금' | '흐림' | '비' | '눈'; temp: number }
export const fakeWeather = (city: string): Weather => {
  const n = [...city].reduce((a, c) => a + c.charCodeAt(0), 0)
  return { text: (['맑음', '구름 조금', '흐림', '비', '눈'] as const)[n % 5], temp: 2 + (n % 14) }
}
// WMO 날씨 코드 → 글자 (비: 이슬비·비·소나기·뇌우, 눈: 눈·눈 소나기)
const wmo = (c: number): Weather['text'] =>
  c === 0 ? '맑음' : c <= 2 ? '구름 조금' : c <= 48 ? '흐림' : (c >= 71 && c <= 77) || c === 85 || c === 86 ? '눈' : '비'
const geo = new Map<string, [number, number]>()
/** 실제 앱: Open-Meteo 지오코딩 (도시 이름만 보냄) → [위도, 경도]. 좌표는 Rust 일출·일몰 계산에도 쓴다(store `fx.coords`). */
export async function geocode(city: string): Promise<[number, number]> {
  let c = geo.get(city)
  if (!c) {
    const g = (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=ko&name=${encodeURIComponent(city)}`).then((r) => r.json())).results?.[0]
    if (!g) throw new Error(`도시를 찾지 못했어요: ${city}`)
    geo.set(city, (c = [g.latitude, g.longitude]))
  }
  return c
}
/** 실제 앱: Open-Meteo 현재 날씨 (키 없음, 좌표만 보냄) */
export async function fetchWeather(c: [number, number]): Promise<Weather> {
  const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${c[0]}&longitude=${c[1]}&current=temperature_2m,weather_code`).then((r) => r.json())
  return { text: wmo(w.current.weather_code), temp: Math.round(w.current.temperature_2m) }
}

/** '지금 보기': 날씨 > 시간대 > 계절 순으로 고른다 (날씨 모름 = 시간대·계절만) */
export function pickFx(d: Date, w: Weather | null): FxKind {
  if (w?.text === '비') return 'rain'
  if (w?.text === '눈') return 'snow'
  const h = d.getHours()
  if (h >= 5 && h < 8) return 'dawn'
  if (h >= 17 && h < 19) return 'sunset'
  if (isNight(d)) return 'moon'
  if (seasonOf(d) === '가을') return 'leaves'
  return seasonOf(d) === '겨울' ? 'snow' : 'sunset'
}

const R = Math.random
const fadeIn = (p: P, t: number) => (p.b === undefined ? 1 : Math.min(1, (t - p.b) / 800))
type Frame = (t: number, dt: number, env: number) => void
type P = { x: number; y: number; v: number; s: number; a: number; r: number; c: number; b?: number }

// 단풍잎 실루엣 (오른쪽 반, 단위 좌표·위 = -y): 가운데 잎·위 옆잎·아래 옆잎 5갈래 + 톱니 + 깊은 결각. 왼쪽은 대칭.
const MAPLE: [number, number][] = [
  [0, -1], [0.09, -0.78], [0.2, -0.84], [0.15, -0.58], [0.12, -0.36], [0.36, -0.46], [0.42, -0.63], [0.55, -0.5], [0.92, -0.62],
  [0.72, -0.36], [0.83, -0.28], [0.55, -0.16], [0.3, -0.02], [0.55, 0.08], [0.82, 0.24], [0.48, 0.24], [0.36, 0.36], [0.08, 0.3], [0, 0.34],
]
function maple(color: string) {
  const c = document.createElement('canvas')
  c.width = c.height = 40
  const g = c.getContext('2d')!
  g.translate(20, 19)
  g.scale(17, 17)
  g.beginPath()
  MAPLE.forEach(([x, y]) => g.lineTo(x, y))
  for (let i = MAPLE.length - 2; i > 0; i--) g.lineTo(-MAPLE[i][0], MAPLE[i][1])
  g.closePath()
  g.fillStyle = color
  g.fill()
  g.lineWidth = 0.06
  g.lineCap = 'round'
  g.strokeStyle = 'rgba(70,25,8,0.55)'
  g.beginPath()
  for (const [x, y] of [[0, -0.85], [0.75, -0.5], [-0.75, -0.5], [0.68, 0.2], [-0.68, 0.2]]) g.moveTo(0, 0.28), g.lineTo(x * 0.85, y * 0.85) // 잎맥
  g.moveTo(0, 0.3)
  g.lineTo(0.05, 1.05) // 잎자루
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
          ctx.drawImage(sprites[p.c], -20, -20)
          ctx.restore()
        }
      })
  }
  // 하늘(새벽·노을·밤): 정적 그림은 오프스크린에 1회. 밤만 별 반짝임 루프.
  const bgc = document.createElement('canvas')
  bgc.width = W * K
  bgc.height = H * K
  const b = bgc.getContext('2d')!
  b.scale(K, K)
  paintSky(b, W, H, kind)
  if (kind !== 'moon') {
    let drawn = false
    return () => void (drawn || (ctx.drawImage(bgc, 0, 0, W, H), (drawn = true)))
  }
  const stars = Array.from({ length: 120 }, () => ({ x: R() * W, y: R() * H * 0.7, s: 0.7 + R() * 1.4, a: R() * 6, w: 0.5 + R() * 1.5 }))
  return (t) => {
    ctx.clearRect(0, 0, W, H)
    ctx.drawImage(bgc, 0, 0, W, H)
    ctx.fillStyle = '#fff'
    for (const s of stars) {
      ctx.globalAlpha = 0.3 + 0.7 * Math.abs(Math.sin(s.a + (t / 1000) * s.w))
      ctx.fillRect(s.x, s.y, s.s, s.s)
    }
    ctx.globalAlpha = 1
  }
}

const grad = (g: CanvasRenderingContext2D, H: number, stops: [number, string][]) => {
  const lg = g.createLinearGradient(0, 0, 0, H)
  for (const [o, c] of stops) lg.addColorStop(o, c)
  return lg
}
const glow = (g: CanvasRenderingContext2D, x: number, y: number, r0: number, r1: number, c0: string, c1: string) => {
  const rg = g.createRadialGradient(x, y, r0, x, y, r1)
  rg.addColorStop(0, c0)
  rg.addColorStop(1, c1)
  g.fillStyle = rg
  g.fillRect(x - r1, y - r1, r1 * 2, r1 * 2)
}
/** 먼 도시 실루엣 (결정적 배치). lit = 창문 불빛 비율 */
function skyline(g: CanvasRenderingContext2D, W: number, H: number, color: string, lit: number) {
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  g.fillStyle = color
  const rects: [number, number, number, number][] = []
  for (let x = -10; x < W; ) {
    const w = 34 + rnd() * 90, h = H * (0.05 + rnd() * rnd() * 0.17)
    rects.push([x, H - h, w, h])
    g.fillRect(x, H - h, w + 1, h)
    if (rnd() < 0.2) g.fillRect(x + w / 2 - 1, H - h - 18, 2, 18)
    x += w
  }
  if (!lit) return
  g.fillStyle = 'rgba(255,211,110,0.75)'
  for (const [x, y, w] of rects)
    for (let wy = y + 8; wy < H - 6; wy += 9) for (let wx = x + 6; wx < x + w - 6; wx += 8) if (rnd() < lit) g.fillRect(wx, wy, 3, 4)
}
function paintSky(g: CanvasRenderingContext2D, W: number, H: number, kind: FxKind) {
  if (kind === 'sunset') {
    g.fillStyle = grad(g, H, [[0, '#1b1f4a'], [0.35, '#4a2a6a'], [0.58, '#b2456e'], [0.78, '#f07a4a'], [0.92, '#ffc06a']])
    g.fillRect(0, 0, W, H)
    glow(g, W * 0.66, H * 0.86, 0, H * 0.55, 'rgba(255,200,120,0.75)', 'rgba(255,140,90,0)')
    g.fillStyle = '#ffdc8a'
    g.beginPath()
    g.arc(W * 0.66, H * 0.86, H * 0.055, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = 'rgba(255,170,150,0.28)' // 노을에 물든 얇은 구름
    for (const [x, y, w] of [[0.18, 0.56, 0.3], [0.52, 0.63, 0.24], [0.78, 0.5, 0.2], [0.3, 0.7, 0.18]]) {
      g.beginPath()
      g.ellipse(W * x, H * y, W * w * 0.5, H * 0.011, 0, 0, Math.PI * 2)
      g.fill()
    }
    skyline(g, W, H, '#1a1023', 0.05)
  } else if (kind === 'dawn') {
    g.fillStyle = grad(g, H, [[0, '#0f1838'], [0.3, '#3a3f78'], [0.56, '#a58bc0'], [0.76, '#f2b8a0'], [0.92, '#ffe2a8']])
    g.fillRect(0, 0, W, H)
    g.fillStyle = 'rgba(255,255,255,0.5)' // 사라져 가는 별
    for (let i = 0; i < 40; i++) g.fillRect(R() * W, R() * R() * H * 0.35, 1.4, 1.4)
    glow(g, W * 0.3, H * 0.82, 0, H * 0.5, 'rgba(255,236,190,0.8)', 'rgba(255,210,170,0)')
    g.fillStyle = '#fff1c8'
    g.beginPath()
    g.arc(W * 0.3, H * 0.82, H * 0.045, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = grad(g, H, [[0.74, 'rgba(255,255,255,0)'], [0.84, 'rgba(255,240,235,0.22)'], [0.94, 'rgba(255,255,255,0)']]) // 새벽 안개
    g.fillRect(0, 0, W, H)
    skyline(g, W, H, '#2a2748', 0.03)
  } else {
    g.fillStyle = grad(g, H, [[0, '#02040c'], [0.5, '#08102a'], [0.86, '#13204a'], [1, '#1e2f5e']])
    g.fillRect(0, 0, W, H)
    const mx = W * 0.78, my = H * 0.22, r = H * 0.055
    glow(g, mx, my, r, r * 5, 'rgba(245,235,200,0.2)', 'rgba(245,235,200,0)')
    drawMoon(g, mx, my, r, moonPhase(new Date()))
    skyline(g, W, H, '#04060c', 0.22)
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

/** loop = 화면 덮개(a7): 끝나지 않고 계속 (페이드아웃·onDone 없음) */
export function Fx({ kind, onDone, loop: forever = false }: { kind: FxKind; onDone: () => void; loop?: boolean }) {
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
      frame(t, Math.min(0.05, (now - (last || now)) / 1000), Math.max(0, Math.min(1, t / 4000, forever ? 1 : (DUR - t) / 6000)))
      last = now
    }
    if (kind === 'dawn' || kind === 'sunset') frame(0, 0, 1) // 정적 하늘: 1회 그리고 루프 없음 (페이드는 CSS)
    else if (reducedMotion()) for (let i = 0; i < 120; i++) frame(8000 + i * 50, 0.05, 1) // 움직임 없이: 6초 진행시킨 한 장면만
    else raf = requestAnimationFrame(loop)
    const out = forever ? 0 : setTimeout(() => (c.dataset.show = 'false'), DUR - FADE_OUT)
    return () => (cancelAnimationFrame(raf), clearTimeout(out))
  }, [kind, forever])
  return <canvas ref={ref} className="fx" data-sky={SKY.has(kind)} aria-hidden onTransitionEnd={(e) => e.propertyName === 'opacity' && ref.current?.dataset.show === 'false' && done.current()} />
}
