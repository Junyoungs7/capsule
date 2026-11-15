import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import type { NextItem } from './Island'
import { fmtWhen } from './Island'
import { reducedMotion, usePresence } from './Tile'

/* 허브 (레이아웃 A): 노치를 누르거나 0.3초 머물면 아일랜드 창 안에서 아래로 펼쳐진다.
   위 = 오늘 줄, 가운데 = 이름 붙은 아이콘 13개, 아래 = '앱 실행 · 검색'.
   아이콘 = 그 기능 화면을 아일랜드 안에서 연다 (제자리 넘김, ‹ 뒤로). 떠 있는 창은 '떼어낼' 때만:
   ↗ 버튼 · 머리줄을 24px 넘게 끌어내기 · (달력·채팅) 머리줄 두 번 누르기. 흡수 = 그 창을 노치로 끌어다 놓기 (Desktop 이 처리). */

export type HubKind = 'notes' | 'todo' | 'calendar' | 'chat' | 'term' | 'clips' | 'shelf' | 'ocr' | 'snippets' | 'lp' | 'team' | 'link' | 'settings'
/** 아일랜드 안에서 여는 화면 (메모·LP = 바탕화면 소품, 설정 = 패널) */
export type ViewKind = 'todo' | 'calendar' | 'chat' | 'term' | 'clips' | 'shelf' | 'ocr' | 'snippets' | 'team' | 'link'
export const VIEWS: ViewKind[] = ['todo', 'calendar', 'chat', 'term', 'clips', 'shelf', 'ocr', 'snippets', 'team', 'link']
/** 안의 화면 크기 (논리 px) — 떼어내면 이 크기로 창이 된다 */
export const VIEW_SIZE: Record<ViewKind, [number, number]> = {
  term: [640, 300], calendar: [480, 420], chat: [400, 480], todo: [380, 420], clips: [380, 380], shelf: [360, 300],
  snippets: [380, 380], team: [400, 460], link: [380, 320], ocr: [340, 200],
}

const I: Record<HubKind, string> = {
  notes: 'M6 4h9l3 3v13H6zM9 10h6M9 14h6',
  todo: 'M4 12.5l3 3 6-6M14 7h6M14 12h6M14 17h6',
  calendar: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  chat: 'M4 5h16v11H9l-5 4zM8 10h8M8 13h5',
  term: 'M4 5h16v14H4zM7 10l3 2-3 2M12 15h5',
  clips: 'M8 4h8v4H8zM6 6H5v14h14V6h-1M9 13h6M9 16h4',
  shelf: 'M4 14v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3M12 4v10M8 10l4 4 4-4',
  ocr: 'M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M8 10h8M8 14h5',
  snippets: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  lp: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM12 6.2a5.8 5.8 0 0 1 5.4 3.7',
  team: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 0 1 0 6M18 15c2 .5 3 2.5 3 5',
  link: 'M4 6h11v8H4zM8 18h3M17 9h4v10h-4z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .3-1.5-1.5L17 5l-3-1-1 2h-2L10 4 7 5l.5 2.3L6 8.8 4 8.5l-1 3 2 1v1l-2 1 1 3 2-.3 1.5 1.5L7 19.9l3 1 1-2h2l1 2 3-1-.5-2.3 1.5-1.5 2 .3 1-3-2-1z',
}
export const HUB_ITEMS: [HubKind, string][] = [
  ['notes', '메모'], ['todo', '할 일'], ['calendar', '달력'], ['chat', '채팅'], ['term', '터미널'],
  ['clips', '최근 복사'], ['shelf', '선반'], ['ocr', 'OCR'], ['snippets', '스니펫'], ['lp', 'LP'],
  ['team', 'Team'], ['link', 'Link'], ['settings', '설정'],
]
export const LABEL = Object.fromEntries(HUB_ITEMS) as Record<HubKind, string>
export const Ico = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
export const ICON = I

