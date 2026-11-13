import { useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import type { CalendarEvent, LpRecord, Todo } from '../data/types'
import { isTauri, startApps } from '../data/api'
import { Tile } from './Dock'
import { fmtWhen } from './Island'

export type Tab = 'todo' | 'calendar' | 'library'
const TABS: [Tab, string][] = [['todo', '할 일'], ['calendar', '달력'], ['library', '라이브러리']]

type Props = {
  open: boolean
  tab: Tab
  onTab: (t: Tab) => void
  onClose: () => void
  onClosed: () => void
  onAdded: () => void
  todos: Todo[]
  setTodos: Dispatch<SetStateAction<Todo[]>>
  events: CalendarEvent[]
  setEvents: Dispatch<SetStateAction<CalendarEvent[]>>
  records: LpRecord[]
  pinned: string[]
  onAddRecord: (target: string, title?: string) => void
  onRemoveRecord: (id: string) => void
  onTogglePin: (id: string) => void
  onAddSet: (title: string, ids: string[]) => void
}

// 열기: 마운트 → 강제 reflow → data-open=true (transition). 닫기: data-open=false → transitionend → 언마운트(파괴).
export function Panel(p: Props) {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const el = ref.current!
    el.getBoundingClientRect()
    el.dataset.open = String(p.open)
  }, [p.open])

  return (
    <section
      ref={ref}
      className="panel glass-card"
      aria-label="Hera 패널"
      onTransitionEnd={(e) => e.target === e.currentTarget && e.propertyName === 'opacity' && !p.open && p.onClosed()}
      onKeyDown={(e) => e.key === 'Escape' && p.onClose()}
    >
      <header className="panel-head">
        <div className="tabs" role="tablist" style={{ '--i': TABS.findIndex(([t]) => t === p.tab) } as CSSProperties}>
          <span className="tab-ind" />
          {TABS.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={p.tab === t} onClick={() => p.onTab(t)}>{label}</button>
          ))}
        </div>
        <button className="icon-btn" onClick={p.onClose} aria-label="패널 닫기">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M7 7l10 10M17 7L7 17" /></svg>
        </button>
      </header>
      <div className="panel-body">
        {p.tab === 'todo' && <TodoTab {...p} />}
        {p.tab === 'calendar' && <CalendarTab {...p} />}
        {p.tab === 'library' && <LibraryTab {...p} />}
      </div>
    </section>
  )
}

const id = () => crypto.randomUUID()

function TodoTab({ todos, setTodos, onAdded }: Props) {
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setTodos((t) => [...t, { id: id(), title: title.trim(), due: due ? new Date(due).toISOString() : undefined, done: false, source: 'local' }])
    setTitle('')
    setDue('')
    onAdded()
  }
  const sorted = [...todos].sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? '9').localeCompare(b.due ?? '9'))
  return (
    <>
      <form className="add" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="할 일 추가" aria-label="할 일 제목" />
        <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-label="마감 시각" />
        <button className="primary" aria-label="추가">추가</button>
      </form>
      <ul className="list">
        {sorted.map((t) => (
          <li key={t.id} data-done={t.done}>
            <label className="check">
              <input type="checkbox" checked={t.done} onChange={() => setTodos((all) => all.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))} />
              <span />
            </label>
            <span className="grow">
              <b>{t.title}</b>
              <small>{fmtWhen(t.due)}</small>
            </span>
            <button className="icon-btn del" onClick={() => setTodos((all) => all.filter((x) => x.id !== t.id))} aria-label={`${t.title} 삭제`}>×</button>
          </li>
        ))}
      </ul>
    </>
  )
}

const dayKey = (d: Date) => d.toLocaleDateString('sv') // YYYY-MM-DD (로컬)

