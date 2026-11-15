import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type TransitionEvent } from 'react'
import type { AppGroup, LpRecord, ShelfFile } from '../data/types'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { dockTall, iconFor, isTauri, onEvent, power, reportHitRects, taskbarLift, thumbs, wallpaper, type Win } from '../data/api'
import { Shelf } from './Shelf'
import { AsciiWidget, type SceneId } from './Ascii'
import { NotesDockItem } from './Notes'

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

/** 열기·닫기 모두 애니메이션 (패널과 같은 방식): 마운트 → reflow → data-show=true.
    닫기 → data-show=false → opacity transitionend → 언마운트. 숨김 상태 CSS 는 각 표면이 정한다. */
export function usePresence<T extends HTMLElement>(open: boolean) {
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.getBoundingClientRect()
    el.dataset.show = String(open)
  }, [open, mounted])
  const onTransitionEnd = (e: TransitionEvent) => e.target === e.currentTarget && e.propertyName === 'opacity' && !open && setMounted(false)
  return { mounted, ref, onTransitionEnd }
}

/* ── 레코드 타일 (독·크레이트·라이브러리·팔레트 공용) ── */
export function Tile({ rec, size }: { rec: LpRecord; size?: number }) {
  const g = rec.glyph
  // 실제 앱: 추출 아이콘(app) / favicon(fav). 실패하면 아래 글리프·이니셜로 폴백.
  const [img, setImg] = useState<{ src: string; kind: string } | null>(null)
  useEffect(() => {
    let live = true
    setImg(null)
    void iconFor(rec.kind === 'single' ? rec.target : '')?.then((i) => live && setImg(i))
    return () => void (live = false)
  }, [rec.target])
  return (
    <span className="tile" data-img={img?.kind} style={{ '--c': rec.cover, width: size, height: size, fontSize: size } as CSSProperties} aria-hidden>
      {img ? (
        <img src={img.src} alt="" draggable={false} onError={() => setImg(null)} />
      ) : g === 'text' ? (
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
const LIFT_MAX = 72 // 독 창 위 여유 (Rust DOCK 높이 250 = 178 + 72)
const SPREAD = 120 // 확대 시 바가 좌우로 넓어지는 최대 폭(≈ 52px 아이콘 5개 × 코사인 가중 × 0.8) — 펼침 히트 rect 여유

type Item = { el: HTMLElement; mag: HTMLElement | null; c: number; w: number }

type Props = {
  records: LpRecord[]
  running: Set<string>
  panelOpen: boolean
  onLaunch: (r: LpRecord) => void
  onPanel: () => void
  onDropFiles: (paths: string[], toShelf: boolean) => void
  onCue: (r: LpRecord) => void // 우클릭 = 턴테이블에 올리기
  shelf: ShelfFile[]
  onShelfOpen: (f: ShelfFile) => void
  onShelfRemove: (f: ShelfFile) => void
  groups: { group: AppGroup; recs: LpRecord[] }[]
  scene: SceneId
  onAscii: (from: DOMRect) => void
  // 작업 표시줄 대체
  runApps: { rec: LpRecord; wins: Win[] }[] // 고정 안 된 실행 중 앱 (앱별 창 묶음)
  attention: Set<string> // 깜빡이는 앱: 레코드 id · run:<키>
  onWinClick: (w: Win) => void
  onWinClose: (w: Win) => void
  onPin: (r: LpRecord) => void
  onKey: (k: 'start' | 'tray' | 'quick' | 'notify') => void
}

export function Dock({ records, running, panelOpen, onLaunch, onPanel, onDropFiles, onCue, shelf, onShelfOpen, onShelfRemove, groups, scene, onAscii, runApps, attention, onWinClick, onWinClose, onPin, onKey }: Props) {
  const [open, setOpen] = useState(false)
  const [folder, setFolder] = useState<string | null>(null) // 열린 앱 묶음 id
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

  // 자동 숨김 작업 표시줄 공존: 작업 표시줄이 올라오면 독(점·펼침)이 그 높이만큼 창 안에서 스프링으로 올라간다.
  // 독이 펼쳐진 동안엔 내려가지 않는다 — 커서를 독으로 옮기는 사이 작업 표시줄이 숨어도 독이 커서 아래에서 빠지지 않게.
  const [tbLift, setTbLift] = useState(0)
  useEffect(() => {
    if (!isTauri) return
    const f = (px: number) => setTbLift(Math.min(LIFT_MAX, px / devicePixelRatio))
    void taskbarLift().then(f)
    return onEvent<number>('taskbar-lift', f)
  }, [])
  const [lift, setLift] = useState(0)
  useEffect(() => setLift((l) => (open && tbLift < l ? l : tbLift)), [tbLift, open])

  // 히트 rect: 평소 = .dock-hit, 묶음 팝오버가 열린 동안(실제 앱) = 키운 창 전체 (바깥 클릭은 팝오버 닫기로 한 번 먹는다).
  // 창 크기가 바뀌면 .dock-hit 의 클라이언트 위치도 바뀌므로 resize 때 다시 보낸다.
  const report = useRef(() => {})
  report.current = () => {
    if (folder && isTauri) return reportHitRects('dock', [new DOMRect(0, 0, innerWidth, innerHeight)])
    // 올라가는 중이어도 목표 위치로: 지금 애니메이션 중인 translate 값을 빼고 목표 -lift 를 더한다
    const r = hit.current!.getBoundingClientRect(), cur = parseFloat(getComputedStyle(root.current!).translate.split(' ')[1] ?? '0') || 0
    reportHitRects('dock', [new DOMRect(r.x, r.y - cur - lift, r.width, r.height)])
  }
  useLayoutEffect(() => {
    m.current = null
    paint(0, false)
    // 펼침: 바 + 확대 여유(좌우 SPREAD, 위로 확대된 아이콘 높이 — CSS .dock-hit 높이) → 확대 아이콘 윗부분 클릭도 독이 받는다
    hit.current!.style.width = open ? row.current!.offsetWidth + 20 + SPREAD + 'px' : ''
    report.current()
  }, [open, records.length, shelf.length, groups.length, folder, runApps.length, lift])
  useEffect(() => {
    if (!isTauri) return
    const f = () => report.current()
    addEventListener('resize', f)
    return () => removeEventListener('resize', f)
  }, [])

  // v2 묶음 팝오버(실제 앱): 독 창(178px)을 위로 키운 뒤 열고, 닫힘 애니메이션(≈260ms)이 끝나면 되돌린다. 내용은 하단 고정이라 그대로.
  const tall = useRef(false)
  const folderNow = useRef(folder)
  folderNow.current = folder
  const openFolder = async (id: string | null) => {
    reset()
    if (id && isTauri && !tall.current) await dockTall((tall.current = true)).catch(() => {})
    setFolder(id)
  }
  useEffect(() => {
    if (folder || !tall.current) return
    const t = window.setTimeout(() => folderNow.current || void dockTall((tall.current = false)), 320)
    return () => clearTimeout(t)
  }, [folder])

  useEffect(() => () => (clearTimeout(closeTimer.current), cancelAnimationFrame(frame.current)), [])

  // B0-4: 독 = 네이티브 드롭(탐색기 파일). 클릭 통과 폴러가 외부 드래그 진입 시 통과를 해제한다.
  // C4: 끌고 들어오면 독을 펼쳐 선반을 보여 주고, 선반 위에 놓으면 선반으로(그 외 .exe/.lnk = 레코드, 나머지 = 선반).
  const drop = useRef(onDropFiles)
  drop.current = onDropFiles
  useEffect(() => {
    if (!isTauri) return
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload
      clearTimeout(closeTimer.current)
      if (p.type === 'enter' || p.type === 'over') return setOpen(true)
      closeTimer.current = window.setTimeout(() => setOpen(false), 400)
      if (p.type !== 'drop') return
      const s = root.current!.querySelector('.shelf')!.getBoundingClientRect()
      const x = p.position.x / devicePixelRatio, y = p.position.y / devicePixelRatio
      drop.current(p.paths, x >= s.left && x < s.right && y >= s.top && y < s.bottom)
    })
    return () => void off.then((f) => f())
  }, [])

  // B0-1 ②: 실제 앱에서는 배경화면을 정적 캔버스로 1회 그린다 (변경 시 watch 루프가 'wallpaper' emit)
  const wall = useRef<HTMLCanvasElement>(null)
  const [hasWall, setHasWall] = useState(false)
  useEffect(() => {
    if (!isTauri) return
    const draw = () => {
      const c = wall.current // 언마운트 후 늦게 온 'wallpaper' 이벤트 무시
      if (c) void paintWall(c).then(setHasWall)
    }
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
    if (folder) return // 묶음 팝오버가 열려 있으면 독을 접지 않는다 (바깥 클릭/Esc 로 닫힘)
    reset()
    if (open) paint(0, false)
    closeTimer.current = window.setTimeout(() => setOpen(false), 400)
  }
  const move = (e: PointerEvent) => {
    if (!open || folder) return
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
    <div ref={root} className="dock" data-open={open} data-wall={hasWall} data-attention={attention.size > 0} style={{ '--lift': `${lift}px` } as CSSProperties} onPointerEnter={enter} onPointerLeave={leave} onPointerMove={move}>
      <div ref={glass} className="dock-glass">{isTauri && <canvas ref={wall} className="dock-wall" />}</div>
      <div ref={ring} className="dock-ring" />
      <div ref={hit} className="dock-hit" />
      <div ref={row} className="dock-row" role="toolbar" aria-label="독">
        <SysKeys onKey={onKey} />
        <span className="dock-sep" />
        {records.map((r) => (
          <button key={r.id} className="dock-slot" data-running={running.has(r.id)} data-attention={attention.has(r.id)} onClick={(e) => launch(r, e)} onContextMenu={(e) => (e.preventDefault(), onCue(r))} aria-label={`${r.title} 실행 (우클릭: 턴테이블에 올리기)`}>
            <span className="icon-mag">
              <span className="icon-bounce"><Tile rec={r} /></span>
            </span>
            <span className="dock-label">{r.title}</span>
            <span className="dock-dot" />
          </button>
        ))}
        {groups.map(({ group, recs }) => (
          <Folder
            key={group.id}
            group={group}
            recs={recs}
            running={running}
            open={folder === group.id}
            onToggle={(o) => void openFolder(o ? group.id : null)}
            onClose={(inside) => (setFolder(null), inside || (closeTimer.current = window.setTimeout(() => setOpen(false), 400)))}
            onLaunch={onLaunch}
          />
        ))}
        {runApps.length > 0 && <span className="dock-sep" />}
        {runApps.map(({ rec, wins }) => (
          <RunApp
            key={rec.id}
            rec={rec}
            wins={wins}
            attention={attention.has(rec.id)}
            pop={folder === rec.id ? 'wins' : folder === 'menu:' + rec.id ? 'menu' : null}
            onPop={(kind) => void openFolder(kind ? (kind === 'menu' ? 'menu:' : '') + rec.id : null)}
            onClosed={(inside) => (setFolder(null), inside || (closeTimer.current = window.setTimeout(() => setOpen(false), 400)))}
            onWinClick={onWinClick}
            onWinClose={onWinClose}
            onPin={onPin}
          />
        ))}
        <span className="dock-sep" />
        <NotesDockItem />
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
        <Clock open={open} />
        <AsciiWidget id={scene} live={open} onOpen={onAscii} />
        <Battery />
        <Shelf files={shelf} onOpen={onShelfOpen} onRemove={onShelfRemove} onDrop={(paths) => onDropFiles(paths, true)} />
      </div>
    </div>
  )
}

/* v2 앱 묶음(독 폴더): 슬롯 = 2×2 미니 격자, 클릭 → 독 위 격자 팝오버 (슬롯에서 스프링으로 커짐/작아짐).
   실제 앱: 팝오버는 독 창(178px) 위로 넘치므로 열린 동안 독 창을 위로 키운다 (Dock 의 openFolder). */
function Folder({ group, recs, running, open, onToggle, onClose, onLaunch }: {
  group: AppGroup
  recs: LpRecord[]
  running: Set<string>
  open: boolean
  onToggle: (open: boolean) => void
  onClose: (pointerInside: boolean) => void
  onLaunch: (r: LpRecord) => void
}) {
  const p = usePresence<HTMLDivElement>(open)
  const slot = useRef<HTMLDivElement>(null)
  const close = useDismiss(open, slot, onClose)
  return (
    <div ref={slot} className="dock-slot folder" data-running={recs.some((r) => running.has(r.id))} data-open={open}>
      <button className="folder-btn" onClick={() => onToggle(!open)} aria-expanded={open} aria-label={`${group.title} 묶음 · 앱 ${recs.length}개`}>
        <span className="icon-mag">
          <span className="icon-bounce">
            <span className="tile folder-tile">
              {recs.slice(0, 4).map((r) => <Tile key={r.id} rec={r} size={19} />)}
            </span>
          </span>
        </span>
      </button>
      <span className="dock-label">{group.title}</span>
      <span className="dock-dot" />
      {p.mounted && (
        <div ref={p.ref} className="folder-pop glass-card" onTransitionEnd={p.onTransitionEnd} onPointerMove={(e) => e.stopPropagation()} role="dialog" aria-label={`${group.title} 묶음`}>
          <b>{group.title}</b>
          <div className="folder-grid">
            {recs.map((r) => (
              <button key={r.id} data-running={running.has(r.id)} onClick={() => (onLaunch(r), close.current(true))} aria-label={`${r.title} 실행`}>
                <Tile rec={r} size={46} />
                <small>{r.title}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** 팝오버 닫기: 슬롯 바깥 pointerdown(독 줄 안이면 inside=true) · Esc. 반환 = 최신 onClose ref */
function useDismiss(open: boolean, slot: React.RefObject<HTMLElement | null>, onClose: (inside: boolean) => void) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const down = (e: globalThis.PointerEvent) => !slot.current!.contains(e.target as Node) && close.current(!!(e.target as Element).closest?.('.dock-row'))
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close.current(true)
    addEventListener('pointerdown', down)
    addEventListener('keydown', key)
    return () => (removeEventListener('pointerdown', down), removeEventListener('keydown', key))
  }, [open])
  return close
}

/* 작업 표시줄 대체: 독 왼쪽 2×2 작은 버튼 — 시작 · 숨은 트레이 · 빠른 설정 · 알림 센터 (Rust 가 Win 키 조합을 보낸다) */
function SysKeys({ onKey }: { onKey: Props['onKey'] }) {
  const keys = [
    ['start', '시작', <path key="s" d="M5 5h6v6H5zM13 5h6v6h-6zM5 13h6v6H5zM13 13h6v6h-6z" />],
    ['tray', '숨은 아이콘', <path key="t" d="M7 14l5-5 5 5" />],
    ['quick', '빠른 설정', <path key="q" d="M5 8h9M18 8h1M5 16h1M10 16h9M16 6v4M8 14v4" />],
    ['notify', '알림 센터', <path key="n" d="M7 16V11a5 5 0 0 1 10 0v5l1.5 2h-13zM10.5 20h3" />],
  ] as const
  return (
    <div className="dock-slot sys-keys" role="group" aria-label="Windows">
      {keys.map(([k, label, icon]) => (
        <button key={k} onClick={() => onKey(k)} aria-label={label} title={label}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
        </button>
      ))}
    </div>
  )
}

/* 고정 안 된 실행 중 앱: 창 1개 = 클릭으로 활성/최소화/복원, 여러 개 = 창 목록 팝오버(DWM 썸네일). 우클릭 = 고정·닫기 메뉴.
   팝오버는 앱 묶음과 같은 독 키우기·닫기 경로(folder 상태)를 쓴다. */
function RunApp({ rec, wins, attention, pop, onPop, onClosed, onWinClick, onWinClose, onPin }: {
  rec: LpRecord
  wins: Win[]
  attention: boolean
  pop: 'wins' | 'menu' | null
  onPop: (kind: 'wins' | 'menu' | null) => void
  onClosed: (pointerInside: boolean) => void
  onWinClick: (w: Win) => void
  onWinClose: (w: Win) => void
  onPin: (r: LpRecord) => void
}) {
  const slot = useRef<HTMLDivElement>(null)
  const close = useDismiss(!!pop, slot, onClosed)
  const wp = usePresence<HTMLDivElement>(pop === 'wins')
  const mp = usePresence<HTMLDivElement>(pop === 'menu')
  // 썸네일: 팝오버 스프링이 끝난 뒤(transform transitionend) 칸 위치에 등록, 닫히기 시작하면 바로 해제 (DWM 은 CSS 변형을 못 따라간다)
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (pop !== 'wins' || !settled) return
    const el = wp.ref.current
    if (!el) return
    const slots = [...el.querySelectorAll<HTMLElement>('.win-thumb[data-min="false"]')]
    void thumbs(slots.map((s) => [Number(s.dataset.hwnd), s.getBoundingClientRect()]))
    return () => void thumbs([])
  }, [pop, settled, wins])
  useEffect(() => void (pop !== 'wins' && setSettled(false)), [pop])
  const click = () => (wins.length === 1 ? onWinClick(wins[0]) : onPop(pop === 'wins' ? null : 'wins'))
  return (
    <div ref={slot} className="dock-slot folder run-app" data-running data-attention={attention} data-open={!!pop}>
      <button className="folder-btn" onClick={click} onContextMenu={(e) => (e.preventDefault(), onPop('menu'))} aria-label={`${rec.title} · 창 ${wins.length}개 (우클릭: 메뉴)`}>
        <span className="icon-mag">
          <span className="icon-bounce"><Tile rec={rec} /></span>
        </span>
      </button>
      <span className="dock-label">{rec.title}</span>
      <span className="dock-dot" />
      {wp.mounted && (
        <div
          ref={wp.ref}
          className="folder-pop glass-card win-pop"
          onTransitionEnd={(e) => (wp.onTransitionEnd(e), e.target === e.currentTarget && e.propertyName === 'transform' && pop === 'wins' && setSettled(true))}
          onPointerMove={(e) => e.stopPropagation()}
          role="dialog"
          aria-label={`${rec.title} 창 목록`}
        >
          <b>{rec.title}</b>
          <div className="win-grid">
            {wins.map((w) => (
              <div key={w.hwnd} className="win-card" role="button" tabIndex={0} data-flash={w.flash}
                onClick={() => (onWinClick(w), close.current(true))}
                onAuxClick={(e) => e.button === 1 && onWinClose(w)}
                onKeyDown={(e) => e.key === 'Enter' && (onWinClick(w), close.current(true))}
              >
                <span className="win-thumb" data-hwnd={w.hwnd} data-min={w.min}><Tile rec={rec} size={34} /></span>
                <small>{w.title}</small>
                <button className="win-x" onClick={(e) => (e.stopPropagation(), onWinClose(w))} aria-label={`${w.title} 닫기`}>×</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {mp.mounted && (
        <div ref={mp.ref} className="folder-pop glass-card run-menu" onTransitionEnd={mp.onTransitionEnd} role="menu" aria-label={`${rec.title} 메뉴`}>
          <button role="menuitem" onClick={() => (onPin(rec), close.current(true))}>독에 고정</button>
          <button role="menuitem" onClick={() => (wins.forEach(onWinClose), close.current(true))}>{wins.length > 1 ? `창 ${wins.length}개 닫기` : '창 닫기'}</button>
        </div>
      )}
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

function Clock({ open }: { open: boolean }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    // 독이 펼쳐져 있을 때만: 펼칠 때 현재 시각, 이후 분이 바뀔 때마다 1회 — 접힌 동안 타이머·렌더 없음
    if (!open) return
    let t = 0
    const tick = () => {
      const d = new Date()
      setNow(d)
      t = window.setTimeout(tick, 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()))
    }
    tick()
    return () => clearTimeout(t)
  }, [open])
  return (
    <div className="dock-slot widget clock" aria-label="시계">
      <b>{now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</b>
      <small>{now.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' })}</small>
    </div>
  )
}

// C4: GetSystemPowerStatus 1회 + watch 루프가 바뀔 때만 'power' 이벤트 (JS 타이머 없음). 배터리 없으면 숨김. 시안 = 82%.
function Battery() {
  const [p, setP] = useState<[number, boolean] | null>(isTauri ? null : [82, false])
  useEffect(() => {
    if (!isTauri) return
    void power().then(setP)
    return onEvent('power', setP)
  }, [])
  if (!p) return null
  const [level, charging] = p
  return (
    <div className="dock-slot widget battery" data-charging={charging} aria-label={`배터리 ${level}%${charging ? ', 충전 중' : ''}`}>
      <svg viewBox="0 0 36 36" aria-hidden>
        <circle cx="18" cy="18" r="14" className="track" />
        <circle cx="18" cy="18" r="14" className="val" pathLength={100} strokeDasharray={`${level} 100`} />
      </svg>
      <b>{level}</b>
    </div>
  )
}
