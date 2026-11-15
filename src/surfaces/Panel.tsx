import { useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import type { AppGroup, CalendarEvent, LpRecord, Todo } from '../data/types'
import { isTauri, startApps } from '../data/api'
import { Tile } from './Dock'
import { fmtWhen } from './Island'
import type { Weather } from './Fx'
import { moonName, moonPhase } from './Ascii'
import { MonthCalendar } from './MonthCalendar'
import { SnippetTab } from './Snippets'

export type Tab = 'todo' | 'calendar' | 'library' | 'snippets' | 'settings'
const TABS: [Tab, string][] = [['todo', '할 일'], ['calendar', '달력'], ['library', '라이브러리'], ['snippets', '상용구'], ['settings', '설정']]

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
  groups: AppGroup[]
  onSaveGroup: (g: AppGroup) => void
  onRemoveGroup: (id: string) => void
  fxOn: boolean
  setFxOn: (on: boolean) => void
  city: string
  setCity: (c: string) => void
  weather: Weather | null // 실제 앱: 받기 전·실패 = null
  idleMin: number
  setIdleMin: (m: number) => void
  onFxNow: () => void
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
        {p.tab === 'calendar' && <MonthCalendar {...p} />}
        {p.tab === 'library' && <LibraryTab {...p} />}
        {p.tab === 'snippets' && <SnippetTab />}
        {p.tab === 'settings' && <SettingsTab {...p} />}
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

function LibraryTab({ records, pinned, onAddRecord, onRemoveRecord, onTogglePin, onAddSet, groups, onSaveGroup, onRemoveGroup }: Props) {
  const [title, setTitle] = useState('')
  const [target, setTarget] = useState('')
  // C2: 세트 만들기 = 단일 레코드를 고른 순서대로 묶기 (그 순서로 실행)
  // v2: 같은 고르기 화면으로 앱 묶음(독 폴더) 만들기·편집 (group = 편집 중인 묶음)
  const [pick, setPick] = useState<string[] | null>(null)
  const [mode, setMode] = useState<{ kind: 'set' | 'group'; group?: AppGroup }>({ kind: 'set' })
  const [setName, setSetName] = useState('')
  const startPick = (kind: 'set' | 'group', group?: AppGroup) => (setMode({ kind, group }), setSetName(group?.title ?? ''), setPick(group ? [...group.recordIds] : []))
  const makeSet = (e: FormEvent) => {
    e.preventDefault()
    if (!pick || pick.length < 2) return
    if (mode.kind === 'group') onSaveGroup({ id: mode.group?.id ?? id(), title: setName.trim() || '묶음', recordIds: pick })
    else onAddSet(setName.trim() || 'LP 세트', pick)
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
          <input autoFocus value={setName} onChange={(e) => setSetName(e.target.value)} placeholder={`${mode.kind === 'group' ? '묶음' : '세트'} 이름 · ${pick.length}개 선택 (2개 이상)`} aria-label={mode.kind === 'group' ? '묶음 이름' : '세트 이름'} />
          <button type="button" className="picker-open" onClick={() => setPick(null)}>취소</button>
          <button className="primary" disabled={pick.length < 2}>{mode.group ? '저장' : '만들기'}</button>
        </form>
      ) : (
        <div className="lib-actions">
          <button className="picker-open" onClick={() => startPick('set')}>LP 세트 만들기…</button>
          <button className="picker-open" onClick={() => startPick('group')}>앱 묶음 만들기…</button>
        </div>
      )}
      {!pick && groups.length > 0 && (
        <ul className="list groups">
          {groups.map((g) => {
            const recs = g.recordIds.map((x) => records.find((r) => r.id === x)).filter((r): r is LpRecord => !!r)
            return (
              <li key={g.id}>
                <span className="tile folder-tile" style={{ width: 34, height: 34 }} aria-hidden>{recs.slice(0, 4).map((r) => <Tile key={r.id} rec={r} size={13} />)}</span>
                <span className="grow">
                  <b>{g.title}</b>
                  <small>앱 묶음 · {recs.map((r) => r.title).join(' · ')}</small>
                </span>
                <button className="icon-btn" onClick={() => startPick('group', g)} aria-label={`${g.title} 묶음 편집`} title="앱 넣고 빼기">✎</button>
                <button className="icon-btn del" onClick={() => onRemoveGroup(g.id)} aria-label={`${g.title} 묶음 삭제`}>×</button>
              </li>
            )
          })}
        </ul>
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
                <input type="checkbox" checked={pick.includes(r.id)} onChange={() => setPick((p) => (p!.includes(r.id) ? p!.filter((x) => x !== r.id) : [...p!, r.id]))} aria-label={`${r.title} ${mode.kind === 'group' ? '묶음' : '세트'}에 넣기`} />
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

// v2 설정: 효과 이벤트 스위치(트레이에도 같은 스위치 — Rust), 도시(날씨), 지금 보기, 아스키 화면보호기 대기 시간
function SettingsTab({ fxOn, setFxOn, city, setCity, weather, idleMin, setIdleMin, onFxNow }: Props) {
  const [draft, setDraft] = useState(city)
  const f = moonPhase(new Date())
  const save = () => draft.trim() && setCity(draft.trim())
  return (
    <div className="settings">
      <h3>날씨 · 계절 효과</h3>
      <label className="row">
        <span className="grow">
          <b>효과 이벤트</b>
          <small>눈·비 시작, 노을, 달 뜰 때 20~30초 동안</small>
        </span>
        <input type="checkbox" className="switch" checked={fxOn} onChange={(e) => setFxOn(e.target.checked)} />
      </label>
      <form className="row" onSubmit={(e) => (e.preventDefault(), save())}>
        <span className="grow">
          <b>도시</b>
          <small>{city} · {weather ? `${weather.text} ${weather.temp}°` : '날씨 정보 없음'} · 달 {moonName(f)}{isTauri ? '' : ' (시안: 가짜 날씨)'}</small>
        </span>
        <input className="city" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save} aria-label="도시 이름" />
      </form>
      <button className="primary now" onClick={onFxNow}>지금 보기</button>
      <h3>아스키 아트</h3>
      <label className="row">
        <span className="grow">
          <b>자리 비움 화면보호기</b>
          <small>입력이 없으면 장면을 전체화면으로 · 0 = 끄기</small>
        </span>
        <input className="mins" type="number" min={0} max={120} value={idleMin} onChange={(e) => setIdleMin(Math.max(0, Number(e.target.value) || 0))} aria-label="대기 시간(분)" />
        <small>분</small>
      </label>
    </div>
  )
}

// 시작 메뉴 앱 목록 (Get-StartApps — Rust 가 1회 실행 후 캐시). 검색해서 추가.
function AppPicker({ onPick }: { onPick: (target: string, title: string) => void }) {
  const [apps, setApps] = useState<[string, string][] | null>(null)
  const [q, setQ] = useState('')
  const [failed, setFailed] = useState(false)
  if (!apps)
    return (
      // 실패하면 버튼을 그대로 두고 다시 누르면 재시도
      <button className="picker-open" onClick={() => void startApps().then(setApps, () => setFailed(true))}>
        {failed ? '불러오지 못했어요 — 다시 시도' : '시작 메뉴에서 앱 추가…'}
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
