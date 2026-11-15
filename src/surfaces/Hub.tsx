import { useLayoutEffect, type ReactNode } from 'react'
import type { NextItem } from './Island'
import { fmtWhen } from './Island'
import { usePresence } from './Tile'

/* 허브 (레이아웃 A): 노치를 누르거나 0.3초 머물면 아일랜드 창 안에서 아래로 펼쳐진다.
   위 = 오늘 줄(다음 일정 · 남은 할 일), 가운데 = 이름 붙은 아이콘 13개, 아래 = '앱 실행 · Ctrl K'.
   아이콘을 누르면 그 떠 있는 창을 열고(이미 있으면 앞으로) 허브는 접힌다. */

export type HubKind = 'notes' | 'todo' | 'calendar' | 'chat' | 'term' | 'clips' | 'shelf' | 'ocr' | 'snippets' | 'lp' | 'team' | 'link' | 'settings'

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
const Ico = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>

type Props = {
  open: boolean
  next: NextItem | null
  todos: number // 남은 할 일
  badges: Partial<Record<HubKind, ReactNode>> // 아이콘 위 작은 표시 (읽지 않음 수 · 실행 중 · 선반 개수 · 펼침)
  onPick: (k: HubKind) => void
  onNewNote: () => void
  onPalette: () => void
  onRect: (r: DOMRect | null) => void // 클릭 통과 히트 rect (레이아웃 상자 — 스프링 transform 과 무관)
}

export function Hub({ open, next, todos, badges, onPick, onNewNote, onPalette, onRect }: Props) {
  const p = usePresence<HTMLDivElement>(open)
  useLayoutEffect(() => {
    const el = p.ref.current
    onRect(open && el ? new DOMRect(el.offsetLeft - el.offsetWidth / 2, el.offsetTop, el.offsetWidth, el.offsetHeight) : null)
  }, [open, p.mounted])
  if (!p.mounted) return null
  return (
    <div ref={p.ref} className="hub" onTransitionEnd={p.onTransitionEnd} role="dialog" aria-label="Hera 허브">
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
            <button className="hub-icon" data-k={k} onClick={() => onPick(k)} aria-label={label}>
              <span className="hub-ico"><Ico d={I[k]} />{badges[k] != null && badges[k] !== false && <em>{badges[k]}</em>}</span>
              <span className="hub-label">{label}</span>
            </button>
            {k === 'notes' && (
              <button className="hub-plus" onClick={onNewNote} aria-label="새 메모" title="새 메모">+</button>
            )}
          </span>
        ))}
      </div>
      <button className="hub-k" onClick={onPalette}>
        <span>앱 실행 · 나머지 검색</span>
        <kbd>Ctrl Alt K</kbd>
      </button>
    </div>
  )
}
