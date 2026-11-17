import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Todo } from '../data/types'
import { dayKey } from '../data/holidays'
import { Ico } from './Icons'
import { chip, fmtWhen, moveStart, parseWhen, segmentAt, setEnd, stepWhen, weekday, type When } from '../data/when'

/* 할 일 기간 (a4): 시작 → 끝, 둘 다 직접 쓰거나(느슨하게: '11/20', '내일 3시', '1430'…) 바로 고르기 칩 · 작은 달력.
   기본 = 지금(다음 5분) ~ +1시간 — '할 일 + Enter' 만으로 저장된다. Tab 으로 칸 이동, ↑/↓ 는 커서가 있는 칸(월·일·시·분) 한 칸.
   네이티브 날짜 팝업은 쓰지 않는다: 웹뷰 밖 별도 창이라 그 안을 누르면 아일랜드 밖 클릭으로 잡혀 허브가 접혔다. */

const md = (k: string) => `${+k.slice(5, 7)}/${+k.slice(8, 10)}`
const hm = (d: Date) => d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })

/** 목록 표시: 하루면 '오늘 18:00', 여러 날이면 '11/16 – 11/18 18:00' */
export function todoWhen(t: Pick<Todo, 'start' | 'due'>, fmt: (iso?: string) => string) {
  if (!t.due) return fmt(undefined)
  if (!t.start || dayKey(new Date(t.start)) === dayKey(new Date(t.due))) return fmt(t.due)
  const d = new Date(t.due)
  return `${md(dayKey(new Date(t.start)))} – ${md(dayKey(d))} ${hm(d)}`
}

/** 할 일이 걸친 날들 (달력 점·목록) */
export function todoDays(t: Pick<Todo, 'start' | 'due'>): string[] {
  if (!t.due) return []
  const e = new Date(t.due)
  const out: string[] = []
  for (let d = new Date(t.start ?? t.due); dayKey(d) <= dayKey(e) && out.length < 62; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) out.push(dayKey(d))
  return out.length ? out : [dayKey(e)]
}

/** 날짜·시각 한 칸: 직접 쓰기(Enter·포커스 잃을 때 해석) · ↑/↓ 한 칸 */
function TimeField({ label, date, allDay, onCommit }: { label: string; date: Date; allDay: boolean; onCommit: (d: Date) => void }) {
  const shown = fmtWhen(date, allDay)
  // 고치는 중일 때만 draft, 아니면 늘 부모 값(shown) — (a7) 예전엔 draft 를 effect 로 shown 에 맞춰
  // 시작을 바꾸면 끝 칸이 한 프레임 늦게(때로는 그 사이 읽힌 옛 값으로) 보였다
  const [draft, setDraft] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  const el = useRef<HTMLInputElement>(null)
  const caretAt = useRef<number | null>(null) // ↑↓ 뒤 커서 자리 (값이 바뀌면 브라우저가 끝으로 옮긴다 → 바로 되돌림, 다음 키가 오기 전에)
  useLayoutEffect(() => {
    const c = caretAt.current
    if (c != null && el.current && document.activeElement === el.current) el.current.setSelectionRange(c, c)
  })
  const commit = () => {
    if (draft === null) return
    setDraft(null)
    if (draft.trim() === shown) return
    const d = parseWhen(draft, date)
    if (!d) return void (setBad(true), setTimeout(() => setBad(false), 900))
    onCommit(d)
  }
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') return void (e.preventDefault(), commit()) // 날짜 칸의 Enter 는 저장이 아니라 해석
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return void (caretAt.current = null) // ←/→ 등으로 커서를 옮기면 그 자리로
    e.preventDefault()
    const caret = caretAt.current ?? el.current?.selectionStart ?? 0
    const seg = Math.min(segmentAt(shown, caret), allDay ? 1 : 3)
    const d = stepWhen((draft !== null && parseWhen(draft, date)) || date, seg, e.key === 'ArrowUp' ? 1 : -1)
    setDraft(null)
    onCommit(d)
    caretAt.current = Math.min(caret, fmtWhen(d, allDay).length)
  }
  return (
    <label className="when-f" data-bad={bad}>
      <small>{label}</small>
      <input ref={el} value={draft ?? shown} aria-label={`${label} 날짜·시각`} spellCheck={false} autoComplete="off"
        onChange={(e) => ((caretAt.current = null), setDraft(e.target.value))} onBlur={() => ((caretAt.current = null), commit())} onMouseDown={() => (caretAt.current = null)} onKeyDown={key} onFocus={(e) => e.currentTarget.select()} />
      <i>{weekday(date)}</i>
    </label>
  )
}

