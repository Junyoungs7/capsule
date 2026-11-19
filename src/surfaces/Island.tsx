import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent, type ReactNode } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { invoke } from '@tauri-apps/api/core'
import { isTauri, onEvent, reportHitRects } from '../data/api'
import { Pet, petScale, PETS, SIZES_CAP, type CapSize, type CustomPet, type PetState } from './Pet'

/* 아일랜드 (a3): 떠 있는 펫 캡슐 (a13: 끌어서 아무 데나 — 창 배치·자리 저장은 Rust island.rs). 한 표면(skin)이 캡슐 → 알림 알약 → 허브 → 화면으로 바뀐다.
   - 알림: 펫 자세 + 옆에 짧은 글 (6초, 머무는 동안은 그대로). 계속되는 자세: 읽지 않은 채팅 · 터미널 실행 중 · 선반에 파일.
   - 머묾: 150ms 뒤 살짝 커짐, 나가면 300ms 기다렸다 돌아옴, 머무는 동안 히트 영역이 넓다 (6 → 16px).
   - 2분 동안 아무 일이 없으면 잠든다 · 잠든 뒤·가려졌을 때 애니메이션 멈춤 (평소 CPU ≈ 0).
   - 펼치는 쪽: Rust 가 알려 주는 Anchor (캡슐이 있는 절반의 반대 = 화면 안쪽). 큰 화면이 창에 안 들어가면 안쪽으로 밀어 넣는다 (잘리지 않게).
   히트 rect(클릭 통과)는 목표 크기로 계산 = 전환 중간값이 아님. 창 크기가 바뀌면 다시 보낸다. */

export type NextItem = { title: string; at?: string; kind: 'todo' | 'event' }
export type Alert = {
  key: string
  pet: PetState
  b: string
  s: string
  cls?: 'ok' | 'bad' | 'warn'
  fail?: boolean
  acts?: { label: string; primary?: boolean; run: () => void }[]
  onOpen?: () => void
  sticky?: boolean // 누를 때까지 (알람 · 페어링)
}
/** 캡슐 가운데 ↔ 창이 붙는 가장자리 (논리 px). right/bottom = 그쪽 가장자리 기준 (Rust island::Anchor) */
export type Anchor = { right: boolean; bottom: boolean; x: number; y: number }
const HOME: Anchor = { right: true, bottom: true, x: 56, y: 38 }
const EDGE = 8 // 창 가장자리 여백 (펼친 화면이 넘치지 않게)
const DRAG_PX = 6 // 이만큼 움직여야 끌기 (그보다 적으면 그냥 누르기)

export function fmtWhen(iso?: string) {
  if (!iso) return '기한 없음'
  const d = new Date(iso)
  const day = new Date(d).setHours(0, 0, 0, 0)
  const today = new Date().setHours(0, 0, 0, 0)
  const diff = Math.round((day - today) / 86_400_000)
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  const label = diff === 0 ? '오늘' : diff === 1 ? '내일' : diff === -1 ? '어제' : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' })
  return `${label} ${hm}`
}
export function until(iso?: string) {
  if (!iso) return ''
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60_000)
  if (min < 0) return '지남'
  if (min < 60) return `${min}분 후`
  if (min < 1440) return `${Math.floor(min / 60)}시간 후`
  return `${Math.floor(min / 1440)}일 후`
}

const SLEEP_MS = (window as Window & { __heraSleepMs?: number }).__heraSleepMs ?? 120_000 // 시험만 줄인다

type Props = {
  size: CapSize
  pet: string
  custom: CustomPet | null
  ambient: { unread: number; running: boolean } // 계속되는 자세 (선반은 놓을 때 잠깐만 — 알림으로)
  alert: Alert | null
  open: string | null // 'hub' | 화면 키
  render: (k: string) => ReactNode
  viewSize: (k: string) => [number, number | null] // [폭, 높이] — 높이 null = 내용을 잰다 (허브 · 대부분의 화면)
  onTap: () => void
  magnet?: 'near' | 'hot' | null
  gulp?: number
  onDropFiles: (paths: string[]) => void
  dropTo?: { label: string; onFiles: (paths: string[]) => void } | null // 드롭존 오른쪽 절반 (채팅에 보내기 · Mac 으로 보내기)
  forceDrop?: boolean // watch 루프 'drag-near'
}

