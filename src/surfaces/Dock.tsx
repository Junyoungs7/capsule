import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import type { LpRecord } from '../data/types'
import { isTauri, onEvent, reportHitRects, wallpaper } from '../data/api'
import { Shelf } from './Shelf'

/* ── 공용: 둥근 사각형 clip-path (dock·island 가 공유) ──────────────────────
   글라스 레이어는 최대 크기로 고정하고 모양만 clip-path 로 바꾼다.
   1px 하이라이트 테두리는 같은 모양의 링(evenodd)으로 그린다 — 명령 구성이 같아서 path() 끼리 보간된다. */
const rr = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}` +
  `H${x + r}A${r},${r} 0 0 1 ${x},${y + h - r}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}Z`

export function shape(x: number, y: number, w: number, h: number, r: number) {
  return {
    glass: `path("${rr(x, y, w, h, r)}")`,
    ring: `path(evenodd, "${rr(x, y, w, h, r)}${rr(x + 1, y + 1, w - 2, h - 2, Math.max(0, r - 1))}")`,
  }
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/* ── 레코드 타일 (독·크레이트·라이브러리·팔레트 공용) ── */
export function Tile({ rec, size }: { rec: LpRecord; size?: number }) {
  const g = rec.glyph
  return (
    <span className="tile" style={{ '--c': rec.cover, width: size, height: size, fontSize: size } as CSSProperties} aria-hidden>
      {g === 'text' ? (
        <b>{rec.title.slice(0, 1)}</b>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          {g === 'calc' && (<><rect x="5" y="3.5" width="14" height="17" rx="3" /><path d="M8 7.5h8" /><path d="M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h.01" strokeWidth="2.4" /></>)}
          {g === 'notepad' && (<><path d="M6.5 3.5h8l3 3v14h-11z" /><path d="M9 10h6M9 13.5h6M9 17h3.5" /></>)}
          {g === 'code' && (<><path d="M9 7l-5 5 5 5M15 7l5 5-5 5" /><path d="M13.2 5.5l-2.4 13" /></>)}
          {g === 'chrome' && (<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.2" /><path d="M12 8.8h7.6M9.2 13.6L5.4 7M14.8 13.6l-3.8 6.9" /></>)}
          {g === 'set' && (<><circle cx="9" cy="12" r="5.5" /><circle cx="15" cy="12" r="5.5" /><circle cx="15" cy="12" r="1.2" /></>)}
        </svg>
      )}
    </span>
  )
}

const MAX = 1.8 // 최대 배율
const R = 170 // 코사인 감쇠 반경(px)
const BOX = 84 // 바 레이어 높이 (스프링 오버슈트 여유 포함)
const BAR_H = 72

type Item = { el: HTMLElement; mag: HTMLElement | null; c: number; w: number }

type Props = {
  records: LpRecord[]
  running: Set<string>
  panelOpen: boolean
  onLaunch: (r: LpRecord) => void
  onPanel: () => void
}

export function Dock({ records, running, panelOpen, onLaunch, onPanel }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)
  const glass = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLDivElement>(null)
  const hit = useRef<HTMLDivElement>(null)
  const closeTimer = useRef(0)
  const frame = useRef(0)
  const px = useRef(0)
  const m = useRef<{ left: number; W: number; barW: number; items: Item[] } | null>(null)

  // 모양 쓰기: 펼침/접힘은 스프링, 확대 추종은 짧은 ease-out
  const paint = (extra: number, fast: boolean) => {
    const W = root.current!.offsetWidth
    const barW = row.current!.offsetWidth + 20
    const s = open
      ? shape((W - barW - extra) / 2, BOX - BAR_H, barW + extra, BAR_H, 22)
      : shape((W - 40) / 2, BOX - 12, 40, 6, 3)
    const t = fast ? 'clip-path 140ms var(--ease-out)' : 'clip-path var(--dur-bouncy) var(--spring-bouncy)'
    glass.current!.style.transition = ring.current!.style.transition = t
    glass.current!.style.clipPath = s.glass
    ring.current!.style.clipPath = s.ring
  }

  useLayoutEffect(() => {
    m.current = null
    paint(0, false)
    hit.current!.style.width = open ? row.current!.offsetWidth + 20 + 'px' : ''
    reportHitRects('dock', [hit.current!.getBoundingClientRect()])
  }, [open, records.length])

  useEffect(() => () => (clearTimeout(closeTimer.current), cancelAnimationFrame(frame.current)), [])

  // B0-1 ②: 실제 앱에서는 배경화면을 정적 캔버스로 1회 그린다 (변경 시 watch 루프가 'wallpaper' emit)
  const wall = useRef<HTMLCanvasElement>(null)
  const [hasWall, setHasWall] = useState(false)
  useEffect(() => {
    if (!isTauri) return
    const draw = () => paintWall(wall.current!).then(setHasWall)
    draw()
    return onEvent('wallpaper', draw)
  }, [])

  const measure = () => {
    const r = root.current!, rw = row.current!
    const items = [...rw.children].map((n) => {
      const el = n as HTMLElement
      return { el, mag: el.querySelector<HTMLElement>('.icon-mag'), c: el.offsetLeft + el.offsetWidth / 2, w: el.offsetWidth }
    })
    return { left: r.getBoundingClientRect().left + (r.offsetWidth - rw.offsetWidth) / 2, W: r.offsetWidth, barW: rw.offsetWidth + 20, items }
  }

  // pointermove → rAF 1회 → ref 로 transform 직접 갱신 (React state 없음)
  const apply = () => {
    frame.current = 0
    const mm = (m.current ??= measure())
    const x = px.current - mm.left
    // 위젯(시계·배터리·선반) 구역에서는 확대 없음: 마지막 아이콘 끝을 넘으면 40px 동안 확대를 0으로 감쇠
    const last = mm.items.filter((it) => it.mag).pop()!
    const fade = Math.max(0, Math.min(1, 1 - (x - (last.c + last.w / 2)) / 40))
    const ext = mm.items.map((it) => {
      if (!it.mag) return 0
      const d = Math.abs(x - it.c)
      return d < R ? (fade * it.w * (MAX - 1) * (1 + Math.cos((Math.PI * d) / R))) / 2 : 0
    })
    const total = ext.reduce((a, b) => a + b, 0)
    let acc = 0
    mm.items.forEach((it, i) => {
      it.el.style.transform = `translateX(${acc + ext[i] / 2 - total / 2}px)`
      if (it.mag) it.mag.style.transform = `scale(${1 + ext[i] / it.w})`
      acc += ext[i]
    })
    paint(total, true)
  }

  const reset = () => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
    m.current = null
    for (const n of row.current!.children) {
      const el = n as HTMLElement
      el.style.transform = ''
      const mag = el.querySelector<HTMLElement>('.icon-mag')
      if (mag) mag.style.transform = ''
    }
  }

  const enter = () => {
    clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const leave = () => {
    reset()
    if (open) paint(0, false)
    closeTimer.current = window.setTimeout(() => setOpen(false), 400)
  }
  const move = (e: PointerEvent) => {
    if (!open) return
    px.current = e.clientX
    if (!frame.current) frame.current = requestAnimationFrame(apply)
  }

  const launch = (r: LpRecord, e: MouseEvent<HTMLButtonElement>) => {
    const b = e.currentTarget.querySelector('.icon-bounce')!
    const up = 'cubic-bezier(.2,.6,.35,1)', down = 'cubic-bezier(.55,0,.8,.45)'
    b.animate(
      reducedMotion()
        ? [{ opacity: 1 }, { opacity: 0.45 }, { opacity: 1 }]
        : [
            { transform: 'translateY(0)', easing: up },
            { transform: 'translateY(-26px)', offset: 0.24, easing: down },
            { transform: 'translateY(0)', offset: 0.46, easing: up },
            { transform: 'translateY(-11px)', offset: 0.63, easing: down },
            { transform: 'translateY(0)', offset: 0.79, easing: up },
            { transform: 'translateY(-4px)', offset: 0.9, easing: down },
            { transform: 'translateY(0)' },
          ],
      { duration: 950 },
    )
    onLaunch(r)
  }

  return (
    <div ref={root} className="dock" data-open={open} data-wall={hasWall} onPointerEnter={enter} onPointerLeave={leave} onPointerMove={move}>
      <div ref={glass} className="dock-glass">{isTauri && <canvas ref={wall} className="dock-wall" />}</div>
      <div ref={ring} className="dock-ring" />
      <div ref={hit} className="dock-hit" />
      <div ref={row} className="dock-row" role="toolbar" aria-label="독">
        {records.map((r) => (
          <button key={r.id} className="dock-slot" data-running={running.has(r.id)} onClick={(e) => launch(r, e)} aria-label={`${r.title} 실행`}>
            <span className="icon-mag">
              <span className="icon-bounce"><Tile rec={r} /></span>
            </span>
            <span className="dock-label">{r.title}</span>
            <span className="dock-dot" />
          </button>
        ))}
        <span className="dock-sep" />
        <button className="dock-slot" data-running={panelOpen} onClick={onPanel} aria-label="할 일 · 달력 · 라이브러리 패널">
          <span className="icon-mag">
            <span className="icon-bounce">
              <span className="tile tile-sys">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><rect x="4" y="5" width="16" height="15" rx="3" /><path d="M4 10h16M9 3v4M15 3v4" /><path d="M8.5 14.5l2 2 4-4" /></svg>
              </span>
            </span>
          </span>
          <span className="dock-label">패널</span>
          <span className="dock-dot" />
        </button>
        <span className="dock-sep" />
        <Clock />
        <Battery level={82} />
        <Shelf />
      </div>
    </div>
  )
}

/* 배경화면 페이크: 바탕화면에서 캔버스 위치에 해당하는 부분만 1/4 해상도로 그려 블러·채도를 구워 넣는다
   (CSS filter/backdrop-filter 없음 → 상시 비용 0). 창 뒤의 앱은 보이지 않는다.
   배치: 채우기(10)·맞춤(6)·늘이기(2), 그 외는 채우기로 취급. 맞춤의 여백은 바탕색. */
async function paintWall(c: HTMLCanvasElement) {
  const [blob, [style, bg]] = await wallpaper()
  const img = blob && (await createImageBitmap(blob).catch(() => null))
  if (!img) return false
  const r = c.getBoundingClientRect()
  const k = 4 // 축소 배율 (블러가 어차피 디테일을 지운다)
  const W = screen.width, H = screen.height
  const fit = style === '6' ? Math.min : Math.max
  const sw = style === '2' ? W / img.width : fit(W / img.width, H / img.height)
  const sh = style === '2' ? H / img.height : sw
  // 화면 좌표계의 배경화면 rect → 캔버스 좌표계(1/k)
  const x = ((W - img.width * sw) / 2 - screenX - r.left) / k
  const y = ((H - img.height * sh) / 2 - screenY - r.top) / k
  c.width = Math.ceil(r.width / k)
  c.height = Math.ceil(r.height / k)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = `rgb(${bg.split(' ').join(',') || '0,0,0'})`
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.filter = `blur(${28 / k}px) saturate(1.85)`
  ctx.drawImage(img, x, y, (img.width * sw) / k, (img.height * sh) / k)
  img.close()
  return true
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    // 분이 바뀔 때만 1회 갱신 — 상시 타이머 없음
    const t = setTimeout(() => setNow(new Date()), 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()))
    return () => clearTimeout(t)
  }, [now])
  return (
    <div className="dock-slot widget clock" aria-label="시계">
      <b>{now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</b>
      <small>{now.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' })}</small>
    </div>
  )
}

// 시안: 고정값 (C4 에서 GetSystemPowerStatus)
function Battery({ level }: { level: number }) {
  return (
    <div className="dock-slot widget battery" aria-label={`배터리 ${level}%`}>
      <svg viewBox="0 0 36 36" aria-hidden>
        <circle cx="18" cy="18" r="14" className="track" />
        <circle cx="18" cy="18" r="14" className="val" pathLength={100} strokeDasharray={`${level} 100`} />
      </svg>
      <b>{level}</b>
    </div>
  )
}