/* ── 프레임 기록 (떼어내기·흡수 애니메이션 동안만 — CDP 시험이 읽는다) ── */
type W = Window & { __heraFrames?: number[] }
let rec = 0
/** 움직이는 동안만 기록 — 돌려준 함수로 멈춘다 (진짜 창을 만드는 동안 유령은 멈춰 있으니 세지 않는다) */
export function recordFrames(ms: number) {
  const w = window as W
  w.__heraFrames ??= []
  const end = performance.now() + ms
  let last = performance.now()
  const id = ++rec
  let on = true
  const tick = (t: number) => {
    if (!on) return
    w.__heraFrames!.push(t - last)
    last = t
    if (t < end && id === rec) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return () => void (on = false)
}

/* ── 스프링 ── */
const SPRING = 'cubic-bezier(.2, 1.35, .35, 1)' // 맥 같은 살짝 넘치는 정착 (--spring-bouncy 와 같은 느낌)
const lerp = (a: number, b: number, k: number) => a + (b - a) * k

export type Ghost = { kind: ViewKind; rect: DOMRect; mode: 'detach' | 'absorb'; auto?: DOMRect }

type Props = {
  open: boolean
  view: ViewKind | null
  onView: (v: ViewKind | null) => void
  next: NextItem | null
  todos: number
  badges: Partial<Record<HubKind, ReactNode>>
  onPick: (k: HubKind) => void // 화면이 아닌 것 (메모 · LP · OCR 은 화면, 설정)
  onNewNote: () => void
  onPalette: () => void
  onRect: (r: DOMRect | null) => void
  renderView: (k: ViewKind, ghost?: boolean) => ReactNode
  viewTools?: (k: ViewKind) => ReactNode // 머리줄 오른쪽 (터미널: 아라 버튼)
  onDetach: (k: ViewKind, from: DOMRect, how: 'drag' | 'button', pointer?: { x: number; y: number; dx: number; dy: number; id: number; el: HTMLElement }) => void
  onClose: () => void
}

export function Hub({ open, view, onView, next, todos, badges, onPick, onNewNote, onPalette, onRect, renderView, viewTools, onDetach, onClose }: Props) {
  const p = usePresence<HTMLDivElement>(open)
  const [dir, setDir] = useState(1)
  const size = view ? VIEW_SIZE[view] : null
  useLayoutEffect(() => {
    const el = p.ref.current
    onRect(open && el ? new DOMRect(el.offsetLeft - el.offsetWidth / 2, el.offsetTop, el.offsetWidth, el.offsetHeight) : null)
  }, [open, p.mounted, view])
  const go = (v: ViewKind | null) => (setDir(v ? 1 : -1), onView(v))

  // 머리줄 끌기: 24px 안 = 고무줄(0.3배), 넘으면 떼어내기 (Desktop 이 유령·창을 맡는다)
  const headDown = (e: RPointerEvent<HTMLElement>) => {
    if (!view || (e.target as Element).closest('button, input, a, label')) return
    const box = p.ref.current!
    const head = e.currentTarget
    const [x0, y0] = [e.clientX, e.clientY]
    head.setPointerCapture(e.pointerId)
    box.style.transition = 'none'
    let done = false
    const move = (ev: PointerEvent) => {
      if (done) return
      const [dx, dy] = [ev.clientX - x0, ev.clientY - y0]
      if (Math.hypot(dx, dy) < 24) {
        box.style.transform = `translate(calc(-50% + ${dx * 0.3}px), ${dy * 0.3}px) scale(${1 + Math.min(Math.abs(dy), 24) * 0.0012}, ${1 + Math.min(Math.abs(dy), 24) * 0.002})`
        return
      }
      done = true
      cleanup()
      const r = box.getBoundingClientRect()
      onDetach(view, r, 'drag', { x: ev.clientX, y: ev.clientY, dx: ev.clientX - r.left, dy: ev.clientY - r.top, id: ev.pointerId, el: head })
    }
    const up = () => {
      if (done) return
      cleanup()
      // 문턱 안에서 놓음 → 스프링으로 제자리
      box.style.transition = `transform 420ms ${SPRING}`
      box.style.transform = ''
    }
    const cleanup = () => {
      head.removeEventListener('pointermove', move)
      head.removeEventListener('pointerup', up)
      head.removeEventListener('pointercancel', up)
    }
    head.addEventListener('pointermove', move)
    head.addEventListener('pointerup', up)
    head.addEventListener('pointercancel', up)
  }

  if (!p.mounted) return null
  const term = view === 'term'
  return (
    <div ref={p.ref} className="hub" data-view={view ?? 'home'} data-term={term} onTransitionEnd={p.onTransitionEnd} role="dialog" aria-label="Hera 허브"
      style={size ? ({ '--vw': `${size[0]}px`, '--vh': `${size[1]}px` } as CSSProperties) : undefined}>
      {view ? (
        <>
          <header className="hub-vhead" onPointerDown={headDown} onDoubleClick={() => (view === 'calendar' || view === 'chat') && onDetach(view, p.ref.current!.getBoundingClientRect(), 'button')} title="끌어서 떼어내기">
            {!term && <button className="hub-back" onClick={() => go(null)} aria-label="뒤로"><Ico d="M15 5l-7 7 7 7" /></button>}
            {!term && <b>{LABEL[view]}</b>}
            {viewTools?.(view)}
            {!term && (
              <button className="hub-detach" onClick={() => onDetach(view, p.ref.current!.getBoundingClientRect(), 'button')} aria-label="크게 보기 · 떼어내기" title="크게 보기 · 떼어내기 (끌어내도 돼요)">
                <Ico d="M14 4h6v6M20 4l-8 8M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
              </button>
            )}
            {term && <button className="hub-detach" onClick={onClose} aria-label="닫기 (셸은 계속 돌아요)" title="닫기 · Esc (셸은 계속 돌아요)"><Ico d="M7 7l10 10M17 7L7 17" /></button>}
          </header>
          <div className="hub-vbody" key={view} data-dir={dir}>{renderView(view)}</div>
        </>
      ) : (
        <div className="hub-home" data-dir={dir}>
          <div className="hub-today">
            <span className="hub-next">
              <i data-kind={next?.kind ?? 'none'} />
              <b>{next ? next.title : '예정된 일정이 없어요'}</b>
              {next?.at && <small>{fmtWhen(next.at)}</small>}
            </span>
            <span className="hub-count" title="남은 할 일">할 일 {todos}</span>
          </div>
          <div className="hub-grid">
            {HUB_ITEMS.map(([k, label]) => (
              <span key={k} className="hub-cell">
                <button className="hub-icon" data-k={k} onClick={() => ((VIEWS as string[]).includes(k) ? go(k as ViewKind) : onPick(k))} aria-label={label}>
                  <span className="hub-ico"><Ico d={I[k]} />{badges[k] != null && badges[k] !== false && <em>{badges[k]}</em>}</span>
                  <span className="hub-label">{label}</span>
                </button>
                {k === 'notes' && <button className="hub-plus" onClick={onNewNote} aria-label="새 메모" title="새 메모">+</button>}
              </span>
            ))}
          </div>
          <button className="hub-k" onClick={onPalette}>
            <span>앱 실행 · 나머지 검색</span>
            <kbd>Ctrl Alt K</kbd>
          </button>
        </div>
      )}
    </div>
  )
}

/* ── 떼어내기 · 흡수 유령 (아일랜드 창이 화면 높이로 커진 동안 화면 어디든 따라간다) ──
   떼어내기: 들림(1.03 · 그림자) → 커서를 살짝 늦게 따라감(스프링) → 노치와 잇던 '목'이 늘어나다 끊김 → 놓으면 살짝 넘치며 정착 → 진짜 창과 바꿔치기.
   흡수: 창 자리에 유령 → 노치로 지니처럼 빨려 듦(모서리가 알약으로, 내용은 늦게 사라짐) → 노치가 '꿀꺽' 튐. */
export function GhostLayer({ ghost, render, notch, onDetachDrop, onDone }: {
  ghost: (Ghost & { pointer?: { x: number; y: number; dx: number; dy: number; id: number; el: HTMLElement } }) | null
  render: (k: ViewKind) => ReactNode
  notch: () => DOMRect | null
  onDetachDrop: (k: ViewKind, rect: DOMRect) => Promise<void> // 진짜 창이 보이면 끝
  onDone: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const neck = useRef<SVGPathElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!ghost || !el) return
    const stopRec = recordFrames(2600)
    const r0 = ghost.rect
    const rm = reducedMotion()
    let raf = 0
    let alive = true
    const place = (x: number, y: number, s = 1) => (el.style.transform = `translate(${x}px, ${y}px) scale(${s})`)
    const n = notch()
    // 목: 노치 아래 가운데 ↔ 유령 위 가운데, 멀어질수록 가늘어지다 160px 에서 끊김
    const drawNeck = (x: number, y: number) => {
      const path = neck.current
      if (!path || !n) return
      const [ax, ay, bx, by] = [n.left + n.width / 2, n.bottom - 2, x + r0.width / 2, y + 6]
      const d = Math.hypot(bx - ax, by - ay)
      const w = Math.max(0, 26 - d * 0.14)
      if (w <= 0.5 || d > 170) {
        if (path.dataset.snapped !== '1') (path.dataset.snapped = '1'), path.animate([{ opacity: 1, transform: 'scaleY(1)' }, { opacity: 0, transform: 'scaleY(0.2)' }], { duration: 220, easing: SPRING, fill: 'forwards' })
        return
      }
      const mx = (ax + bx) / 2, my = (ay + by) / 2
      path.setAttribute('d', `M${ax - w * 1.6},${ay} Q${mx - w * 0.4},${my} ${bx - w},${by} L${bx + w},${by} Q${mx + w * 0.4},${my} ${ax + w * 1.6},${ay} Z`)
    }
    if (ghost.mode === 'detach') {
      el.dataset.lift = '1'
      let [gx, gy] = [r0.left, r0.top]
      place(gx, gy, 1)
      if (ghost.pointer) {
        // 끌기: 커서를 살짝 늦게 (k = 0.35/프레임 → 스프링 같은 따라옴)
        const { dx, dy } = ghost.pointer
        let [tx, ty] = [ghost.pointer.x - dx, ghost.pointer.y - dy]
        const mv = (e: PointerEvent) => ((tx = e.clientX - dx), (ty = e.clientY - dy))
        const loop = () => {
          if (!alive) return
          gx = lerp(gx, tx, 0.35)
          gy = lerp(gy, ty, 0.35)
          place(gx, gy, 1.03)
          drawNeck(gx, gy)
          raf = requestAnimationFrame(loop)
        }
        // 머리줄은 허브와 함께 사라진다 → 창(window) 전체에서 받는다 (아일랜드 창이 화면 높이 · 전체가 히트 영역인 동안)
        const up = () => {
          removeEventListener('pointermove', mv)
          removeEventListener('pointerup', up)
          removeEventListener('pointercancel', up)
          cancelAnimationFrame(raf)
          settle(tx, ty)
        }
        addEventListener('pointermove', mv)
        addEventListener('pointerup', up)
        addEventListener('pointercancel', up)
        raf = requestAnimationFrame(loop)
      } else if (ghost.auto) {
        // 버튼·두 번 누르기: 같은 움직임을 자동 경로로 (들림 → 기억한 자리로 날아감)
        const t = ghost.auto
        const a = el.animate(
          rm
            ? [{ opacity: 1 }, { opacity: 1 }]
            : [
                { transform: `translate(${r0.left}px, ${r0.top}px) scale(1)` },
                { transform: `translate(${r0.left}px, ${r0.top + 10}px) scale(1.03)`, offset: 0.18 },
                { transform: `translate(${t.left}px, ${t.top}px) scale(1.03)` },
              ],
          { duration: rm ? 1 : 520, easing: 'cubic-bezier(.45, 0, .2, 1)', fill: 'forwards' },
        )
        const step = () => {
          if (!alive || a.playState === 'finished') return
          const m = new DOMMatrixReadOnly(getComputedStyle(el).transform)
          drawNeck(m.m41, m.m42)
          raf = requestAnimationFrame(step)
        }
        raf = requestAnimationFrame(step)
        a.onfinish = () => (a.commitStyles(), a.cancel(), settle(t.left, t.top, t))
      }
      function settle(x: number, y: number, size?: DOMRect) {
        if (!alive) return
        const w = size?.width ?? r0.width, h = size?.height ?? r0.height
        el!.style.width = `${w}px`
        el!.style.height = `${h}px`
        // 살짝 넘치며 내려앉기 (1.03 → 0.99 → 1)
        const a = el!.animate(rm ? [{ opacity: 1 }, { opacity: 1 }] : [{ transform: `translate(${x}px, ${y}px) scale(1.03)` }, { transform: `translate(${x}px, ${y}px) scale(0.99)`, offset: 0.6 }, { transform: `translate(${x}px, ${y}px) scale(1)` }], { duration: rm ? 1 : 360, easing: SPRING, fill: 'forwards' })
        el!.dataset.lift = '0'
        // 진짜 창은 내려앉기와 동시에 만들기 시작 (생성 시간을 정착 애니메이션 뒤에 숨긴다) — 둘 다 끝나면 유령을 지운다
        const shown = onDetachDrop(ghost!.kind, new DOMRect(x, y, w, h))
        a.onfinish = () => (stopRec(), void shown.then(() => requestAnimationFrame(() => alive && onDone())))
      }
    } else {
      // 흡수: 창 자리 → 노치로 지니
      place(r0.left, r0.top, 1)
      const tgt = n ?? new DOMRect(innerWidth / 2 - 60, 0, 120, 6)
      const [cx, cy] = [tgt.left + tgt.width / 2 - r0.width / 2, tgt.top - r0.height / 2 + 3]
      const content = el.querySelector<HTMLElement>('.ghost-body')
      const a = el.animate(
        rm
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { transform: `translate(${r0.left}px, ${r0.top}px) scale(1, 1)`, borderRadius: '10px' },
              { transform: `translate(${lerp(r0.left, cx, 0.35)}px, ${lerp(r0.top, cy, 0.62)}px) scale(0.62, 0.48)`, borderRadius: '24px', offset: 0.45 },
              { transform: `translate(${cx}px, ${cy}px) scale(${tgt.width / r0.width}, ${8 / r0.height})`, borderRadius: '999px' },
            ],
        { duration: rm ? 160 : 560, easing: 'cubic-bezier(.55, 0, .75, .3)', fill: 'forwards' },
      )
      content?.animate([{ opacity: 1 }, { opacity: 1, offset: 0.55 }, { opacity: 0 }], { duration: rm ? 160 : 560, fill: 'forwards' })
      a.onfinish = () => {
        // 노치 '꿀꺽'
        const shape = document.querySelector<HTMLElement>('.island-shape')
        if (shape && !rm) shape.animate([{ transform: 'translateX(-50%) scale(1)' }, { transform: 'translateX(-50%) scale(1.18, 1.9)', offset: 0.35 }, { transform: 'translateX(-50%) scale(0.94, 0.9)', offset: 0.7 }, { transform: 'translateX(-50%) scale(1)' }], { duration: 460, easing: 'ease-out' }).onfinish = stopRec
        else stopRec()
        onDone()
      }
    }
    return () => ((alive = false), cancelAnimationFrame(raf))
  }, [ghost])
  if (!ghost) return null
  const r = ghost.rect
  return (
    <div className="ghost-layer" aria-hidden>
      <svg className="ghost-neck"><path ref={neck} /></svg>
      <div ref={box} className="ghost" data-mode={ghost.mode} style={{ width: r.width, height: r.height }}>
        <div className="ghost-body">{render(ghost.kind)}</div>
      </div>
    </div>
  )
}

/** 흡수 자석: 떠 있는 창이 다가오면 노치가 그쪽으로 부풀고 빛난다 (d = 노치까지 논리 px) */
export function useMagnet(d: number | null) {
  useEffect(() => {
    const isl = document.querySelector<HTMLElement>('.island')
    if (!isl) return
    const k = d == null ? 0 : Math.max(0, Math.min(1, (200 - d) / 120))
    isl.style.setProperty('--pull', String(k))
    isl.dataset.magnet = d != null && d < 80 ? 'hot' : k > 0 ? 'near' : ''
  }, [d])
}