function CalendarTab({ events, setEvents, onAdded }: Props) {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [sel, setSel] = useState(() => dayKey(new Date()))
  const [title, setTitle] = useState('')
  const [start, setStart] = useState('')
  const today = dayKey(new Date())

  const first = new Date(month)
  first.setDate(1 - month.getDay())
  const cells = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i))
  const byDay = new Map<string, number>()
  for (const ev of events) byDay.set(dayKey(new Date(ev.start)), (byDay.get(dayKey(new Date(ev.start))) ?? 0) + 1)
  const dayEvents = events.filter((ev) => dayKey(new Date(ev.start)) === sel).sort((a, b) => a.start.localeCompare(b.start))

  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    const s = new Date(start || `${sel}T09:00`)
    setEvents((all) => [...all, { id: id(), title: title.trim(), start: s.toISOString(), end: new Date(s.getTime() + 3_600_000).toISOString(), source: 'local' }])
    setSel(dayKey(s))
    setTitle('')
    setStart('')
    onAdded()
  }
  const shift = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1))

  return (
    <>
      <div className="cal-head">
        <b>{month.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long' })}</b>
        <span>
          <button className="icon-btn" onClick={() => shift(-1)} aria-label="이전 달">‹</button>
          <button className="icon-btn" onClick={() => shift(1)} aria-label="다음 달">›</button>
        </span>
      </div>
      <div className="cal-grid" role="grid">
        {['일', '월', '화', '수', '목', '금', '토'].map((d) => <span key={d} className="dow">{d}</span>)}
        {cells.map((d) => {
          const k = dayKey(d)
          return (
            <button
              key={k}
              className="day"
              data-out={d.getMonth() !== month.getMonth()}
              data-today={k === today}
              aria-selected={k === sel}
              onClick={() => setSel(k)}
            >
              {d.getDate()}
              {byDay.has(k) && <i />}
            </button>
          )
        })}
      </div>
      <form className="add" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${sel.slice(5).replace('-', '/')} 일정 추가`} aria-label="일정 제목" />
        <input type="datetime-local" value={start || `${sel}T09:00`} onChange={(e) => setStart(e.target.value)} aria-label="시작 시각" />
        <button className="primary">추가</button>
      </form>
      <ul className="list">
        {dayEvents.length === 0 && <li className="empty">이 날은 일정이 없어요</li>}
        {dayEvents.map((ev) => (
          <li key={ev.id}>
            <span className="ev-time">{new Date(ev.start).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
            <span className="grow"><b>{ev.title}</b></span>
            <button className="icon-btn del" onClick={() => setEvents((all) => all.filter((x) => x.id !== ev.id))} aria-label={`${ev.title} 삭제`}>×</button>
          </li>
        ))}
      </ul>
    </>
  )
}

function LibraryTab({ records, pinned, onAddRecord, onRemoveRecord, onTogglePin, onAddSet }: Props) {
  const [title, setTitle] = useState('')
  const [target, setTarget] = useState('')
  // C2: 세트 만들기 = 단일 레코드를 고른 순서대로 묶기 (그 순서로 실행)
  const [pick, setPick] = useState<string[] | null>(null)
  const [setName, setSetName] = useState('')
  const makeSet = (e: FormEvent) => {
    e.preventDefault()
    if (!pick || pick.length < 2) return
    onAddSet(setName.trim() || 'LP 세트', pick)
    setPick(null)
    setSetName('')
  }
  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!target.trim()) return
    onAddRecord(target.trim(), title.trim() || undefined)
    setTitle('')
    setTarget('')
  }
  // B0-4: 패널 = HTML5 드롭 (브라우저 주소창/링크 → text/uri-list). 붙여넣기 폼은 폴백.
  const drop = (e: DragEvent) => {
    e.preventDefault()
    const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).split(/\r?\n/).find((l) => /^https?:\/\//i.test(l))
    if (url) onAddRecord(url.trim())
  }
  return (
    <div onDragOver={(e) => e.preventDefault()} onDrop={drop}>
      <form className="add" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="이름 (선택)" aria-label="레코드 이름" />
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="URL 또는 .exe 경로 (URL 을 끌어다 놓아도 돼요)" aria-label="대상" />
        <button className="primary">추가</button>
      </form>
      {isTauri && !pick && <AppPicker onPick={onAddRecord} />}
      {pick ? (
        <form className="add" onSubmit={makeSet}>
          <input autoFocus value={setName} onChange={(e) => setSetName(e.target.value)} placeholder={`세트 이름 · ${pick.length}개 선택 (2개 이상)`} aria-label="세트 이름" />
          <button type="button" className="picker-open" onClick={() => setPick(null)}>취소</button>
          <button className="primary" disabled={pick.length < 2}>만들기</button>
        </form>
      ) : (
        <button className="picker-open" onClick={() => setPick([])}>LP 세트 만들기…</button>
      )}
      <ul className="list">
        {[...records].sort((a, b) => a.title.localeCompare(b.title)).filter((r) => !pick || r.kind === 'single').map((r) => (
          <li key={r.id}>
            <Tile rec={r} size={34} />
            <span className="grow">
              <b>{r.title}</b>
              <small>{r.kind === 'set' ? `LP 세트 · ${r.targets?.map((id) => records.find((x) => x.id === id)?.title).filter(Boolean).join(' · ')}` : r.target}</small>
            </span>
            {pick ? (
              <label className="check">
                <input type="checkbox" checked={pick.includes(r.id)} onChange={() => setPick((p) => (p!.includes(r.id) ? p!.filter((x) => x !== r.id) : [...p!, r.id]))} aria-label={`${r.title} 세트에 넣기`} />
                <span />
              </label>
            ) : (<>
            <button className="icon-btn" onClick={() => onTogglePin(r.id)} aria-pressed={pinned.includes(r.id)} aria-label={`${r.title} 독에 고정`} title="독에 고정">
              {pinned.includes(r.id) ? '★' : '☆'}
            </button>
            <button className="icon-btn del" onClick={() => onRemoveRecord(r.id)} aria-label={`${r.title} 삭제`}>×</button>
            </>)}
          </li>
        ))}
      </ul>
    </div>
  )
}

// 시작 메뉴 앱 목록 (Get-StartApps — Rust 가 1회 실행 후 캐시). 검색해서 추가.
function AppPicker({ onPick }: { onPick: (target: string, title: string) => void }) {
  const [apps, setApps] = useState<[string, string][] | null>(null)
  const [q, setQ] = useState('')
  if (!apps)
    return (
      <button className="picker-open" onClick={() => void startApps().then(setApps, () => setApps([]))}>
        시작 메뉴에서 앱 추가…
      </button>
    )
  const hits = apps.filter(([n]) => n.toLowerCase().includes(q.toLowerCase())).slice(0, 30)
  return (
    <div className="picker">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`앱 검색 (${apps.length}개)`} aria-label="앱 검색" />
      <ul className="list">
        {hits.map(([name, target]) => (
          <li key={target}>
            <span className="grow"><b>{name}</b></span>
            <button className="icon-btn" onClick={() => onPick(target, name)} aria-label={`${name} 추가`}>＋</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
