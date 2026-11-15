import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { LpRecord } from '../data/types'
import { reducedMotion, Tile, usePresence } from './Dock'

/* LP = 글라스 레코드. 떠 있던 픽셀 턴테이블을 독(LP 크레이트) + Island(지금 회전 중)로 합쳤다.
   - 크레이트: 독 위젯. 클릭 = 라이브러리 팝오버, 끌어서 Island 에 놓기 = 실행 + Island 에서 회전.
   - 회전: 턴테이블의 계단식 가속/감속 + 정속 30°/150ms 규칙 그대로 (useSpin). */

/* 라벨 대비: 아이콘이 항상 읽히게 커버 휘도로 라벨/잉크를 고른다 (LP 라벨 공용).
   어두운 커버 → 밝은 라벨 + 커버색 아이콘, 밝은 커버 → 짙은 아이콘, 그 사이 → 흰 아이콘 */
export function labelVars(cover = '#64748B'): CSSProperties {
  const n = parseInt(cover.slice(1), 16)
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  const [lab, ink] = L < 0.08 ? [`color-mix(in oklab, ${cover} 26%, white)`, cover] : L > 0.3 ? [cover, `color-mix(in oklab, ${cover} 28%, black)`] : [cover, '#fff']
  return { '--c': cover, '--lab': lab, '--ink': ink } as CSSProperties
}

const PERIOD = 1800 // 33⅓rpm = 1.8s/회전
const STEPS = 60 // 회전당 60컷: 가속·감속 구간은 60Hz 에서 2프레임마다 6°
// 정속(앱이 살아 있는 동안 계속)은 5컷씩 묶어 30°/150ms (6.7Hz) — 갱신 1회마다 웹뷰·GPU 프레임 비용이 들어 idle CPU <1% 를 맞춘다(계획 C 측정)
const CRUISE = 5
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'ease-out'

/** on 이 true 면 가속(1.4s) 후 정속 컷 회전, false 면 감속(1.7s) 후 그 각도에서 정지. steps() WAAPI 1개 재사용.
    정속에서는 애니메이션을 멈추고 컷마다 currentTime 을 민다 — 재생 중 WAAPI 는 컷이 안 바뀌어도 매 vsync 프레임을 만든다. */
export function useSpin(el: RefObject<HTMLElement | null>, on: boolean) {
  const anim = useRef<Animation | null>(null)
  const rate = useRef(0)
  const ramp = useRef(0)
  const tick = useRef(0)
  useEffect(() => () => (cancelAnimationFrame(ramp.current), clearInterval(tick.current), anim.current?.cancel()), [])
  useEffect(() => {
    if (reducedMotion() || !el.current) return
    const to = on ? 1 : 0
    if (!to && rate.current <= 0.001) return
    const a = (anim.current ??= el.current.animate([{ transform: 'rotate(0turn)' }, { transform: 'rotate(1turn)' }], {
      duration: PERIOD,
      iterations: Infinity,
      easing: `steps(${STEPS})`,
    }))
    clearInterval(tick.current)
    if (to) a.playbackRate = rate.current = Math.max(rate.current, 0.001)
    a.play()
    const from = rate.current, t0 = performance.now(), dur = to ? 1400 : 1700
    cancelAnimationFrame(ramp.current)
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur)
      rate.current = from + (to - from) * (1 - (1 - k) * (1 - k))
      a.playbackRate = Math.max(rate.current, 0.001)
      if (k < 1) ramp.current = requestAnimationFrame(step)
      else if (!to) a.pause() // 정지 각도 유지, 이후 프레임 0
      else {
        a.pause()
        const q = (PERIOD / STEPS) * CRUISE
        tick.current = window.setInterval(() => (a.currentTime = ((Math.round(Number(a.currentTime) / q) + 1) * q) % PERIOD), q)
      }
    }
    ramp.current = requestAnimationFrame(step)
  }, [on])
}

