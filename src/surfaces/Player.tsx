import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import type { LpRecord } from '../data/types'
import { asciiStop, fxStop, isTauri, onEvent, openAscii, openFx } from '../data/api'
import { ASCII_RECORDS, Disc, useSpin } from './Lp'

/* LP 플레이어 (떠 있는 유리 턴테이블 · 허브 'LP'): 화면 효과 · 아스키 장면이 레코드.
   레코드를 플래터에 끌어 놓기(또는 누르기) = 재생 → 암이 내려가고 판이 돈다. 암 들기 · 판 꺼내기 = 정지.
   재생은 기존 창이 한다 — 효과 = fx 창(25초), 아스키 = 전체화면 아스키. 끝나면(Esc·시간) 판이 상자로 돌아온다. */

export type PlayerRec = { id: string; title: string; cover: string; glyph: string; kind: 'fx' | 'ascii'; arg: string }
export const PLAYER_RECORDS: PlayerRec[] = [
  ...([['snow', '눈', '#7dd3fc', '❅'], ['rain', '비', '#3b82f6', '☂'], ['leaves', '단풍', '#ea580c', '❦'], ['sunset', '노을', '#f97316', '☀'], ['moon', '달·별', '#4338ca', '☾']] as const).map(
    ([arg, title, cover, glyph]) => ({ id: 'fx:' + arg, title, cover, glyph, kind: 'fx' as const, arg }),
  ),
  ...ASCII_RECORDS.map((r) => ({ id: r.id, title: r.title.replace('아스키 · ', ''), cover: r.cover, glyph: { auto: '✦', xmas: '❄', city: '☾', autumn: '❦', calm: '☘' }[r.scene ?? 'auto'], kind: 'ascii' as const, arg: r.scene ?? 'auto' })),
]
const asRec = (r: PlayerRec): LpRecord => ({ id: r.id, title: r.title, target: '', kind: 'ascii', cover: r.cover, glyph: 'ascii' })

type Props = {
  // 시안: 실제 창 대신 부모가 재생 (효과 오버레이 · 아스키 전체화면)
  onPlay?: (r: PlayerRec) => void
  onStop?: (r: PlayerRec) => void
}

export function Player({ onPlay, onStop }: Props) {
  const [on, setOn] = useState<PlayerRec | null>(null) // 플래터 위
  const [arm, setArm] = useState(false) // 암 내려옴 = 재생 중
  const [over, setOver] = useState(false) // 끄는 판이 플래터 위
  const spin = useRef<HTMLSpanElement>(null)
  useSpin(spin, arm)
  const platter = useRef<HTMLDivElement>(null)
  const cur = useRef(on)
  cur.current = on

  const play = (r: PlayerRec) => {
    if (cur.current && cur.current.id !== r.id) stop(cur.current, false)
    setOn(r)
    setArm(false)
    // 판이 내려앉고 암이 내려오는 동안 잠깐 뒤 재생
    setTimeout(() => {
      setArm(true)
      if (onPlay) return onPlay(r)
      if (r.kind === 'fx') void openFx(r.arg)
      else void openAscii(null, r.arg === 'auto' ? undefined : r.arg)
    }, 420)
  }
  const stop = (r = cur.current, eject = true) => {
    if (!r) return
    setArm(false)
    if (eject) setTimeout(() => setOn((x) => (x?.id === r.id ? null : x)), 360)
    if (onStop) return onStop(r)
    if (r.kind === 'fx') void fxStop()
    else void asciiStop()
  }

  // 재생이 끝나면(효과 시간 끝 · 아스키 Esc) 판을 상자로
  useEffect(() => {
    if (!isTauri) return
    const end = (kind: 'fx' | 'ascii') => () => cur.current?.kind === kind && (setArm(false), setTimeout(() => setOn(null), 360))
    const offs = [onEvent('fx-closed', end('fx')), onEvent('ascii-closed', end('ascii'))]
    return () => offs.forEach((off) => off())
  }, [])

  // 끌어서 플래터에 놓기 (6px 미만 = 누르기 → 바로 재생)
  const drag = (r: PlayerRec, e: RPointerEvent<HTMLButtonElement>) => {
    const el = e.currentTarget
    const [x0, y0] = [e.clientX, e.clientY]
    let ghost: HTMLElement | null = null
    let hit = false
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return
      if (!ghost) {
        ghost = el.querySelector('.lp')!.cloneNode(true) as HTMLElement
        ghost.classList.add('lp-ghost')
        document.body.append(ghost)
      }
      ghost.style.transform = `translate(${ev.clientX - 34}px, ${ev.clientY - 34}px)`
      const p = platter.current!.getBoundingClientRect()
      hit = Math.hypot(ev.clientX - (p.left + p.width / 2), ev.clientY - (p.top + p.height / 2)) < p.width / 2 + 16
      setOver(hit)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setOver(false)
      ghost?.remove()
      if (!ghost || hit) play(r)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div className="player">
      <div className="deck" data-over={over} data-playing={arm}>
        <div ref={platter} className="platter" aria-label={on ? `${on.title} ${arm ? '재생 중' : ''}` : '빈 플래터 — 레코드를 끌어 놓으세요'}>
          {on ? (
            <button className="on-platter" onClick={() => stop()} title="판 꺼내기 (정지)" aria-label={`${on.title} 꺼내기`}>
              <Disc rec={asRec(on)} glyph={on.glyph} size={176} spinRef={spin} />
            </button>
          ) : (
            <span className="mat">{over ? '놓으면 재생' : '레코드를 여기로'}</span>
          )}
        </div>
        <button className="arm" data-down={arm} onClick={() => (arm ? stop() : on && play(on))} aria-label={arm ? '암 들기 (정지)' : '암 내리기 (재생)'} title={arm ? '암 들기 = 정지' : '암 내리기 = 재생'}>
          <i />
        </button>
        <span className="deck-label">{on ? `${on.kind === 'fx' ? '화면 효과' : '아스키'} · ${on.title}${arm ? ' · 재생 중' : ''}` : '화면 효과 · 아스키 장면'}</span>
      </div>
      <div className="lp-recs" role="list" aria-label="레코드">
        {PLAYER_RECORDS.map((r) => (
          <button key={r.id} role="listitem" className="crate-rec" data-on={on?.id === r.id} onPointerDown={(e) => drag(r, e)} title={`${r.title} — 끌어서 플래터에 (누르면 바로 재생)`}>
            <Disc rec={asRec(r)} glyph={r.glyph} size={56} />
            <small>{r.title}</small>
          </button>
        ))}
      </div>
    </div>
  )
}
