import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import { isTauri, onStore, storeGet, storeSet, useItems } from '../data/api'
import { reducedMotion } from './Tile'
import { Avatar, groupOf } from './Team'
import { EMPTY } from '../data/mock'

/* 메모 (a4): 포스트잇은 바탕화면이 아니라 '메모 보드'(떠 있는 창 float-notes)에 붙는다.
   예전 바탕화면 메모 창(모니터마다 투명 창) · 앱 메모 · 펼침/접힘은 지웠다 — 처음 실행 때 Rust 가 메모를 보드 격자로 옮긴다 (notes.rs).
   보드: 끌어 옮기기 · 오른쪽 아래로 크기 · 제자리 편집 · 색 · 삭제 · 메모장으로 열기 (Rust 가 파일을 쓰고 notepad.exe, 고치면 다시 읽어 온다). */
type V3 = { ocr: boolean }
let st: V3 = { ocr: false }
const subs = new Set<() => void>()
export const setV3 = (p: Partial<V3>) => ((st = { ...st, ...p }), subs.forEach((f) => f()))
export const useV3 = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => st)

// 메모: 키 note:<id>, x·y·w·h = 보드 안 자리 (논리 px). group = Hera Team 공유 메모판 id, by = 마지막 편집자
export type Note = { id: string; text: string; color: number; x: number; y: number; w: number; h: number; group?: string; by?: string }
export const NOTE_COLORS = ['#f5c542', '#f47fb0', '#5bb8f5', '#42c9a0', '#a78bfa', '#f59e6b']
export const NOTE_COLOR_NAMES = ['노랑', '분홍', '하늘', '민트', '라벤더', '살구']
/** (a7) 새 메모 기본 색 = 마지막 메모의 다음 색 */
export const nextColor = (notes: Pick<Note, 'color'>[]) => (notes.length ? ((notes[notes.length - 1].color ?? 0) + 1) % NOTE_COLORS.length : 0)
/** (a7) 메모 입력: Enter = 저장, Shift+Enter = 줄 바꿈. 한글 조합 중(isComposing · 229)의 Enter 는 글자 확정이라 저장하지 않는다 */
export const enterCommits = (e: { key: string; shiftKey: boolean; nativeEvent: KeyboardEvent }) =>
  e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229

export const seedNotes: Note[] = EMPTY ? [] : [
  { id: 'n1', text: '오늘 3시 배너 QA\n디자인팀 피드백 반영본으로 확인', color: 0, x: 16, y: 16, w: 210, h: 140 },
  { id: 'n2', text: '- [x] 주간 보고 초안\n- [ ] 휴가 신청 (12/24)\n- [ ] 노트북 반납', color: 3, x: 248, y: 16, w: 210, h: 140 },
  { id: 'n3', text: '와이파이 HERA-5G\nhera2026!', color: 4, x: 480, y: 16, w: 210, h: 140 },
]

/** 보드의 빈 칸 (3열 격자, 카드 210×140) — 새 메모 자리 */
export function freeSlot(notes: Pick<Note, 'x' | 'y'>[]) {
  for (let i = 0; ; i++) {
    const [x, y] = [16 + (i % 3) * 232, 16 + Math.floor(i / 3) * 156]
    if (!notes.some((n) => Math.abs(n.x - x) < 60 && Math.abs(n.y - y) < 60)) return { x, y }
  }
}

const CHECK = /^- \[( |x)\] ?/i

