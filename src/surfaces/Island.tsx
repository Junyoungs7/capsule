import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { LpRecord, Notification, RunningSession } from '../data/types'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { isTauri, reportHitRects } from '../data/api'
import { Disc, useSpin } from './Lp'
import { Avatar, groupOf } from './Team'

export type NextItem = { title: string; at?: string; kind: 'todo' | 'event' }
/** Hera Link 표시: 엔진 연결 · 파일 채널(files) · 화면 전환(swap, n 이 바뀔 때마다 1번) · 페어링 코드 · 전송 진행 */
export type LinkView = {
  connected: boolean
  peer: string
  files: boolean
  swap: { onPeer: boolean; n: number } | null
  pair: { code: string; name: string } | null
  xfer: { dir: 'in' | 'out'; name: string; bytes: number; size: number; done?: boolean } | null
}
type Mode = 'msg' | 'flash' | 'idle' | 'preview' | 'alert' | 'nowPlaying' | 'drop' | 'cue' | 'news' | 'ascii' | 'swap' | 'pair' | 'xfer' | 'ime'
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
  swap: [196, 44, 22],
  pair: [404, 104, 30],
  xfer: [372, 68, 30],
  ime: [68, 36, 18],
  flash: [280, 44, 22],
  msg: [420, 104, 30],
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
  link?: LinkView | null
  onSendFiles?: (paths: string[]) => void // 연결 중 드롭존 오른쪽 절반 = 맥으로 보내기
  onPair?: (ok: boolean) => void
  ime?: { source: 'ko' | 'en'; n: number } | null // 한/영이 바뀐 직후 0.8초 '한'/'A' 칩
  onChip?: () => void // 연결 칩 클릭 = 맥 화면에 아스키 켜기/끄기
  // 허브 시안(독 없음): 알약 = 시계 · 다음 일정 · 작은 LP(재생 중) + 정지. 호버 미리보기 대신 허브가 열린다.
  // notch = 접힌 상태(얇은 노치 120×6, 글자 없음 · 점만). 펼침 = 시계 · 다음 일정 · 선반 칩
  pill?: { clock: string; next?: string; badge?: number; busy?: string; notch: boolean; shelf?: number; onShelf?: () => void }
  msg?: { who: string; group: string; color: string; text: string; n: number } | null // 팀 채팅 수신 + 빠른 답장
  onReply?: (text: string) => void
  onMsgOpen?: () => void
  onHover?: (on: boolean, pointerType: string) => void
  flash?: { text: string; rec?: LpRecord; n: number; icon?: 'ok' | 'fail' | 'spin' } | null // 잠깐 뜨는 한 줄 ('실행 중 · 앱' · '복사됨')
  forceDrop?: boolean // 시안: 휴대폰에서 '파일 놓기' 흉내
}

