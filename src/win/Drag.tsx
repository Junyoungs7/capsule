import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { isTauri, linkSend, onEvent, reportHitRects, shelfAdd, useValue } from '../data/api'
import { reducedMotion } from '../surfaces/util'
import { colorOf, extOf } from './Panel'
import { colorFor, initial, sendTo, targets, usePeople, type Target } from './people'

/* 끌기 오버레이 (?surface=drag) — 파일을 끄는 동안만 그 모니터를 덮는 투명 창 (Rust drag.rs 가 보이고 숨긴다).
   - 받침: 흔들면 커서 위에 [선반에 올리기 | 맥으로 보내기] (시안 win-tray-v3 .pad, 스프링 등장). 놓기 = 네이티브 드롭(경로).
   - 포탈: 맥과 이어진 가장자리 구간 가까이 가면 커진다 (캔버스). 가장자리에 놓으면(edge.rs) 'portal-drop' → 빨려 들어감 · 섬광 · 충격파 → 보냄.
   - 받는 포탈 (시안 recv-portal): 맥에서 파일을 받으면 'recv-portal' — 맥 가장자리로 보냈으면 이어진 그 자리에 큰 포탈, 아니면 트레이 아이콘 위에 작은 둥근 포탈.
     입자가 밖으로 흘러나오고 파일이 튀어나와 포물선으로 트레이 아이콘에 들어간다 → 알림 카드는 Rust 가 띄운다.
   - 보낼 사람 (시안 people): 펫 위로 가져가면 'fan' → 펫 둘레로 선반 · 내 맥 · 켜진 사람들 (가까운 화면 끝 반대쪽으로 반원, 가운데면 한 바퀴).
     가장자리로 가면 'gates' → 켜진 사람 수만큼 둥근 포탈이 세로로 (맥도 그 줄에). 받침에도 사람들. 놓기 = 네이티브 드롭 → 그 사람에게.
   그리는 것은 끄는 중이거나 애니메이션 중일 때만 (rAF 는 스스로 멈춘다). */
type Fan = { x: number; y: number; mac: boolean }
type Gates = { side: 'left' | 'right'; y: number; mac: boolean }
const FAN_R = 104, GATE_GAP = 128
/** 펫 둘레 자리 (오버레이 좌표): 가까운 화면 끝 반대쪽 반원 (모서리면 좁게), 끝에서 멀면 한 바퀴. 화면 밖으로 안 나가게 */
export function fanSpots(cx: number, cy: number, n: number, W: number, H: number): [number, number][] {
  const k = FAN_R + 50
  const ex = Number(cx < k) - Number(W - cx < k), ey = Number(cy < k) - Number(H - cy < k + 48)
  const edge = !!(ex || ey), mid = Math.atan2(ey, ex), span = edge ? (ex && ey ? Math.PI * 0.6 : Math.PI) : Math.PI * 2
  return Array.from({ length: n }, (_, i) => {
    const a = edge ? mid - span / 2 + (span * i) / Math.max(n - 1, 1) : -Math.PI / 2 + (span * i) / n
    return [Math.min(Math.max(cx + Math.cos(a) * FAN_R, 40), W - 40), Math.min(Math.max(cy + Math.sin(a) * FAN_R, 40), H - 44)]
  })
}
type Side = 'right' | 'left' | 'up' | 'down'
type Pad = { x: number; y: number; mac: boolean; to: [number, number] | null }
const CW = 380, CH = 640 // 포탈 캔버스 (논리 px): 가장자리에서 안쪽으로 CW, 가장자리를 따라 CH
const ROT: Record<Side, number> = { right: 0, left: 180, up: -90, down: 90 }
const IN: Record<Side, [number, number]> = { right: [-1, 0], left: [1, 0], up: [0, 1], down: [0, -1] } // 화면 안쪽 방향