/** 메모 보드 (float-notes 창의 몸) */
export function NoteBoard({ onNotepad }: { onNotepad: (id: string) => void }) {
  const [notes, setNotes] = useItems<Note>('note', seedNotes)
  const [front, setFront] = useState<string | null>(null)
  const [fresh, setFresh] = useState<string | null>(null)
  const patch = (id: string, p: Partial<Note>) => setNotes((all) => all.map((n) => (n.id === id ? { ...n, ...p } : n)))
  const add = () => {
    const id = crypto.randomUUID()
    setNotes((all) => [...all, { id, text: '', color: nextColor(all), ...freeSlot(all), w: 210, h: 140 }])
    setFront(id)
    setFresh(id)
  }
  // 아일랜드 '새 메모'·'보드에 붙이기' → note.edit = id → 그 메모를 바로 편집
  useEffect(() => {
    if (!isTauri) return
    const edit = (id: unknown) => typeof id === 'string' && id && (setFront(id), setFresh(id), storeSet('note.edit', null))
    void storeGet<string>('note.edit').then(edit)
    return onStore((k, v) => k === 'note.edit' && edit(v))
  }, [])
  const [bw, bh] = [Math.max(0, ...notes.map((n) => n.x + n.w)) + 16, Math.max(0, ...notes.map((n) => n.y + n.h)) + 16]
  return (
    <div className="board" style={{ minWidth: bw, minHeight: bh }} onDoubleClick={(e) => e.target === e.currentTarget && add()}>
      {notes.length === 0 && <p className="board-empty">빈 보드예요 — 빈 곳을 두 번 누르거나 + 로 메모를 붙이세요</p>}
      {notes.map((n) => (
        <NoteCard key={n.id} n={n} z={front === n.id ? 3 : 1} edit={fresh === n.id} onFront={() => setFront(n.id)} onPatch={(p) => patch(n.id, p)}
          onNotepad={() => onNotepad(n.id)} onDelete={() => setNotes((all) => all.filter((x) => x.id !== n.id))} />
      ))}
      <button className="board-add fab" aria-label="새 메모" onClick={() => add()}><Ico d="M12 5v14M5 12h14" /></button>
    </div>
  )
}

