import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { LpRecord, Notification, RunningSession } from '../data/types'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { isTauri, reportHitRects } from '../data/api'
import { Tile } from './Dock'
import { labelVars } from './Turntable'

export type NextItem = { title: string; at?: string; kind: 'todo' | 'event' }
type Mode = 'idle' | 'preview' | 'alert' | 'nowPlaying' | 'drop'

// 컨테이너(=창)는 최대 크기 고정, 상태별 모양은 고정 프리셋 → clip-path 스프링
const SIZES: Record<Mode, [number, number, number]> = {
  idle: [128, 36, 18],
  preview: [344, 58, 29],
  nowPlaying: [372, 68, 30],
  alert: [404, 122, 30],
  drop: [372, 92, 30],
}
const CYCLE = 25 // 진행바 기준(분) — Open Question 1 기본안

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

function until(iso?: string) {
  if (!iso) return ''
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60_000)
  if (min < 0) return '지남'
  if (min < 60) return `${min}분 후`
  if (min < 1440) return `${Math.floor(min / 60)}시간 후`
  return `${Math.floor(min / 1440)}일 후`
}

type Props = {
  alert: Notification | null
  next: NextItem | null
  playing: RunningSession | null
  playingRec?: LpRecord
  peek: boolean
  onDone: () => void
  onSnooze: () => void
  onOpen: () => void
  onDropFiles: (paths: string[]) => void
}

export function Island({ alert, next, playing, playingRec, peek, onDone, onSnooze, onOpen, onDropFiles }: Props) {
  const [hover, setHover] = useState(false)
  // v2: 파일을 끌고 오면 '선반에 놓기' 드롭존. 시안 = HTML5 드래그(파일 이름만).
  // 실제 앱: island 창 네이티브 드롭(경로). 클릭 통과는 watch 루프가 창 밖에서 누른 채 들어오는 드래그일 때 모양 +24px 를 받아 준다
  // (idle 알약 위로 오면 통과 해제 → 'enter' → drop 모양으로 커지고 그 rect 를 보고).
  const [drag, setDrag] = useState(false)
  const drop = useRef(onDropFiles)
  drop.current = onDropFiles
  useEffect(() => {
    if (!isTauri) return
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload
      if (p.type === 'enter' || p.type === 'over') return setDrag(true)
      setDrag(false)
      if (p.type === 'drop' && p.paths.length) drop.current(p.paths)
    })
    return () => void off.then((f) => f())
  }, [])
  const mode: Mode = drag ? 'drop' : alert ? 'alert' : hover || peek ? 'preview' : playing ? 'nowPlaying' : 'idle'
  const files = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  const dnd = {
    onDragEnter: (e: DragEvent) => files(e) && (e.preventDefault(), setDrag(true)),
    onDragOver: (e: DragEvent) => files(e) && (e.preventDefault(), (e.dataTransfer.dropEffect = 'copy')),
    onDragLeave: (e: DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrag(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      setDrag(false)
      const names = [...e.dataTransfer.files].map((f) => f.name)
      if (names.length) onDropFiles(names)
    },
  }
  const [w, h, r] = SIZES[mode]

  // 미니 LP: 곡(포그라운드 앱)이 바뀌면 10초간 회전 후 정지 (Open Question 5 기본안)
  const [spinning, setSpinning] = useState(false)
  useEffect(() => {
    if (!playing) return
    setSpinning(true)
    const t = setTimeout(() => setSpinning(false), 10_000)
    return () => clearTimeout(t)
  }, [playing?.startedAt, playing?.title])

  // 경과 시간은 분 단위 — nowPlaying 표시 중에만 1분 타이머
  const [, tick] = useState(0)
  useEffect(() => {
    if (mode !== 'nowPlaying') return
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [mode])
  const mins = playing ? Math.floor((Date.now() - playing.startedAt) / 60_000) : 0

  // 히트 rect = 목표 프리셋 크기 (전환 중간값이 아니라), 컨테이너 상단 중앙 기준
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const b = root.current!.getBoundingClientRect()
    reportHitRects('island', [new DOMRect(b.left + (b.width - w) / 2, b.top, w, h)])
  }, [w, h])

  const today = new Date().toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' })

  return (
    <div
      ref={root}
      className="island"
      data-mode={mode}
      data-spin={spinning && mode === 'nowPlaying'}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={() => mode === 'preview' && onOpen()}
      {...dnd}
    >
      {/* 블러 없는 짙은 판 1장 — clip-path(path)+backdrop-filter 재래스터가 버벅임 원인이었음 */}
      <div className="island-shape" style={{ width: w, height: h, borderRadius: r }} />

      <div className="island-layer idle" style={{ width: SIZES.idle[0], height: SIZES.idle[1] }} aria-hidden={mode !== 'idle'}>
        <span className="pulse" data-on={!!playing} />
        <span>{today}</span>
      </div>

      <div className="island-layer preview" style={{ width: SIZES.preview[0], height: SIZES.preview[1] }} aria-hidden={mode !== 'preview'}>
        <span className="ico" data-kind={next?.kind ?? 'todo'}>
          {next?.kind === 'event' ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="4" y="5" width="16" height="15" rx="3" /><path d="M4 10h16M9 3v4M15 3v4" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="8" /><path d="M8.5 12.2l2.3 2.3 4.7-4.8" /></svg>
          )}
        </span>
        <span className="txt">
          <b>{next?.title ?? '예정된 일이 없어요'}</b>
          <small>{next ? `${next.kind === 'event' ? '일정' : '할 일'} · ${fmtWhen(next.at)}` : '패널에서 할 일을 추가하세요'}</small>
        </span>
        <span className="chip">{until(next?.at) || '열기'}</span>
      </div>

      <div className="island-layer nowPlaying" style={{ width: SIZES.nowPlaying[0], height: SIZES.nowPlaying[1] }} aria-hidden={mode !== 'nowPlaying'}>
        <span className="mini-lp" style={labelVars(playingRec?.cover)}>{playingRec && <Tile rec={playingRec} size={26} />}</span>
        <span className="txt">
          <small>지금 작업 중</small>
          <b>{playing?.title}</b>
          <span className="bar"><i style={{ transform: `scaleX(${Math.min(1, mins / CYCLE)})` }} /></span>
        </span>
        <span className="time">{mins}<small>/{CYCLE}분</small></span>
      </div>

      <div className="island-layer drop" style={{ width: SIZES.drop[0], height: SIZES.drop[1] }} aria-hidden={mode !== 'drop'}>
        <span className="tray">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v10M8 10l4 4 4-4" /><path d="M4 14v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3" /></svg>
        </span>
        <span className="txt">
          <b>선반에 놓기</b>
          <small>놓으면 독 선반에 담아 둘게요 · 최대 4개</small>
        </span>
      </div>

      <div className="island-layer alert" style={{ width: SIZES.alert[0], height: SIZES.alert[1] }} aria-hidden={mode !== 'alert'} role="alert">
        <div className="head">
          <span className="bell" />
          <small>알림 · 지금</small>
        </div>
        <b>{alert?.title}</b>
        <small className="body">{alert?.body}</small>
        <div className="actions">
          <button onClick={onSnooze} tabIndex={mode === 'alert' ? 0 : -1}>10분 뒤 다시</button>
          <button className="primary" onClick={onDone} tabIndex={mode === 'alert' ? 0 : -1}>완료</button>
        </div>
      </div>
    </div>
  )
}
