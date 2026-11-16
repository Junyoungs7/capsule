import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { isTauri, reportHitRects } from '../data/api'
import { Pet, petScale, PETS, SIZES_CAP, type CapSize, type CustomPet, type PetState } from './Pet'

/* 아일랜드 (a3): 작업 표시줄 바로 위 오른쪽(왼쪽) 아래 모서리의 펫 캡슐. 한 표면(skin)이 캡슐 → 알림 알약 → 허브 → 화면으로 바뀐다.
   - 알림: 펫 자세 + 옆에 짧은 글 (6초, 머무는 동안은 그대로). 계속되는 자세: 읽지 않은 채팅 · 터미널 실행 중 · 선반에 파일.
   - 머묾: 150ms 뒤 살짝 커짐, 나가면 300ms 기다렸다 돌아옴, 머무는 동안 히트 영역이 넓다 (6 → 16px).
   - 2분 동안 아무 일이 없으면 잠든다 · 잠든 뒤·가려졌을 때 애니메이션 멈춤 (평소 CPU ≈ 0).
   히트 rect(클릭 통과)는 모서리 기준으로 계산 = 전환 중간값이 아니라 목표 크기. 창 크기가 바뀌면 다시 보낸다. */

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
export type Place = 'br' | 'bl'

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
const MARGIN = { right: 16, bottom: 8 }

type Props = {
  place: Place
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

export function Island({ place, size, pet, custom, ambient, alert: given, open, render, viewSize, onTap, magnet, gulp = 0, onDropFiles, dropTo, forceDrop }: Props) {
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
  useEffect(() => {
    const m = open ? 0 : hover ? 16 : 6
    const x = place === 'br' ? innerWidth - MARGIN.right - w : MARGIN.right
    reportHitRects('island', [new DOMRect(x - m, innerHeight - MARGIN.bottom - h - m, w + 2 * m, h + 2 * m)])
  }, [w, h, hover, open, place, vw])

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
    <div className="isl hx" data-place={place} data-mode={mode} data-open={!!open} data-hover={hover} data-magnet={magnet ?? undefined} data-still={still || hidden}
      style={{ '--k': K, '--pk': pk } as CSSProperties} onPointerEnter={onEnter} onPointerLeave={onLeave} {...dnd}>
      <i className="hit" />
      <div ref={skin} className={`skin ${pill?.fail ? 'fail' : ''}`} style={skinStyle}
        onClick={(e) => {
          if (open) return
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