export function DragLayer() {
  const [pad, setPad] = useState<Pad | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [fan, setFan] = useState<Fan | null>(null)
  const [gates, setGates] = useState<Gates | null>(null)
  const { people, near, online } = usePeople()
  const live = (mac: boolean): Target[] => targets(mac ? peer || '내 맥' : null, people, online).filter((t) => t.on)
  const [hint, setHint] = useState(false)
  const [peer] = useValue<string | null>('link.peerName', null)
  const padRef = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const paths = useRef<string[]>([])
  const st = useRef({ ended: false, sending: false })
  const P = useRef({ k: 0, target: 0, x: 0, y: 0, side: 'right' as Side, round: false, out: false, hot: false, flash: 0, shock: 0, spin: 0, run: false, last: 0, parts: [] as { a: number; r: number; v: number; s: number; h: number }[] })
  const REDUCE = reducedMotion()
  // 드롭을 받는 자리 = 받침 + 다 열린 포탈 그림 (나머지는 클릭 통과 — 그 아래 앱이 받는다)
  const hitPad = useRef<DOMRect | null>(null)
  const hitPortal = useRef<DOMRect | null>(null)
  const hitMore = useRef<DOMRect[]>([]) // 펫 둘레 · 사람 포탈
  const sendHits = () => reportHitRects([hitPad.current, hitPortal.current, ...hitMore.current].filter((r): r is DOMRect => !!r))
  /** 다 열린 포탈 그림 둘레 (가장자리에서 안쪽 140 · 가장자리를 따라 ±168) — Rust portal_drop_here 의 reach 와 같은 140 */
  const portalRect = () => {
    const { x, y, side } = P.current
    return side === 'right' ? new DOMRect(x - 140, y - 168, 140, 336) : side === 'left' ? new DOMRect(x, y - 168, 140, 336) : side === 'up' ? new DOMRect(x - 168, y, 336, 140) : new DOMRect(x - 168, y - 140, 336, 140)
  }

  /* ── 포탈 캔버스 ── */
  const place = () => {
    const c = cv.current, p = P.current
    if (!c) return
    const ex = p.round ? CW / 2 : CW
    c.style.left = `${p.x - ex}px`
    c.style.top = `${p.y - CH / 2}px`
    c.style.transformOrigin = `${ex}px ${CH / 2}px`
    c.style.transform = p.round ? 'none' : `rotate(${ROT[p.side]}deg)`
  }
  const setPortal = (target: number) => {
    const p = P.current
    p.target = target
    if (!p.run && (p.target > 0 || p.k > 0 || p.flash > 0)) {
      p.run = true
      p.last = performance.now()
      requestAnimationFrame(frame)
    }
  }
  function frame(now: number) {
    const p = P.current
    const dt = Math.min(0.05, (now - p.last) / 1000)
    p.last = now
    p.k += (p.target - p.k) * Math.min(1, dt * (p.target > p.k ? 10 : 7))
    if (Math.abs(p.target - p.k) < 0.002) p.k = p.target
    const hot = p.k > 0.9
    if (hot !== p.hot) (p.hot = hot), setHint(hot && !st.current.sending), (hitPortal.current = hot && !st.current.sending && !p.out ? portalRect() : null), sendHits()
    p.spin += dt * (hot ? 2.6 : 1.4) * (REDUCE ? 0 : 1)
    p.flash = Math.max(0, p.flash - dt * 2.4)
    if (p.shock > 0) p.shock = Math.min(1.01, p.shock + dt * 2.2)
    draw(dt)
    if (cv.current) (cv.current.dataset.k = p.k.toFixed(2)), (cv.current.dataset.run = '1')
    if (p.k > 0.001 || p.target > 0 || p.flash > 0 || (p.shock > 0 && p.shock < 1)) requestAnimationFrame(frame)
    else {
      p.run = false
      p.shock = 0
      cv.current?.getContext('2d')?.clearRect(0, 0, CW, CH)
      if (cv.current) cv.current.dataset.run = '0'
      settle()
    }
  }
  function draw(dt: number) {
    const c = cv.current
    const cx = c?.getContext('2d')
    if (!c || !cx) return
    const p = P.current
    cx.clearRect(0, 0, CW, CH)
    const k = p.k, ex = p.round ? CW / 2 : CW, ey = CH / 2
    if (k <= 0.001 && p.shock <= 0) return
    const [RX, RY] = p.round ? [46, 46] : [104, 168]
    const rx = RX * k, ry = RY * k, dir = p.out ? -1 : 1 // 받을 때는 거꾸로 돌고 입자가 밖으로
    const spill = cx.createRadialGradient(ex, ey, 0, ex, ey, 300 * Math.max(k, 0.2))
    spill.addColorStop(0, `rgba(80,170,255,${0.32 * k + p.flash * 0.4})`)
    spill.addColorStop(1, 'rgba(80,170,255,0)')
    cx.fillStyle = spill
    cx.fillRect(0, 0, CW, CH)
    const line = cx.createLinearGradient(0, ey - 260, 0, ey + 260)
    line.addColorStop(0, 'rgba(150,220,255,0)')
    line.addColorStop(0.5, `rgba(170,230,255,${0.75 * k})`)
    line.addColorStop(1, 'rgba(150,220,255,0)')
    cx.fillStyle = line
    if (!p.round) cx.fillRect(ex - 2, ey - 260, 2, 520)
    if (k > 0.01) {
      cx.save()
      cx.translate(ex, ey)
      cx.save()
      cx.scale(1, ry / rx)
      const core = cx.createRadialGradient(0, 0, 0, 0, 0, rx)
      core.addColorStop(0, '#02060f')
      core.addColorStop(0.45, '#071a3c')
      core.addColorStop(0.78, '#1554b8')
      core.addColorStop(0.93, '#4fb4ff')
      core.addColorStop(1, 'rgba(120,210,255,0)')
      cx.fillStyle = core
      cx.beginPath()
      cx.arc(0, 0, rx, 0, Math.PI * 2)
      cx.fill()
      cx.restore()
      cx.globalCompositeOperation = 'lighter'
      for (let arm = 0; arm < 4; arm++) {
        cx.beginPath()
        for (let t = 0; t <= 1; t += 0.02) {
          const a = dir * p.spin * (arm % 2 ? 1 : 1.2) + (arm * Math.PI) / 2 + t * 4.2
          const rr = (1 - t) * 0.95
          const px = Math.cos(a) * rx * rr, py = Math.sin(a) * ry * rr
          t === 0 ? cx.moveTo(px, py) : cx.lineTo(px, py)
        }
        cx.strokeStyle = `rgba(${arm % 2 ? '120,200,255' : '190,235,255'},${0.16 + 0.12 * k + p.flash * 0.3})`
        cx.lineWidth = 2.2 * k * (p.round ? 0.6 : 1)
        cx.stroke()
      }
      const sp = (p.hot ? 1.8 : 1) * (st.current.sending ? 2.6 : 1)
      for (const q of p.parts) {
        if (!REDUCE) (q.r -= dir * q.v * dt * 0.55 * sp), (q.a += dir * dt * (1.4 + (1 - q.r) * 3) * sp)
        if (q.r < 0.04) (q.r = 0.95 + Math.random() * 0.15), (q.a = Math.random() * Math.PI * 2)
        if (q.r > 1.1) (q.r = 0.04 + Math.random() * 0.1), (q.a = Math.random() * Math.PI * 2)
        const px = Math.cos(q.a) * rx * q.r, py = Math.sin(q.a) * ry * q.r
        const al = p.out ? Math.min(1, (1.1 - q.r) * 2) : Math.min(1, q.r * 1.6)
        cx.fillStyle = `hsla(${q.h},100%,${70 + 20 * (1 - q.r)}%,${al * (0.55 + 0.45 * k)})`
        cx.beginPath()
        cx.arc(px, py, q.s * (0.6 + 0.6 * q.r) * Math.max(k, 0.4) * (p.round ? 0.7 : 1), 0, Math.PI * 2)
        cx.fill()
      }
      cx.save()
      cx.scale(1, ry / rx)
      cx.lineWidth = 3 + 2 * p.flash
      cx.strokeStyle = `rgba(200,240,255,${0.65 * k + p.flash * 0.35})`
      cx.shadowColor = '#5ab8ff'
      cx.shadowBlur = 24 + 30 * p.flash + (p.hot ? 14 : 0)
      cx.beginPath()
      cx.arc(0, 0, rx, 0, Math.PI * 2)
      cx.stroke()
      cx.shadowBlur = 0
      for (let i = 0; i < 3; i++) {
        const a0 = dir * p.spin * 1.7 + i * 2.1
        cx.strokeStyle = `rgba(255,255,255,${0.85 * k})`
        cx.lineWidth = 2
        cx.beginPath()
        cx.arc(0, 0, rx, a0, a0 + 0.55)
        cx.stroke()
      }
      cx.restore()
      if (p.flash > 0) {
        cx.fillStyle = `rgba(220,245,255,${p.flash * 0.55})`
        cx.save()
        cx.scale(1, ry / rx)
        cx.beginPath()
        cx.arc(0, 0, rx * 0.9, 0, Math.PI * 2)
        cx.fill()
        cx.restore()
      }
      cx.globalCompositeOperation = 'source-over'
      cx.restore()
    }
    if (p.shock > 0 && p.shock < 1) {
      const s = p.shock
      cx.save()
      cx.translate(ex, ey)
      cx.scale(1, p.round ? 1 : 1.55)
      cx.strokeStyle = `rgba(160,225,255,${(1 - s) * 0.9})`
      cx.lineWidth = 6 * (1 - s) + 1
      cx.beginPath()
      if (p.round) cx.arc(0, 0, 30 + s * 110, 0, Math.PI * 2)
      else cx.arc(0, 0, 60 + s * 260, Math.PI / 2, Math.PI * 1.5)
      cx.stroke()
      cx.restore()
    }
  }

  /* ── 끝: 끌기도 애니메이션도 끝나면 숨김 ── */
  const settle = () => {
    const s = st.current
    if (s.ended && !s.sending && !P.current.run) {
      setPad(null), setOver(null), setDone(null), setHint(false), setFan(null), setGates(null)
      hitPad.current = hitPortal.current = null
      hitMore.current = []
      reportHitRects([])
      if (isTauri) void invoke('drag_hide')
    }
  }

  /** 빨려 들어가기: from(오버레이 좌표) → 포탈 가운데, 그다음 섬광 · 충격파 → send */
  const suck = (files: string[], from: [number, number], send: () => void) => {
    const s = st.current, p = P.current
    p.round = p.out = false
    place()
    s.sending = true
    setHint(false)
    setPortal(1)
    const ext = extOf(files[0] ?? '')
    const g = document.createElement('div')
    g.className = 'suck'
    g.textContent = (ext || '파일').toUpperCase().slice(0, 4)
    g.style.background = colorOf(files[0] ?? '')
    g.style.left = `${from[0] - 22}px`
    g.style.top = `${from[1] - 27}px`
    document.body.append(g)
    const [ix, iy] = IN[p.side]
    const tx = p.x + ix * 6, ty = p.y + iy * 6
    const R0 = Math.hypot(tx - from[0], ty - from[1]), A0 = Math.atan2(from[1] - ty, from[0] - tx)
    const frames: Keyframe[] = []
    for (let i = 0; i <= 14; i++) {
      const t = i / 14, e = t * t * (3 - 2 * t)
      const a = A0 + e * Math.PI * 2.2, r = R0 * (1 - e)
      frames.push({ transform: `translate(${tx + Math.cos(a) * r - from[0]}px, ${ty + Math.sin(a) * r * 0.75 - from[1]}px) rotate(${e * 720}deg) scale(${1 - e * 0.95})`, opacity: t > 0.85 ? (1 - t) / 0.15 : 1, offset: t })
    }
    const anim = g.animate(frames, { duration: REDUCE ? 1 : 900, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'forwards' })
    anim.onfinish = () => {
      g.remove()
      p.flash = 1
      p.shock = 0.001
      setPortal(p.target)
      send()
      window.setTimeout(() => ((s.sending = false), setPortal(0), settle()), 520)
    }
  }

  /** 받기: 포탈이 열리고 → 파일이 튀어나와 → 포물선으로 트레이 아이콘(to)에 쏙 (시안 recv-portal) */
  const recv = async (e: { edge: Side | null; x: number; y: number; to: [number, number]; name: string }) => {
    const p = P.current
    if (st.current.sending) return
    st.current = { ended: true, sending: true }
    const wait = (ms: number) => new Promise((r) => window.setTimeout(r, REDUCE ? 0 : ms))
    const [tx, ty] = e.to
    p.round = !e.edge
    p.out = true
    p.side = e.edge ?? 'right'
    ;[p.x, p.y] = e.edge ? [e.x, e.y] : [tx, ty - 110]
    place()
    setPortal(1)
    await wait(420)
    p.flash = 1
    p.shock = 0.001
    const g = document.createElement('div')
    g.className = 'suck'
    g.dataset.recv = e.name
    g.textContent = (extOf(e.name) || '파일').toUpperCase().slice(0, 4)
    g.style.background = colorOf(e.name)
    g.style.left = g.style.top = '0'
    document.body.append(g)
    const [ix, iy] = IN[p.side]
    const out: [number, number] = e.edge ? [p.x + ix * 190, p.y + iy * 190 - 40] : [p.x - 4, p.y - 65]
    const T = (x: number, y: number, r: number, k: number) => `translate(${x - 22}px, ${y - 27}px) rotate(${r}deg) scale(${k})`
    await g.animate([{ transform: T(p.x, p.y, -300, 0.1), opacity: 0 }, { transform: T(...out, -20, 1.12), opacity: 1, offset: 0.75 }, { transform: T(...out, 0, 1), opacity: 1 }],
      { duration: REDUCE ? 1 : 620, easing: 'cubic-bezier(.2,.9,.3,1.2)', fill: 'forwards' }).finished
    setPortal(0)
    await wait(260)
    const kf: Keyframe[] = [], peak = Math.min(out[1], ty) - 90
    for (let i = 0; i <= 24; i++) {
      const t = i / 24, x = out[0] + (tx - out[0]) * t, y = (1 - t) * (1 - t) * out[1] + 2 * (1 - t) * t * peak + t * t * ty
      kf.push({ transform: T(x, y, t * 25, 1 - 0.8 * t), opacity: t > 0.9 ? (1 - t) * 10 : 1 })
    }
    await g.animate(kf, { duration: REDUCE ? 1 : 700, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'forwards' }).finished
    g.remove()
    // 트레이 아이콘 자리에 빛 고리 (아이콘 자체는 셸 것이라 움직일 수 없다)
    const ring = document.createElement('div')
    ring.className = 'recv-ring'
    ring.style.left = `${tx}px`
    ring.style.top = `${ty}px`
    document.body.append(ring)
    await wait(560)
    ring.remove()
    st.current.sending = false
    settle()
  }

  const left = pad ? Math.min(Math.max(pad.x, 170), innerWidth - 170) : 0
  const top = pad ? Math.max(pad.y, 190) : 0
  useLayoutEffect(() => {
    // 받침이 보이는 동안만 그 자리가 드롭 대상 (나머지는 클릭 통과).
    // 다 펼쳐진 자리로 (등장 스프링 중의 작은 모양이 아니라): 가운데 위, 커서 22px 위
    const el = padRef.current
    hitPad.current = pad && el ? new DOMRect(left - el.offsetWidth / 2, top - el.offsetHeight - 22, el.offsetWidth, el.offsetHeight) : null
    sendHits()
  }, [pad])

  useEffect(() => {
    if (!isTauri) return
    P.current.parts = Array.from({ length: 90 }, () => ({ a: Math.random() * Math.PI * 2, r: Math.random(), v: 0.25 + Math.random() * 0.5, s: 0.6 + Math.random() * 1.6, h: 190 + Math.random() * 30 }))
    const c = cv.current!, d = Math.min(devicePixelRatio || 1, 2)
    c.width = CW * d
    c.height = CH * d
    c.getContext('2d')!.setTransform(d, 0, 0, d, 0, 0)
    const zoneAt = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-z]')
      return el && !el.hasAttribute('aria-disabled') ? el.dataset.z! : null
    }
    const offs = [
      onEvent('drag-start', () => ((st.current = { ended: false, sending: false }), (paths.current = []), setPad(null), setOver(null), setDone(null))),
      onEvent<Pad & { to: [number, number] | null }>('pad-show', (e) => setPad(e)),
      onEvent<Fan & { on: boolean }>('fan', (e) => setFan(e.on ? e : null)),
      onEvent<Gates & { on: boolean }>('gates', (e) => setGates(e.on ? e : null)),
      onEvent<{ k: number; side: Side; x: number; y: number }>('portal', (e) => {
        const p = P.current
        if (e.k > 0) (p.x = e.x), (p.y = e.y), (p.side = e.side), (p.round = p.out = false), place()
        if (p.hot && !st.current.sending) (hitPortal.current = portalRect()), sendHits()
        if (!st.current.sending) setPortal(e.k)
      }),
      onEvent<{ paths: string[]; edge: string; pos: number; x: number; y: number }>('portal-drop', (e) =>
        suck(e.paths, [e.x, e.y], () => e.paths.forEach((f) => void linkSend(f, e.edge, e.pos).catch(() => {})))),
      // 단추를 뗌: 가장자리 드롭(portal-drop)이 곧 올 수 있다 → 잠깐 기다렸다 정리
      onEvent<{ edge: Side | null; x: number; y: number; to: [number, number]; name: string }>('recv-portal', (e) => void recv(e)),
      onEvent('drag-end', () => window.setTimeout(() => ((st.current.ended = true), setPortal(0), settle()), 200)),
    ]
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload
      if (p.type === 'enter' && p.paths.length) (paths.current = p.paths), void invoke('drag_file')
      if (p.type === 'leave') return setOver(null)
      if (p.type !== 'enter' && p.type !== 'over' && p.type !== 'drop') return
      const [x, y] = [p.position.x / devicePixelRatio, p.position.y / devicePixelRatio]
      const z = zoneAt(x, y)
      if (p.type !== 'drop') return setOver(z)
      setOver(null)
      const files = p.paths.length ? p.paths : paths.current
      // 보이는 포탈 위에 놓음 → Rust 가 가장 가까운 맥 가장자리로 보낸다 ('portal-drop' 이 와서 빨려 들어감)
      if (!z && files.length && P.current.hot && !st.current.sending) return void invoke('portal_drop_here', { paths: files })
      if (!z || !files.length) return
      setDone(z)
      const fromRing = !!document.querySelector(`.fo[data-z="${z}"], .gate[data-z="${z}"], .pchip[data-z="${z}"]`)
      if (z !== 'shelf' && (z !== 'mac' || fromRing)) {
        // 사람 (또는 펫 둘레 · 사람 포탈의 내 맥): 꿀꺽 → 보냄 (알림은 Rust)
        sendTo(z, files)
        window.setTimeout(() => ((st.current.ended = true), settle()), 420)
        return
      }
      if (z === 'shelf') {
        void shelfAdd(files)
        window.setTimeout(() => ((st.current.ended = true), settle()), 420)
        return
      }
      const orb = document.querySelector('[data-z=mac] .orb')?.getBoundingClientRect()
      const to = padNow.current?.to
      const send = () => files.forEach((f) => void linkSend(f).catch(() => {}))
      if (!to || !orb) return send(), window.setTimeout(() => ((st.current.ended = true), settle()), 420)
      P.current.x = to[0]
      P.current.y = to[1]
      place()
      window.setTimeout(() => setPad(null), 120)
      suck(files, [orb.left + orb.width / 2, orb.top + orb.height / 2], send)
    })
    return () => (offs.forEach((f) => f()), void off.then((f) => f()))
  }, [])
  const padNow = useRef(pad)
  padNow.current = pad
  // 펫 둘레 · 사람 포탈이 보이는 동안 그 동그라미들이 드롭 대상 (등장 스프링이 끝난 자리로 — data-x/y)
  useLayoutEffect(() => {
    hitMore.current = [...document.querySelectorAll<HTMLElement>('.fo, .gate')].map((el) => {
      const r = Number(el.dataset.r)
      return new DOMRect(Number(el.dataset.x) - r, Number(el.dataset.y) - r, r * 2, r * 2)
    })
    sendHits()
  }, [fan, gates, people.length, near])
  const fanT = fan ? [{ id: 'shelf', name: '선반', on: true }, ...live(fan.mac)] : []
  const fanAt = fan ? fanSpots(fan.x, fan.y, fanT.length, innerWidth, innerHeight) : []
  const gateT = gates ? live(gates.mac) : []
  const gy0 = gates ? Math.min(Math.max(gates.y - ((gateT.length - 1) * GATE_GAP) / 2, 70), innerHeight - 70 - (gateT.length - 1) * GATE_GAP) : 0
  const gx = gates?.side === 'left' ? 34 : innerWidth - 34
  const padPeople = pad ? live(false) : []

  const [hx, hy] = IN[P.current.side]
  return (
    <>
      <canvas ref={cv} className="portal" aria-hidden />
      {fan && fanT.map((t, i) => (
        <div key={t.id} className={`fo ${t.id === 'shelf' ? 'shelf' : ''} ${t.id === 'mac' ? 'mac' : ''} ${over === t.id ? 'over' : ''} ${done === t.id ? 'done' : ''}`} data-z={t.id}
          data-x={fanAt[i][0]} data-y={fanAt[i][1]} data-r={30}
          style={{ left: fan.x, top: fan.y, '--dx': `${fanAt[i][0] - fan.x}px`, '--dy': `${fanAt[i][1] - fan.y}px`, '--c': colorFor(t.id), animationDelay: `${i * 35}ms` } as CSSProperties}>
          <span className="av">{t.id === 'shelf' ? '▤' : t.id === 'mac' ? '⌘' : initial(t.name)}</span>{t.name}
        </div>
      ))}
      {gates && gateT.map((t, i) => (
        <div key={t.id} className={`gate ${gates.side} ${t.id === 'mac' ? 'mac' : ''} ${over === t.id ? 'over' : ''} ${done === t.id ? 'done' : ''}`} data-z={t.id}
          data-x={gx} data-y={gy0 + i * GATE_GAP} data-r={58}
          style={{ left: gx, top: gy0 + i * GATE_GAP, '--c': colorFor(t.id), animationDelay: `${i * 60}ms` } as CSSProperties}>
          <i className="ring" /><label>{t.name}</label>
        </div>
      ))}
      <div className={`portal-hint ${hint ? 'on' : ''}`} style={{ left: P.current.x + hx * 118, top: P.current.y + hy * 118 }}>놓으면 {peer || '맥'}으로</div>
      {pad && (
        <div ref={padRef} className="pad on" style={{ left, top }} data-pad>
          <div className="ph">놓을 곳을 고르세요</div>
          <div className="row2">
            <div className={`pz ${over === 'shelf' ? 'over' : ''} ${done === 'shelf' ? 'done' : ''}`} data-z="shelf">
              <span className="orb"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 8h18M5 8v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M9 12h6M7 8l1.5-3h7L17 8" /></svg></span>
              선반에 올리기<small>나중에 꺼내 쓰기</small>
            </div>
            <div className={`pz ${over === 'mac' ? 'over' : ''} ${done === 'mac' ? 'done' : ''}`} data-z="mac" aria-disabled={pad.mac ? undefined : true}>
              <span className="orb"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v9H3V7a1.5 1.5 0 0 1 1.5-1.5zM1.5 19.5h21" /></svg></span>
              맥으로 보내기<small>{pad.mac ? `${peer || '맥'} · 포탈` : '맥 Hera 연결 필요'}</small>
            </div>
          </div>
          {padPeople.length > 0 && (
            <div className="prow">
              {padPeople.map((t) => (
                <div key={t.id} className={`pchip ${over === t.id ? 'over' : ''} ${done === t.id ? 'done' : ''}`} data-z={t.id} style={{ '--c': colorFor(t.id) } as CSSProperties}>
                  <span className="av">{initial(t.name)}</span>{t.name}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