/* 메모 카드 (보드 안). 바를 끌어 이동, 오른쪽 아래 모서리로 크기. 이동·크기 중엔 style 직접 쓰고 놓을 때 저장. */
function NoteCard({ n, z, edit: edit0, onFront, onPatch, onNotepad, onDelete }: {
  n: Note
  z?: number
  edit?: boolean
  onFront?: () => void
  onPatch: (p: Partial<Note>) => void
  onNotepad: () => void
  onDelete: () => void
}) {
  const pos = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const [edit, setEdit] = useState(!!edit0)
  useEffect(() => void (edit0 && setEdit(true)), [edit0]) // '새 메모' 요청이 카드보다 늦게 와도 편집으로
  const [pop, setPop] = useState<'color' | null>(null)
  const g = groupOf(n.group)
  const editor = g?.members.find((m) => m.name === n.by)

  // 새 메모: 살짝 튀어나오며 등장
  useLayoutEffect(() => {
    if (edit0 && !reducedMotion()) card.current!.animate([{ transform: 'scale(0.86)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 600, easing: getComputedStyle(document.documentElement).getPropertyValue('--spring-bouncy') })
  }, [])

  // 사라짐(삭제·앱에 붙이기)도 애니메이션 후 반영
  const leave = (then: () => void) => {
    const a = card.current!.animate([{ opacity: 1 }, { transform: reducedMotion() ? 'none' : 'scale(0.9) translateY(6px)', opacity: 0 }], { duration: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' })
    a.onfinish = then
  }

  const grab = (e: RPointerEvent, kind: 'move' | 'size') => {
    if ((e.target as Element).closest('button') && kind === 'move') return
    onFront?.()
    const el = pos.current!, sx = e.clientX, sy = e.clientY
    let { x, y, w, h } = n
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy
      if (kind === 'move') {
        x = Math.max(0, n.x + dx) // 보드 안 (오른쪽·아래로는 보드가 늘어나 스크롤)
        y = Math.max(0, n.y + dy)
        el.style.transform = `translate(${x}px, ${y}px)`
      } else {
        w = Math.max(160, n.w + dx)
        h = Math.max(96, n.h + dy)
        el.style.width = w + 'px'
        el.style.height = h + 'px'
      }
    }
    const up = () => (removeEventListener('pointermove', move), removeEventListener('pointerup', up), onPatch({ x, y, w, h }))
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  const lines = n.text.split('\n')
  const toggle = (i: number) => onPatch({ text: lines.map((l, j) => (j === i ? l.replace(CHECK, (m) => (/x/i.test(m) ? '- [ ] ' : '- [x] ')) : l)).join('\n') })

  return (
    <div ref={pos} className="note-pos" style={{ transform: `translate(${n.x}px, ${n.y}px)`, width: n.w, height: n.h, zIndex: z }} onPointerDown={onFront}>
      <div ref={card} className="note" data-id={n.id} data-group={!!g} style={{ '--nc': NOTE_COLORS[n.color], ...(g && { '--g': g.color }) } as CSSProperties}>
        {g && <i className="note-gbar" aria-hidden />}
        <header className="note-bar" onPointerDown={(e) => grab(e, 'move')}>
          {g && <span className="note-group" title={`${g.name} 공유 메모 · ${n.by} 마지막 편집`}><Avatar m={editor ?? { name: n.by ?? '?', online: false }} color={g.color} size={16} /><small>{g.name}</small></span>}
          <span className="grow" />
          <button onClick={() => setPop(pop === 'color' ? null : 'color')} aria-label="색 바꾸기"><i className="note-swatch" /></button>
          <button onClick={onNotepad} aria-label="메모장으로 열기" data-notepad><Ico d="M7 3.5h7.5L19 8v11a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z M14.5 3.5V8H19 M8.5 12.5h7 M8.5 16h4.5" /></button>
          <button onClick={() => leave(onDelete)} aria-label="메모 삭제"><Ico d="M7 7l10 10M17 7L7 17" /></button>
        </header>
        {pop === 'color' && (
          <div className="note-pop note-colors" role="group" aria-label="메모 색">
            {NOTE_COLORS.map((c, i) => (
              <button key={c} style={{ '--nc': c } as CSSProperties} aria-pressed={n.color === i} aria-label={NOTE_COLOR_NAMES[i]} onClick={() => (onPatch({ color: i }), setPop(null))} />
            ))}
          </div>
        )}
        {edit ? (
          <textarea className="note-body" autoFocus value={n.text} onChange={(e) => onPatch({ text: e.target.value })} onBlur={() => setEdit(false)} onKeyDown={(e) => enterCommits(e) && (e.preventDefault(), setEdit(false))} placeholder="메모 · Enter = 저장 · Shift+Enter = 줄 바꿈" aria-label="메모 내용" />
        ) : (
          <div className="note-body" onClick={(e) => (e.target as Element).closest('label') || setEdit(true)}>
            {!n.text && <p className="note-ph">메모를 입력하세요</p>}
            {lines.map((l, i) =>
              CHECK.test(l) ? (
                <label key={i} className="note-check" data-done={/x/i.test(l.slice(3, 4))}>
                  <input type="checkbox" checked={/x/i.test(l.slice(3, 4))} onChange={() => toggle(i)} />
                  <span>{l.replace(CHECK, '')}</span>
                </label>
              ) : (
                <p key={i}>{l || ' '}</p>
              ),
            )}
          </div>
        )}
        {<i className="note-resize" onPointerDown={(e) => grab(e, 'size')} aria-hidden />}
      </div>
    </div>
  )
}

const Ico = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>

/* ── 데모 바 'v3' 묶음 (시안 전용) ── */
export function V3Demo({ onPanel, onPalette }: { onPanel: (v: 'calendar' | 'snippets') => void; onPalette: () => void }) {
  const snippets = () => {
    onPalette()
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLInputElement>('.palette-input input')
      if (!el) return
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, ';')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  return (
    <>
      <header className="demo-sub">
        <b>v3</b>
        <small>달력 · 글자 복사 · 상용구</small>
      </header>
      <div className="demo-btns v3">
        <button onClick={() => onPanel('calendar')}>월간 달력</button>
        <button onClick={() => setV3({ ocr: true })}>글자 복사 <kbd>Ctrl Alt T</kbd></button>
        <button onClick={snippets}>상용구 <kbd>;</kbd></button>
        <button onClick={() => onPanel('snippets')}>상용구 편집</button>
      </div>
    </>
  )
}