/** 글라스 LP: 홈(회전) + 라벨(앱 아이콘, 회전) + 정적 반사(회전 안 함) */
export function Disc({ rec, size, spinRef }: { rec?: LpRecord; size: number; spinRef?: RefObject<HTMLSpanElement> }) {
  return (
    <span className="lp" style={{ width: size, height: size, ...labelVars(rec?.cover) }} aria-hidden>
      <span ref={spinRef} className="lp-spin">
        <span className="lp-label">{rec && <Tile rec={rec} size={Math.round(size * 0.34)} />}</span>
      </span>
      <i className="lp-sheen" />
    </span>
  )
}

type Lp = 'off' | 'drag' | 'over'

type CrateProps = {
  records: LpRecord[] // 라이브러리 (고정·세트·URL)
  running: LpRecord[] // 실행 중(고정 안 된) 앱 — 팝오버 '실행 중' 칸
  open: boolean
  onToggle: (open: boolean) => void
  onClosed: (inside: boolean) => void
  onCue: (r: LpRecord) => void // Island 에 올리기 = 실행 + 회전
  onRemove: (r: LpRecord) => void
  onLibrary: () => void
  onDrag: (s: Lp) => void
}

const DRAG_START = 6 // px: 이만큼 움직여야 끌기 (그 전엔 클릭)
const GHOST = 64

/** 독 위젯: 글라스 레코드 3장이 살짝 부채꼴로 꽂힌 크레이트 */
export function LpCrate({ records, running, open, onToggle, onClosed, onCue, onRemove, onLibrary, onDrag }: CrateProps) {
  const p = usePresence<HTMLDivElement>(open)
  const slot = useRef<HTMLDivElement>(null)
  // 팝오버 닫기: 슬롯 바깥 pointerdown · Esc · LP 를 Island 에 놓았을 때
  const closed = useRef(onClosed)
  closed.current = onClosed
  const drag = useLpDrag((r) => (onCue(r), closed.current(false)), onDrag)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => !slot.current!.contains(e.target as Node) && closed.current(!!(e.target as Element).closest?.('.dock-row'))
    const key = (e: KeyboardEvent) => e.key === 'Escape' && closed.current(true)
    addEventListener('pointerdown', down)
    addEventListener('keydown', key)
    return () => (removeEventListener('pointerdown', down), removeEventListener('keydown', key))
  }, [open])

  const top = records.slice(0, 3)
  const item = (r: LpRecord, removable: boolean) => (
    <div key={r.id} className="lp-item" role="listitem">
      <button
        className="lp-pick"
        onPointerDown={(e) => drag.down(r, e)}
        onClick={() => drag.clicked() && (onCue(r), closed.current(true))}
        aria-label={`${r.title} — Island 에 올려 실행 (끌어서 놓아도 돼요)`}
      >
        <Disc rec={r} size={48} />
        <small>{r.title}</small>
      </button>
      {removable && <button className="lp-x" onClick={() => onRemove(r)} aria-label={`${r.title} 라이브러리에서 빼기`}>×</button>}
    </div>
  )

  return (
    <div ref={slot} className="dock-slot widget crate" data-open={open}>
      <button
        className="crate-btn"
        onPointerDown={(e) => top[0] && drag.down(top[0], e)}
        onClick={() => drag.clicked() && onToggle(!open)}
        aria-expanded={open}
        aria-label={`LP 라이브러리 · ${records.length}장 (맨 앞 LP 를 Island 로 끌어 실행)`}
      >
        {top.map((r, i) => (
          <span key={r.id} className="crate-lp" style={{ '--i': i } as CSSProperties}>
            <Disc rec={r} size={40} />
          </span>
        )).reverse()}
      </button>
      <span className="dock-label">LP</span>
      {p.mounted && (
        <div ref={p.ref} className="folder-pop glass-card lp-pop" onTransitionEnd={p.onTransitionEnd} onPointerMove={(e) => e.stopPropagation()} role="dialog" aria-label="LP 라이브러리">
          <header>
            <b>LP 라이브러리</b>
            <small>Island 로 끌어 실행</small>
            <button className="lp-add" onClick={() => (onLibrary(), closed.current(true))}>추가</button>
          </header>
          <div className="lp-grid" role="list">{records.map((r) => item(r, true))}</div>
          {running.length > 0 && (
            <>
              <b className="lp-sect">실행 중</b>
              <div className="lp-grid" role="list">{running.map((r) => item(r, false))}</div>
            </>
          )}
        </div>
      )}
      {drag.ghost}
    </div>
  )
}

