import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { LpRecord, Notification, RunningSession } from '../data/types'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { isTauri, reportHitRects } from '../data/api'
import { Disc, useSpin } from './Lp'
import { Avatar, groupOf } from './Team'

export type NextItem = { title: string; at?: string; kind: 'todo' | 'event' }
type Mode = 'idle' | 'preview' | 'alert' | 'nowPlaying' | 'drop' | 'cue' | 'news' | 'ascii'
// Hera Team 변경 소식: 누가 · 어느 그룹 · 무엇을 (짧게 떴다 사라짐)
export type TeamNews = { who: string; group: string; what: string; detail: string; n: number }

// 컨테이너(=창)는 최대 크기 고정, 상태별 모양은 고정 프리셋 → clip-path 스프링
const SIZES: Record<Mode, [number, number, number]> = {
  idle: [128, 36, 18],
  preview: [344, 58, 29],
  nowPlaying: [372, 68, 30],
  alert: [404, 122, 30],
  drop: [372, 92, 30],
  news: [392, 58, 29],
  ascii: [252, 44, 22], // 아스키 재생 중: 작은 알약 + 정지
  cue: [372, 68, 30], // LP 를 끌고 오는 중 = nowPlaying 과 같은 모양 → 놓으면 내용만 바뀜
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
  alive?: boolean // 지금 레코드의 앱이 살아 있음 = LP 회전 (턴테이블 규칙)
  lp?: 'off' | 'drag' | 'over' // 독에서 LP 를 끌고 오는 중
  news?: TeamNews | null
  ascii?: string | null // 재생 중인 아스키 장면 이름
  onAscii?: () => void // ✦ 자동 장면 시작
  onAsciiStop?: () => void
}

export function Island({ alert, next, playing, playingRec, peek, onDone, onSnooze, onOpen, onDropFiles, alive = false, lp = 'off', news = null, ascii = null, onAscii, onAsciiStop }: Props) {
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
  const mode: Mode = drag ? 'drop' : alert ? 'alert' : lp !== 'off' ? 'cue' : ascii ? 'ascii' : news ? 'news' : hover || peek ? 'preview' : playing ? 'nowPlaying' : 'idle'
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

  // LP: 앱이 살아 있는 동안 회전 (계단식 가속 → 정속 30°/150ms). 디스크가 보일 때만 돌린다.
  const disc = useRef<HTMLSpanElement>(null)
  useSpin(disc, alive && mode === 'nowPlaying')

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
      data-lp={lp}
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
        {onAscii && (
          <button className="isl-ascii" onClick={(e) => (e.stopPropagation(), onAscii())} tabIndex={mode === 'preview' ? 0 : -1} aria-label="아스키 아트 전체화면 (계절 장면)" title="아스키 아트">✦</button>
        )}
      </div>

      <div className="island-layer ascii" style={{ width: SIZES.ascii[0], height: SIZES.ascii[1] }} aria-hidden={mode !== 'ascii'}>
        <span className="isl-eq" aria-hidden><i /><i /><i /></span>
        <span className="txt"><b>아스키 재생 중</b><small>{ascii}</small></span>
        <button className="isl-stop" onClick={(e) => (e.stopPropagation(), onAsciiStop?.())} tabIndex={mode === 'ascii' ? 0 : -1} aria-label="아스키 끄기">
          <svg viewBox="0 0 12 12" aria-hidden><rect x="3" y="3" width="6" height="6" rx="1.2" fill="currentColor" /></svg>
        </button>
      </div>

      <div className="island-layer nowPlaying" style={{ width: SIZES.nowPlaying[0], height: SIZES.nowPlaying[1] }} aria-hidden={mode !== 'nowPlaying'}>
        <Disc rec={playingRec} size={52} spinRef={disc} />
        <span className="txt">
          <small>{alive ? '지금 회전 중' : '지금 작업 중'}</small>
          <b>{playing?.title}</b>
          <span className="bar"><i style={{ transform: `scaleX(${Math.min(1, mins / CYCLE)})` }} /></span>
        </span>
        <span className="time">{mins}<small>/{CYCLE}분</small></span>
      </div>

      <div className="island-layer cue" style={{ width: SIZES.cue[0], height: SIZES.cue[1] }} aria-hidden={mode !== 'cue'}>
        <Disc size={52} />
        <span className="txt">
          <b>{lp === 'over' ? '놓으면 실행해요' : 'Island 로 끌어 오세요'}</b>
          <small>앱을 열고, 앱이 도는 동안 여기서 돌아요</small>
        </span>
      </div>

      <div className="island-layer news" style={{ width: SIZES.news[0], height: SIZES.news[1], '--g': groupOf(news?.group)?.color } as React.CSSProperties} aria-hidden={mode !== 'news'} role="status">
        {news && <Avatar m={groupOf(news.group)?.members.find((m) => m.name === news.who) ?? { name: news.who, online: true }} color={groupOf(news.group)?.color ?? '#64748b'} size={34} />}
        <span className="txt">
          <b>{news?.who}님이 {groupOf(news?.group)?.name} {news?.what}</b>
          <small>{news?.detail}</small>
        </span>
        <span className="chip gchip">{groupOf(news?.group)?.name}</span>
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
          <small>{groupOf(alert?.group) ? '팀 일정 · 지금' : '알림 · 지금'}</small>
          {groupOf(alert?.group) && <span className="chip gchip" style={{ '--g': groupOf(alert?.group)!.color } as React.CSSProperties}>{groupOf(alert?.group)!.name}</span>}
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