/** 작은 달력: 첫 클릭 = 시작 날, 두 번째 = 끝 날 (시각은 그대로) */
function MiniCal({ value, onChange }: { value: When; onChange: (w: When) => void }) {
  const [month, setMonth] = useState(() => new Date(value.start.getFullYear(), value.start.getMonth(), 1))
  const [picking, setPicking] = useState<'start' | 'end'>('start')
  const today = dayKey(new Date())
  const first = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay())
  const days = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i))
  const [s, e] = [dayKey(value.start), dayKey(value.end)]
  const on = (d: Date, t: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.getHours(), t.getMinutes())
  const pick = (d: Date) => {
    if (picking === 'start') return onChange(moveStart(value, on(d, value.start))), setPicking('end')
    onChange(setEnd(value, on(d, value.end)))
    setPicking('start')
  }
  return (
    <div className="dr" aria-label="달력에서 고르기">
      <div className="dr-head">
        <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="이전 달">‹</button>
        <b>{month.getFullYear()}년 {month.getMonth() + 1}월</b>
        <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="다음 달">›</button>
      </div>
      <div className="dr-grid">
        {'일월화수목금토'.split('').map((d, i) => <span key={d} className="dr-dow" data-w={i}>{d}</span>)}
        {days.map((d) => {
          const k = dayKey(d)
          return (
            <button type="button" key={k} className="dr-d" data-k={k} data-out={d.getMonth() !== month.getMonth()} data-today={k === today} data-w={d.getDay()}
              data-in={k >= s && k <= e} data-edge={k === s || k === e} onClick={() => pick(d)}>
              {d.getDate()}
            </button>
          )
        })}
      </div>
      <span className="dr-hint">{picking === 'end' ? '끝 날짜를 고르세요 (같은 날 = 하루)' : '시작 날짜를 고르세요'}</span>
    </div>
  )
}

export function WhenFields({ value, onChange }: { value: When; onChange: (w: When) => void }) {
  const [cal, setCal] = useState(true) // (a9) 달력은 처음부터 펼쳐 둔다 — '달력' 칩으로 접기
  const [s, e] = [dayKey(value.start), dayKey(value.end)]
  const is = (k: 'today' | 'tomorrow' | 'weekend') => {
    const c = chip(value, k)
    return dayKey(c.start) === s && dayKey(c.end) === e && (k !== 'weekend' || value.allDay)
  }
  return (
    <div className="when" role="group" aria-label="기간">
      <div className="when-row">
        <TimeField label="시작" date={value.start} allDay={value.allDay} onCommit={(d) => onChange(moveStart(value, d))} />
        <span className="when-to" aria-hidden>→</span>
        <TimeField label="끝" date={value.end} allDay={value.allDay} onCommit={(d) => onChange(setEnd(value, d))} />
      </div>
      {/* (a7) 토큰 칩: 날짜 셋 = 하나만(늘어나는 알약이 옮겨 감) · 종일 = 토글 · 달력 = 아이콘 칩 */}
      <div className="when-chips">
        <div className="when-pick">
          {([['today', '오늘'], ['tomorrow', '내일'], ['weekend', '이번 주말']] as const).map(([k, l]) => (
            <button type="button" key={k} className="dr-chip" aria-pressed={is(k)} onClick={() => onChange(chip(value, k))}>{l}</button>
          ))}
        </div>
        <button type="button" className="dr-chip" aria-pressed={value.allDay} data-allday onClick={() => onChange({ ...value, allDay: !value.allDay })}>종일</button>
        <span className="grow" />
        <button type="button" className="dr-chip" aria-expanded={cal} data-cal onClick={() => setCal((c) => !c)}><Ico k="calendar" />달력</button>
      </div>
      {cal && <MiniCal value={value} onChange={onChange} />}
    </div>
  )
}
