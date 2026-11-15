import { useState, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import type { CalendarEvent, Todo } from '../data/types'
import { dayKey, isHoliday, lunarOf } from '../data/holidays'

/* v3 패널 달력: 주/월 전환. 일요일·공휴일 빨강, 토요일 파랑, 공휴일 이름, 작은 음력 날짜, 일정·할 일 점, 오늘 링.
   달(주) 넘기기 = 새 격자가 스프링으로 밀려 들어오고 이전 격자는 반대로 빠진다. */
type Props = {
  events: CalendarEvent[]
  setEvents: Dispatch<SetStateAction<CalendarEvent[]>>
  todos: Todo[]
  onAdded: () => void
}
type Mode = 'week' | 'month'

const DOW = ['일', '월', '화', '수', '목', '금', '토']
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const weekStart = (d: Date) => addDays(d, -d.getDay())
const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)
const anchorOf = (m: Mode, d: Date) => (m === 'month' ? monthStart(d) : weekStart(d))
const hm = (t: string) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
const lunarText = (d: Date) => {
  const l = lunarOf(d)
  return l ? (l[1] === 1 ? `${l[0]}.1` : String(l[1])) : ''
}

export function MonthCalendar({ events, setEvents, todos, onAdded }: Props) {
  const [mode, setMode] = useState<Mode>('month')
  const [sel, setSel] = useState(() => dayKey(new Date()))
  const [anchor, setAnchor] = useState(() => monthStart(new Date()))
  const [out, setOut] = useState<{ anchor: Date; mode: Mode; dir: number } | null>(null) // 빠지는 중인 이전 격자
  const [dir, setDir] = useState(0)
  const [title, setTitle] = useState('')
  const today = dayKey(new Date())

  const go = (next: Date, m = mode) => {
    if (next.getTime() === anchor.getTime() && m === mode) return
    const d = next > anchor ? 1 : -1
    setOut({ anchor, mode, dir: d })
    setDir(d)
    setAnchor(next)
    setMode(m)
  }
  const shift = (n: number) => go(mode === 'month' ? new Date(anchor.getFullYear(), anchor.getMonth() + n, 1) : addDays(anchor, 7 * n))
  const selDate = new Date(sel + 'T00:00')
  const pick = (d: Date) => {
    setSel(dayKey(d))
    if (mode === 'month' && d.getMonth() !== anchor.getMonth()) go(monthStart(d))
  }

  // 날짜별 일정·마감 할 일
  const evBy = new Map<string, CalendarEvent[]>()
  for (const ev of events) {
    const k = dayKey(new Date(ev.start))
    evBy.set(k, [...(evBy.get(k) ?? []), ev])
  }
  const todoBy = new Set(todos.filter((t) => t.due && !t.done).map((t) => dayKey(new Date(t.due!))))

  const grid = (a: Date, m: Mode) => {
    const first = m === 'month' ? weekStart(a) : a
    const days = Array.from({ length: m === 'month' ? 42 : 7 }, (_, i) => addDays(first, i))
    return days.map((d) => {
      const k = dayKey(d), hol = isHoliday(d), evs = evBy.get(k) ?? []
      return (
        <button
          key={k}
          className="mc-day"
          data-out={m === 'month' && d.getMonth() !== a.getMonth()}
          data-today={k === today}
          data-red={d.getDay() === 0 || !!hol}
          data-blue={d.getDay() === 6 && !hol}
          aria-selected={k === sel}
          aria-label={`${d.getMonth() + 1}월 ${d.getDate()}일${hol ? ' ' + hol : ''}`}
          title={hol ?? (lunarOf(d) ? `음력 ${lunarOf(d)!.join('.')}` : undefined)}
          onClick={() => pick(d)}
        >
          <b>{d.getDate()}</b>
          {m === 'month' ? <small className={hol ? 'mc-hol' : 'mc-lunar'}>{hol ? hol.replace(/^대체공휴일\((.+)\)$/, '대체($1)') : lunarText(d)}</small> : <small className="mc-lunar">음 {lunarOf(d)?.join('.') ?? ''}</small>}
          {m === 'week' && hol && <small className="mc-hol">{hol}</small>}
          {m === 'week' && evs.slice(0, 3).map((ev) => <span key={ev.id} className="mc-chip">{hm(ev.start)} {ev.title}</span>)}
          {(evs.length > 0 || todoBy.has(k)) && m === 'month' && (
            <span className="mc-dots">{evs.length > 0 && <i />}{todoBy.has(k) && <i className="todo" />}</span>
          )}
        </button>
      )
    })
  }
  const label = (a: Date, m: Mode) =>
    m === 'month' ? `${a.getFullYear()}년 ${a.getMonth() + 1}월` : `${a.getMonth() + 1}월 ${Math.ceil((a.getDate() + monthStart(a).getDay()) / 7)}주`
  const sheet = (a: Date, m: Mode, cls: string, d: number) => (
    <div key={m + dayKey(a)} className={`mc-sheet ${cls}`} data-mode={m} style={{ '--d': d } as React.CSSProperties} onAnimationEnd={cls === 'out' ? () => setOut(null) : undefined}>
      {DOW.map((x, i) => <span key={x} className="mc-dow" data-red={i === 0} data-blue={i === 6}>{x}</span>)}
      {grid(a, m)}
    </div>
  )

  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    const s = new Date(`${sel}T09:00`)
    setEvents((all) => [...all, { id: crypto.randomUUID(), title: title.trim(), start: s.toISOString(), end: new Date(s.getTime() + 3_600_000).toISOString(), source: 'local' }])
    setTitle('')
    onAdded()
  }

  const hol = isHoliday(selDate)
  const lun = lunarOf(selDate)
  const dayEvents = (evBy.get(sel) ?? []).sort((a, b) => a.start.localeCompare(b.start))
  const dayTodos = todos.filter((t) => t.due && dayKey(new Date(t.due)) === sel)

  return (
    <div className="mc">
      <div className="mc-head">
        <div className="mc-seg" role="group" aria-label="보기">
          {(['week', 'month'] as const).map((m) => (
            <button key={m} aria-pressed={mode === m} onClick={() => go(anchorOf(m, selDate), m)}>{m === 'week' ? '주' : '월'}</button>
          ))}
        </div>
        <b>{label(anchor, mode)}</b>
        <span>
          <button className="icon-btn" onClick={() => shift(-1)} aria-label={mode === 'month' ? '이전 달' : '이전 주'}>‹</button>
          <button className="mc-today" onClick={() => (setSel(today), go(anchorOf(mode, new Date())))}>오늘</button>
          <button className="icon-btn" onClick={() => shift(1)} aria-label={mode === 'month' ? '다음 달' : '다음 주'}>›</button>
        </span>
      </div>
      <div className="mc-stage" role="grid">
        {out && sheet(out.anchor, out.mode, 'out', out.dir)}
        {sheet(anchor, mode, out ? 'in' : 'still', dir)}
      </div>
      <div className="mc-daybar">
        <b>{selDate.getMonth() + 1}월 {selDate.getDate()}일 {DOW[selDate.getDay()]}요일</b>
        {lun && <small>음력 {lun[0]}월 {lun[1]}일</small>}
        {hol && <small className="mc-hol">{hol}</small>}
      </div>
      <form className="add mc-add" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${sel.slice(5).replace('-', '/')} 일정 추가 (09:00)`} aria-label="일정 제목" />
        <button className="primary">추가</button>
      </form>
      <ul className="list">
        {dayEvents.length + dayTodos.length === 0 && <li className="empty">{hol ? '쉬는 날이에요' : '이 날은 일정이 없어요'}</li>}
        {dayEvents.map((ev) => (
          <li key={ev.id}>
            <span className="ev-time">{hm(ev.start)}</span>
            <span className="grow"><b>{ev.title}</b></span>
            <button className="icon-btn del" onClick={() => setEvents((all) => all.filter((x) => x.id !== ev.id))} aria-label={`${ev.title} 삭제`}>×</button>
          </li>
        ))}
        {dayTodos.map((t) => (
          <li key={t.id} data-done={t.done}>
            <span className="ev-time todo">{hm(t.due!)}</span>
            <span className="grow"><b>{t.title}</b><small>할 일 마감</small></span>
          </li>
        ))}
      </ul>
    </div>
  )
}
