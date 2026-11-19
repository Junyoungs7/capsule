import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { isTauri, linkSend, onEvent, reportHitRects, shelfAdd, useValue } from '../data/api'
import { reducedMotion } from '../surfaces/util'
import { colorOf, extOf } from './Panel'

/* 끌기 오버레이 (?surface=drag) — 파일을 끄는 동안만 그 모니터를 덮는 투명 창 (Rust drag.rs 가 보이고 숨긴다).
   - 받침: 흔들면 커서 위에 [선반에 올리기 | 맥으로 보내기] (시안 win-tray-v3 .pad, 스프링 등장). 놓기 = 네이티브 드롭(경로).
   - 포탈: 맥과 이어진 가장자리 구간 가까이 가면 커진다 (캔버스). 가장자리에 놓으면(edge.rs) 'portal-drop' → 빨려 들어감 · 섬광 · 충격파 → 보냄.
   그리는 것은 끄는 중이거나 애니메이션 중일 때만 (rAF 는 스스로 멈춘다). */
type Side = 'right' | 'left' | 'up' | 'down'
type Pad = { x: number; y: number; mac: boolean; to: [number, number] | null }
const CW = 380, CH = 640 // 포탈 캔버스 (논리 px): 가장자리에서 안쪽으로 CW, 가장자리를 따라 CH
const ROT: Record<Side, number> = { right: 0, left: 180, up: -90, down: 90 }
const IN: Record<Side, [number, number]> = { right: [-1, 0], left: [1, 0], up: [0, 1], down: [0, -1] } // 화면 안쪽 방향

export function DragLayer() {
  const [pad, setPad] = useState<Pad | null>(null)
  const [over, setOver] = useState<'shelf' | 'mac' | null>(null)
  const [done, setDone] = useState<'shelf' | 'mac' | null>(null)
  const [hint, setHint] = useState(false)
  const [peer] = useValue<string | null>('link.peerName', null)
  const padRef = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const paths = useRef<string[]>([])
  const st = useRef({ ended: false, sending: false })
  const P = useRef({ k: 0, target: 0, x: 0, y: 0, side: 'right' as Side, hot: false, flash: 0, shock: 0, spin: 0, run: false, last: 0, parts: [] as { a: number; r: number; v: number; s: number; h: number }[] })
  const REDUCE = reducedMotion()

  /* ── 포탈 캔버스 ── */
  const place = () => {
    const c = cv.current, p = P.current
    if (!c) return
    c.style.left = `${p.x - CW}px`
    c.style.top = `${p.y - CH / 2}px`
    c.style.transform = `rotate(${ROT[p.side]}deg)`
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
    if (hot !== p.hot) (p.hot = hot), setHint(hot && !st.current.sending)
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
    const k = p.k, ex = CW, ey = CH / 2
    if (k <= 0.001 && p.shock <= 0) return
    const rx = 104 * k, ry = 168 * k
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
    cx.fillRect(ex - 2, ey - 260, 2, 520)
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
          const a = p.spin * (arm % 2 ? 1 : 1.2) + (arm * Math.PI) / 2 + t * 4.2
          const rr = (1 - t) * 0.95
          const px = Math.cos(a) * rx * rr, py = Math.sin(a) * ry * rr
          t === 0 ? cx.moveTo(px, py) : cx.lineTo(px, py)
        }
        cx.strokeStyle = `rgba(${arm % 2 ? '120,200,255' : '190,235,255'},${0.16 + 0.12 * k + p.flash * 0.3})`
        cx.lineWidth = 2.2 * k
        cx.stroke()
      }
      const sp = (p.hot ? 1.8 : 1) * (st.current.sending ? 2.6 : 1)
      for (const q of p.parts) {
        if (!REDUCE) (q.r -= q.v * dt * 0.55 * sp), (q.a += dt * (1.4 + (1 - q.r) * 3) * sp)
        if (q.r < 0.04) (q.r = 0.95 + Math.random() * 0.15), (q.a = Math.random() * Math.PI * 2)
        const px = Math.cos(q.a) * rx * q.r, py = Math.sin(q.a) * ry * q.r
        cx.fillStyle = `hsla(${q.h},100%,${70 + 20 * (1 - q.r)}%,${Math.min(1, q.r * 1.6) * (0.55 + 0.45 * k)})`
        cx.beginPath()
        cx.arc(px, py, q.s * (0.6 + 0.6 * q.r) * Math.max(k, 0.4), 0, Math.PI * 2)
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
        const a0 = p.spin * 1.7 + i * 2.1
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
      cx.scale(1, 1.55)
      cx.strokeStyle = `rgba(160,225,255,${(1 - s) * 0.9})`
      cx.lineWidth = 6 * (1 - s) + 1
      cx.beginPath()
      cx.arc(0, 0, 60 + s * 260, Math.PI / 2, Math.PI * 1.5)
      cx.stroke()
      cx.restore()
    }
  }

  /* ── 끝: 끌기도 애니메이션도 끝나면 숨김 ── */
  const settle = () => {
    const s = st.current
    if (s.ended && !s.sending && !P.current.run) {
      setPad(null), setOver(null), setDone(null), setHint(false)
      reportHitRects([])
      if (isTauri) void invoke('drag_hide')
    }
  }

  /** 빨려 들어가기: from(오버레이 좌표) → 포탈 가운데, 그다음 섬광 · 충격파 → send */
  const suck = (files: string[], from: [number, number], send: () => void) => {
    const s = st.current, p = P.current
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

  const left = pad ? Math.min(Math.max(pad.x, 170), innerWidth - 170) : 0
  const top = pad ? Math.max(pad.y, 190) : 0
  useLayoutEffect(() => {
    // 받침이 보이는 동안만 그 자리가 드롭 대상 (나머지는 클릭 통과).
    // 다 펼쳐진 자리로 (등장 스프링 중의 작은 모양이 아니라): 가운데 위, 커서 22px 위
    const el = padRef.current
    reportHitRects(pad && el ? [new DOMRect(left - el.offsetWidth / 2, top - el.offsetHeight - 22, el.offsetWidth, el.offsetHeight)] : [])
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
      return el && !el.hasAttribute('aria-disabled') ? (el.dataset.z as 'shelf' | 'mac') : null
    }
    const offs = [
      onEvent('drag-start', () => ((st.current = { ended: false, sending: false }), (paths.current = []), setPad(null), setOver(null), setDone(null))),
      onEvent<Pad & { to: [number, number] | null }>('pad-show', (e) => setPad(e)),
      onEvent<{ k: number; side: Side; x: number; y: number }>('portal', (e) => {
        const p = P.current
        if (e.k > 0) (p.x = e.x), (p.y = e.y), (p.side = e.side), place()
        if (!st.current.sending) setPortal(e.k)
      }),
      onEvent<{ paths: string[]; edge: string; pos: number; x: number; y: number }>('portal-drop', (e) =>
        suck(e.paths, [e.x, e.y], () => e.paths.forEach((f) => void linkSend(f, e.edge, e.pos).catch(() => {})))),
      // 단추를 뗌: 가장자리 드롭(portal-drop)이 곧 올 수 있다 → 잠깐 기다렸다 정리
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
      if (!z || !files.length) return
      setDone(z)
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

  const [hx, hy] = IN[P.current.side]
  return (
    <>
      <canvas ref={cv} className="portal" aria-hidden />
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
        </div>
      )}
    </>
  )
}