/* 끌기: 고스트 LP(포털, 고정 위치)를 rAF 로 transform 만 갱신. Island(.island) 위면 'over'.
   놓으면 Island 의 빈 플래터(.island .cue .lp)로 스프링으로 빨려 들어간 뒤 onCue.
   실제 앱(독·Island 는 다른 창): Island 요소가 없으니 위로 140px 넘게 끌면 'over' 로 본다 → onCue = 실행, Island 는 포그라운드로 회전. */
function useLpDrag(onCue: (r: LpRecord) => void, onDrag: (s: Lp) => void) {
  const [rec, setRec] = useState<LpRecord | null>(null)
  const el = useRef<HTMLDivElement>(null)
  const st = useRef({ x0: 0, y0: 0, x: 0, y: 0, moved: false, over: false, frame: 0 })
  const cue = useRef(onCue)
  cue.current = onCue
  const report = useRef(onDrag)
  report.current = onDrag

  const at = (x: number, y: number, s: number) => `translate(${x - GHOST / 2}px, ${y - GHOST / 2}px) scale(${s})`
  const target = () => {
    const isl = document.querySelector('.island')
    if (!isl) return null
    const b = isl.getBoundingClientRect()
    return new DOMRect(b.left, b.top - 20, b.width, 130)
  }
  const isOver = (x: number, y: number) => {
    const t = target()
    return t ? x >= t.left && x <= t.right && y >= t.top && y <= t.bottom : st.current.y0 - y > 140
  }

  useLayoutEffect(() => {
    if (rec && el.current) el.current.style.transform = at(st.current.x, st.current.y, 0.9)
  }, [rec])

  const down = (r: LpRecord, e: RPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    const s = st.current
    Object.assign(s, { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false, over: false })
    const move = (ev: PointerEvent) => {
      s.x = ev.clientX
      s.y = ev.clientY
      if (!s.moved) {
        if (Math.hypot(s.x - s.x0, s.y - s.y0) < DRAG_START) return
        s.moved = true
        setRec(r)
        report.current('drag')
      }
      const over = isOver(s.x, s.y)
      if (over !== s.over) report.current((s.over = over) ? 'over' : 'drag')
      if (!s.frame)
        s.frame = requestAnimationFrame(() => {
          s.frame = 0
          if (el.current) el.current.style.transform = at(s.x, s.y, s.over ? 1.05 : 0.9)
        })
    }
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      cancelAnimationFrame(s.frame)
      s.frame = 0
      if (!s.moved) return
      const g = el.current
      const drop = ev.type === 'pointerup' && s.over
      const plat = document.querySelector('.island .cue .lp')?.getBoundingClientRect()
      const to = drop
        ? plat ? at(plat.left + plat.width / 2, plat.top + plat.height / 2, plat.width / GHOST) : at(s.x, s.y - 40, 0.6)
        : at(s.x0, s.y0, 0.5)
      const fin = () => {
        setRec(null)
        report.current('off')
        if (drop) cue.current(r)
      }
      if (!g || reducedMotion()) return fin()
      const anim = g.animate([{ transform: getComputedStyle(g).transform }, { transform: to, opacity: drop ? 1 : 0 }], {
        duration: drop ? 520 : 300,
        easing: drop ? token('--spring-smooth') : 'ease-in',
        fill: 'forwards',
      })
      anim.onfinish = fin
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  return {
    down,
    // 끌기로 끝난 pointerup 뒤의 click 은 무시
    clicked: () => !st.current.moved,
    ghost: rec && createPortal(<div ref={el} className="lp-ghost"><Disc rec={rec} size={GHOST} /></div>, document.body),
  }
}