export function Island({ size, pet, custom, ambient, alert: given, open, render, viewSize, onTap, magnet, gulp = 0, onDropFiles, dropTo, forceDrop }: Props) {
  const K = SIZES_CAP[size][1]
  const CAP: [number, number, number] = [64 * K, 48 * K, 24 * K]
  const pk = petScale(custom ? 'custom' : PETS[pet]?.style ?? 'flat', size)

  /* 파일 드롭: 실제 앱 = 네이티브 드롭(경로), 시안 = HTML5 (파일 이름만) */
  const [drag, setDrag] = useState(false)
  const [toRight, setToRight] = useState(false)
  const drop = useRef({ onDropFiles, dropTo })
  drop.current = { onDropFiles, dropTo }
  const skin = useRef<HTMLDivElement>(null)
  const right = (clientX: number) => {
    const r = skin.current?.getBoundingClientRect()
    return !!r && clientX >= r.left + r.width / 2
  }
  useEffect(() => {
    if (!isTauri) return
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload
      if (p.type === 'enter' || p.type === 'over') return setDrag(true), setToRight(right(p.position.x / devicePixelRatio))
      setDrag(false)
      if (p.type !== 'drop' || !p.paths.length) return
      const d = drop.current
      if (d.dropTo && right(p.position.x / devicePixelRatio)) d.dropTo.onFiles(p.paths)
      else d.onDropFiles(p.paths)
    })
    return () => void off.then((f) => f())
  }, [])
  const files = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  const dnd = {
    onDragEnter: (e: DragEvent) => files(e) && (e.preventDefault(), setDrag(true)),
    onDragOver: (e: DragEvent) => files(e) && (e.preventDefault(), (e.dataTransfer.dropEffect = 'copy'), setToRight(right(e.clientX))),
    onDragLeave: (e: DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrag(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      setDrag(false)
      const names = [...e.dataTransfer.files].map((f) => f.name)
      if (names.length) (dropTo && right(e.clientX) ? dropTo.onFiles : onDropFiles)(names)
    },
  }
  const dropping = drag || !!forceDrop
  const alert: Alert | null = dropping
    ? { key: 'drop', pet: 'shelf', b: dropTo && toRight ? dropTo.label : '선반에 놓기', s: dropTo ? (toRight ? '← 선반에 담으려면 왼쪽' : `오른쪽 = ${dropTo.label}`) : '놓으면 선반에 담아 둘게요 · 최대 4개' }
    : given

  /* 자리: Rust 가 놓은 창 기준 Anchor (시작 때 읽고, 옮길 때마다 'island-anchor') */
  const [anc, setAnc] = useState<Anchor>(HOME)
  useEffect(() => {
    if (!isTauri) return
    void invoke<Anchor | null>('island_anchor').then((a) => a && setAnc(a), () => {})
    return onEvent<Anchor>('island-anchor', setAnc)
  }, [])

  /* 끌어서 옮기기: 6px 넘게 움직이면 끌기 → 창은 Rust 가 커서를 따라 옮긴다 (React 다시 그리기 없음). 놓으면 자리 저장.
     그보다 적게 움직이고 떼면 지금처럼 누르기 (허브 열기). */
  const grab = useRef<{ x: number; y: number; id: number; on: boolean } | null>(null)
  const dragged = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  const mover = {
    onPointerDown: (e: PointerEvent) => {
      if (open || e.button !== 0) return
      grab.current = { x: e.clientX, y: e.clientY, id: e.pointerId, on: false }
    },
    onPointerMove: (e: PointerEvent) => {
      const g = grab.current
      if (!g || g.id !== e.pointerId) return
      if (!g.on) {
        if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_PX) return
        g.on = true
        e.currentTarget.setPointerCapture(e.pointerId)
        root.current?.setAttribute('data-drag', 'true')
        if (isTauri) void invoke('island_drag', { phase: 'start' })
      }
      if (isTauri) void invoke('island_drag', { phase: 'move' })
    },
    onPointerUp: (e: PointerEvent) => {
      const g = grab.current
      grab.current = null
      if (!g?.on) return
      dragged.current = true // 이어지는 click 은 누르기가 아니다
      setTimeout(() => (dragged.current = false), 0)
      root.current?.removeAttribute('data-drag')
      if (isTauri) return void invoke('island_drag', { phase: 'end' })
      // 시안: 놓은 자리 = 캡슐 가운데
      const right = e.clientX >= innerWidth / 2, bottom = e.clientY >= innerHeight / 2
      setAnc({ right, bottom, x: right ? innerWidth - e.clientX : e.clientX, y: bottom ? innerHeight - e.clientY : e.clientY })
    },
  }

  /* 머묾 (hover intent) */
  const [hover, setHover] = useState(false)
  const enterT = useRef(0)
  const leaveT = useRef(0)
  const onEnter = () => {
    clearTimeout(leaveT.current)
    if (!hover) enterT.current = window.setTimeout(() => setHover(true), 150)
  }
  const onLeave = () => {
    clearTimeout(enterT.current)
    leaveT.current = window.setTimeout(() => setHover(false), 300)
  }

  /* 알림 알약: 6초 뒤 접힘 (머무는 동안 · sticky 는 그대로) */
  const [shownAlert, setShownAlert] = useState<Alert | null>(alert)
  useEffect(() => setShownAlert(alert), [alert?.key, alert?.b, alert?.s, alert?.pet])
  useEffect(() => {
    if (!shownAlert || shownAlert.sticky || dropping || hover) return
    const t = setTimeout(() => setShownAlert(null), 6000)
    return () => clearTimeout(t)
  }, [shownAlert?.key, shownAlert?.b, hover, dropping])
  const pill = open ? null : shownAlert

  /* 잠: 2분 동안 아무 일 없으면. 잠든 지 8초 · 계속되는 자세로 2분 · 창이 가려지면 멈춘 자세 */
  const persistent = ambient.unread > 0 || ambient.running
  const [quiet, setQuiet] = useState(false)
  const [still, setStill] = useState(false)
  const [hidden, setHidden] = useState(document.hidden)
  useEffect(() => {
    const f = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', f)
    return () => document.removeEventListener('visibilitychange', f)
  }, [])
  const wakeKey = `${open}|${pill?.key}|${pill?.b}|${hover}|${ambient.unread}|${ambient.running}|${pet}|${size}`
  useEffect(() => {
    setQuiet(false)
    setStill(false)
    if (open || pill || hover) return
    const t = setTimeout(() => setQuiet(true), SLEEP_MS)
    return () => clearTimeout(t)
  }, [wakeKey])
  const asleep = quiet && !persistent
  useEffect(() => {
    if (!quiet) return
    const t = setTimeout(() => setStill(true), persistent ? 0 : 8000)
    return () => clearTimeout(t)
  }, [quiet, persistent])
  const pose: PetState = pill ? pill.pet : ambient.unread ? 'chat' : ambient.running ? 'typing' : asleep ? 'sleep' : 'idle'

  /* 열린 내용: 바뀌면 90ms 흐려졌다가 바꿔 끼운다 (닫힐 때는 그대로 두고 흐려진다) */
  const [shown, setShown] = useState<string | null>(open)
  const [out, setOut] = useState(false)
  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => setShown(null), 420)
      return () => clearTimeout(t)
    }
    if (open === shown) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !shown) return setShown(open)
    setOut(true)
    const t = setTimeout(() => (setShown(open), setOut(false)), 90)
    return () => clearTimeout(t)
  }, [open])

  /* 크기 */
  const content = useRef<HTMLDivElement>(null)
  // (a4) 허브·화면 높이 = 잰 내용 (화면마다 최대 높이는 ViewShell 이 max-height 로). 내용이 바뀌면(할 일 추가·기간 달력) 따라간다
  const [measured, setMeasured] = useState<Record<string, number>>({})
  useLayoutEffect(() => {
    const el = content.current?.firstElementChild as HTMLElement | null
    if (!shown || !el) return
    const f = () => setMeasured((m) => (m[shown] === el.offsetHeight ? m : { ...m, [shown]: el.offsetHeight }))
    f()
    const ro = new ResizeObserver(f)
    ro.observe(el)
    return () => ro.disconnect()
  }, [shown])
  const lastH = useRef(520)
  const measure = useRef<HTMLDivElement>(null)
  const [tw, setTw] = useState(0)
  useLayoutEffect(() => {
    if (!pill || !measure.current) return
    setTw(Math.min(Math.ceil(measure.current.getBoundingClientRect().width) + 2, Math.round(300 * K)))
  }, [pill?.b, pill?.s, pill?.acts?.length, K])
  const vs = open ? viewSize(open) : null
  // 처음 여는 화면은 재기 전까지 지금 높이 그대로 (최대 높이로 갔다가 줄어드는 출렁임 없음)
  const openH = vs ? vs[1] ?? measured[open!] ?? lastH.current : 0
  if (open) lastH.current = openH
  const [w, h, r] = open ? [vs![0], openH, open === 'hub' ? 24 : 20] : pill ? [CAP[0] + tw, CAP[1], CAP[2]] : CAP
  const mode = open ? (open === 'hub' ? 'hub' : 'view') : pill ? 'alert' : 'idle'

  /* 히트 rect = 모서리 기준 목표 크기 (+ 머묾 여유) — 창 크기가 바뀌면 다시 */
  const [vw, setVw] = useState(0)
  useEffect(() => {
    const f = () => setVw((n) => n + 1)
    addEventListener('resize', f)
    return () => removeEventListener('resize', f)
  }, [])
  // 붙는 가장자리에서 표면까지 (CSS px): 접힌 캡슐 가운데 기준, 펼친 화면이 창 밖으로 나가면 안쪽으로
  const fit = (a: number, cap: number, size: number, room: number) => Math.max(EDGE, Math.min(a - cap / 2, room - size - EDGE))
  const ex = fit(anc.x, CAP[0], w, innerWidth)
  const ey = fit(anc.y, CAP[1], h, innerHeight)
  useEffect(() => {
    const m = open ? 0 : hover ? 16 : 6
    const x = anc.right ? innerWidth - ex - w : ex
    const y = anc.bottom ? innerHeight - ey - h : ey
    // (a7) 창 밖(= 작업 표시줄 쪽)으로 넘치지 않게 자른다 — 머묾 여유 16 > 가장자리 여백 8 (Rust 도 작업 영역 밖은 받지 않음)
    const l = Math.max(0, x - m), t = Math.max(0, y - m)
    reportHitRects('island', [new DOMRect(l, t, Math.min(x + w + m, innerWidth) - l, Math.min(y + h + m, innerHeight) - t)])
  }, [w, h, hover, open, ex, ey, anc.right, anc.bottom, vw])

  /* 흡수 '꿀꺽' */
  useEffect(() => {
    const el = skin.current
    if (!gulp || !el) return
    el.classList.remove('gulp')
    void el.offsetWidth
    el.classList.add('gulp')
    const t = setTimeout(() => el.classList.remove('gulp'), 460)
    return () => clearTimeout(t)
  }, [gulp])

  const text = (a: Alert) => (
    <>
      <b>{a.b}</b>
      <small className={a.cls}>{a.s}</small>
      {a.acts && (
        <span className="acts">
          {a.acts.map((x) => (
            <button key={x.label} className={`chp ${x.primary ? 'go' : ''}`} onClick={(e) => (e.stopPropagation(), x.run())}>{x.label}</button>
          ))}
        </span>
      )}
    </>
  )
  const closing = !open && (shown === 'hub' || !!shown)
  const skinStyle: CSSProperties = { width: w, height: h, borderRadius: r, ...(closing ? { transitionTimingFunction: 'var(--settle), var(--settle), var(--settle), var(--ease-calm), var(--ease-calm)', transitionDuration: '340ms, 340ms, 340ms, 320ms, 320ms' } : {}) }
  return (
    <div ref={root} className="isl hx" data-h={anc.right ? 'r' : 'l'} data-v={anc.bottom ? 'b' : 't'} data-mode={mode} data-open={!!open} data-hover={hover} data-magnet={magnet ?? undefined} data-still={still || hidden}
      style={{ '--k': K, '--pk': pk, '--ox': anc.right ? '100%' : '0', '--oy': anc.bottom ? '100%' : '0', [anc.right ? 'right' : 'left']: ex, [anc.bottom ? 'bottom' : 'top']: ey } as CSSProperties} onPointerEnter={onEnter} onPointerLeave={onLeave} {...dnd}>
      <i className="hit" />
      <div ref={skin} className={`skin ${pill?.fail ? 'fail' : ''}`} style={skinStyle}
        {...mover} onPointerCancel={mover.onPointerUp}
        onClick={(e) => {
          if (open || dragged.current) return
          e.stopPropagation()
          setQuiet(false)
          if (pill?.onOpen) return void (setShownAlert(null), pill.onOpen())
          onTap()
        }}>
        <div className="cap">
          <div className="ptext" style={{ width: pill ? tw : 0 }} role="status" aria-live="polite">{pill && text(pill)}</div>
          {pill && <div ref={measure} className="ptext measure" aria-hidden>{text(pill)}</div>}
          <div className="petbox" aria-label="Hera 허브 열기" role="button">
            <Pet kind={pet} custom={custom} state={pose} pk={pk} bubble={ambient.unread || 1} />
          </div>
        </div>
        <div ref={content} className={`content ${out ? 'out' : ''}`}>{shown && render(shown)}</div>
      </div>
    </div>
  )
}