export function Island({ alert, next, playing, playingRec, peek, onDone, onSnooze, onOpen, onDropFiles, alive = false, lp = 'off', news = null, ascii = null, onAscii, onAsciiStop, link, onSendFiles, onPair, ime, onChip, pill, onHover, flash, forceDrop, msg, onReply, onMsgOpen }: Props) {
  const [hover, setHover] = useState(false)
  // v2: 파일을 끌고 오면 '선반에 놓기' 드롭존. 시안 = HTML5 드래그(파일 이름만).
  // 실제 앱: island 창 네이티브 드롭(경로). 클릭 통과는 watch 루프가 창 밖에서 누른 채 들어오는 드래그일 때 모양 +24px 를 받아 준다
  // (idle 알약 위로 오면 통과 해제 → 'enter' → drop 모양으로 커지고 그 rect 를 보고).
  const [drag, setDrag] = useState(false)
  // 맥과 파일 채널이 연결돼 있으면 드롭존이 두 칸: 왼쪽 = 선반에 놓기, 오른쪽 = Mac으로 보내기 (커서 x 로 고름)
  const split = !!link?.files && !!onSendFiles
  const [toPeer, setToPeer] = useState(false)
  const drop = useRef({ onDropFiles, onSendFiles, split })
  drop.current = { onDropFiles, onSendFiles, split }
  const right = (clientX: number) => clientX >= innerWidth / 2
  useEffect(() => {
    if (!isTauri) return
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload
      if (p.type === 'enter' || p.type === 'over') return setDrag(true), setToPeer(right(p.position.x / devicePixelRatio))
      setDrag(false)
      if (p.type !== 'drop' || !p.paths.length) return
      const d = drop.current
      if (d.split && right(p.position.x / devicePixelRatio)) d.onSendFiles!(p.paths)
      else d.onDropFiles(p.paths)
    })
    return () => void off.then((f) => f())
  }, [])
  // 화면 전환 표시는 swap.n 이 바뀔 때만 (1.6초 — Desktop 이 지움)
  const mode: Mode = link?.pair ? 'pair' : drag || forceDrop ? 'drop' : msg ? 'msg' : flash ? 'flash' : alert ? 'alert' : ime ? 'ime' : lp !== 'off' ? 'cue' : link?.xfer ? 'xfer' : ascii ? 'ascii' : link?.swap ? 'swap' : news ? 'news' : (hover && !pill) || peek ? 'preview' : playing ? 'nowPlaying' : 'idle'
  const files = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  const dnd = {
    onDragEnter: (e: DragEvent) => files(e) && (e.preventDefault(), setDrag(true)),
    onDragOver: (e: DragEvent) => files(e) && (e.preventDefault(), (e.dataTransfer.dropEffect = 'copy'), setToPeer(right(e.clientX))),
    onDragLeave: (e: DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrag(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      setDrag(false)
      const names = [...e.dataTransfer.files].map((f) => f.name)
      if (names.length) (split && right(e.clientX) ? onSendFiles! : onDropFiles)(names)
    },
  }
  const pillW = pill ? 300 + (pill.badge ? 30 : 0) + (pill.shelf ? 64 : 0) : 0
  const [w, h, r] = mode === 'idle' && pill ? (pill.notch ? ([120, 6, 3] as const) : ([pillW, 40, 20] as const)) : mode === 'drop' && split ? ([404, 92, 30] as const) : mode === 'idle' && link?.connected ? ([156, 36, 18] as const) : SIZES[mode]
  const pct = link?.xfer ? Math.round((100 * link.xfer.bytes) / Math.max(1, link.xfer.size)) : 0

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
      data-xfer={link?.xfer ? `${link.xfer.dir}${link.xfer.done ? '-done' : ''}` : undefined}
      data-lp={lp}
      onPointerEnter={(e) => (setHover(true), onHover?.(true, e.pointerType))}
      onPointerLeave={(e) => (setHover(false), onHover?.(false, e.pointerType))}
      onClick={() => (mode === 'preview' || (pill && (mode === 'idle' || mode === 'nowPlaying'))) && onOpen()}
      {...dnd}
    >
      {/* 블러 없는 짙은 판 1장 — clip-path(path)+backdrop-filter 재래스터가 버벅임 원인이었음 */}
      <div className="island-shape" style={{ width: w, height: h, borderRadius: r }} />

      {pill && (
        <>
          <div className="island-layer hubnotch" style={{ width: 120, height: 6 }} aria-hidden={mode !== 'idle' || !pill.notch}>
            {!!pill.badge && <i data-k="unread" />}
            {pill.busy && <i data-k="busy" />}
            {!!pill.shelf && <i data-k="shelf" />}
          </div>
          <div className="island-layer hubpill" style={{ width: pillW, height: 40 }} aria-hidden={mode !== 'idle' || pill.notch}>
            <b className="pill-clock">{pill.clock}</b>
            {pill.busy ? <span className="pill-next pill-busy"><i className="hub-spin" />{pill.busy}</span> : <span className="pill-next">{pill.next ?? '예정 없음'}</span>}
            {!!pill.badge && <span className="pill-badge" aria-label={`읽지 않은 메시지 ${pill.badge}개`}>{pill.badge}</span>}
            {!!pill.shelf && (
              <button className="pill-shelf" onClick={(e) => (e.stopPropagation(), pill.onShelf?.())} tabIndex={mode === 'idle' && !pill.notch ? 0 : -1} aria-label={`선반 파일 ${pill.shelf}개 보기`}>
                <i />선반 {pill.shelf}
              </button>
            )}
          </div>
        </>
      )}
      <div className="island-layer hubflash" style={{ width: SIZES.flash[0], height: SIZES.flash[1] }} aria-hidden={mode !== 'flash'} role="status">
        {flash?.rec ? <Disc rec={flash.rec} size={30} /> : flash?.icon === 'spin' ? <i className="hub-spin" /> : <span className="flash-ok" data-fail={flash?.icon === 'fail'} aria-hidden>{flash?.icon === 'fail' ? '✕' : '✓'}</span>}
        <b key={flash?.n}>{flash?.text}</b>
      </div>
      {onReply && (
        <form className="island-layer hubmsg" style={{ width: SIZES.msg[0], height: SIZES.msg[1], '--g': msg?.color } as React.CSSProperties} aria-hidden={mode !== 'msg'} role="status"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault()
            const el = e.currentTarget.elements.namedItem('r') as HTMLInputElement
            if (el.value.trim()) onReply(el.value.trim())
            el.value = ''
          }}>
          <button type="button" className="msg-head" onClick={onMsgOpen} tabIndex={mode === 'msg' ? 0 : -1}>
            <i className="msg-dot" />
            <b>{msg?.who}</b>
            <small>{msg?.group} · 채팅</small>
          </button>
          <span className="msg-text">{msg?.text}</span>
          <span className="msg-reply">
            <input name="r" key={msg?.n} placeholder="빠른 답장…" autoComplete="off" tabIndex={mode === 'msg' ? 0 : -1} />
            <button className="primary" tabIndex={mode === 'msg' ? 0 : -1}>보내기</button>
          </span>
        </form>
      )}
      <div className="island-layer idle" data-pill={!!pill} style={{ width: link?.connected ? 156 : SIZES.idle[0], height: SIZES.idle[1] }} aria-hidden={mode !== 'idle'}>
        <span className="pulse" data-on={!!playing} />
        <span>{today}</span>
        {link?.connected && (
          <button className="link-chip" data-peer={link.swap?.onPeer ?? false} onClick={(e) => (e.stopPropagation(), onChip?.())} title={`${link.peer} 연결됨 · 클릭: ${link.peer} 화면에 아스키 켜기/끄기`} tabIndex={mode === 'idle' ? 0 : -1}>
            {link.peer.slice(0, 6)}
          </button>
        )}
      </div>

      <div className="island-layer ime" style={{ width: SIZES.ime[0], height: SIZES.ime[1] }} aria-hidden={mode !== 'ime'}>
        <b key={ime?.n} data-src={ime?.source}>{ime?.source === 'ko' ? '한' : 'A'}</b>
      </div>

      <div className="island-layer swap" style={{ width: SIZES.swap[0], height: SIZES.swap[1] }} aria-hidden={mode !== 'swap'} data-dir={link?.swap?.onPeer ? 'out' : 'in'}>
        <b key={link?.swap?.n}>{link?.swap?.onPeer ? `→ ${link.peer}` : '← Windows'}</b>
      </div>

      <div className="island-layer pair" style={{ width: SIZES.pair[0], height: SIZES.pair[1] }} aria-hidden={mode !== 'pair'} role="dialog" aria-label="Hera Link 페어링">
        <span className="txt">
          <small>{link?.pair?.name} 연결 · 양쪽 숫자가 같나요?</small>
          <b className="code">{link?.pair ? `${link.pair.code.slice(0, 3)} ${link.pair.code.slice(3)}` : ''}</b>
        </span>
        <span className="actions">
          <button onClick={() => onPair?.(false)} tabIndex={mode === 'pair' ? 0 : -1}>취소</button>
          <button className="primary" onClick={() => onPair?.(true)} tabIndex={mode === 'pair' ? 0 : -1}>같아요</button>
        </span>
      </div>

      <div className="island-layer xfer" style={{ width: SIZES.xfer[0], height: SIZES.xfer[1] }} aria-hidden={mode !== 'xfer'}>
        <span className="file-ico" data-dir={link?.xfer?.dir} />
        <span className="txt">
          <small>{link?.xfer?.dir === 'in' ? `${link.peer}에서 받는 중` : `${link?.peer ?? 'Mac'}으로 보내는 중`}{link?.xfer?.done ? ' · 완료' : ''}</small>
          <b>{link?.xfer?.name}</b>
          <span className="bar"><i style={{ transform: `scaleX(${pct / 100})` }} /></span>
        </span>
        <span className="time">{pct}<small>%</small></span>
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

      <div className="island-layer drop" data-split={split} style={{ width: split ? 404 : SIZES.drop[0], height: SIZES.drop[1] }} aria-hidden={mode !== 'drop'}>
        <span className="tray">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v10M8 10l4 4 4-4" /><path d="M4 14v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3" /></svg>
        </span>
        <span className="txt" data-hot={split ? !toPeer : true}>
          <b>선반에 놓기</b>
          <small>{split ? '선반에 담기' : '놓으면 선반에 담아 둘게요 · 최대 4개'}</small>
        </span>
        {split && (
          <span className="txt to-peer" data-hot={toPeer}>
            <b>{link!.peer}으로 보내기</b>
            <small>놓으면 바로 전송</small>
          </span>
        )}
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
