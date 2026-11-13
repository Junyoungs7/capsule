import { useEffect, useRef, useState } from 'react'
import type { LpRecord, Notification, RunningSession } from '../data/types'
import { launch, load, save } from '../data/api'
import { seedEvents, seedRecords, seedTodos } from '../data/mock'
import { Dock } from '../surfaces/Dock'
import { Island, type NextItem } from '../surfaces/Island'
import { Panel, type Tab } from '../surfaces/Panel'
import { Turntable } from '../surfaces/Turntable'
import { Palette } from '../surfaces/Palette'

// surface=all: 가짜 바탕화면 + 모든 표면 + 데모 컨트롤. 그 외: 해당 표면만 (Tauri 창 1개 = 표면 1개).
export function Desktop({ only }: { only?: string }) {
  const show = (s: string) => !only || only === s
  const [theme, setTheme] = useState(document.documentElement.dataset.theme)
  const [records, setRecords] = useState(() => load('records', seedRecords))
  const [todos, setTodos] = useState(() => load('todos', seedTodos))
  const [events, setEvents] = useState(() => load('events', seedEvents))
  useEffect(() => save('records', records), [records])
  useEffect(() => save('todos', todos), [todos])
  useEffect(() => save('events', events), [events])

  const [running, setRunning] = useState<Set<string>>(() => new Set())
  const [playing, setPlaying] = useState<RunningSession | null>(null)
  const [alert, setAlert] = useState<Notification | null>(null)
  const [peek, setPeek] = useState(false)
  const peekTimer = useRef(0)
  const [panel, setPanel] = useState<{ open: boolean; tab: Tab } | null>(only === 'panel' ? { open: true, tab: 'todo' } : null)
  const [palette, setPalette] = useState(only === 'palette')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((p) => !p)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleTheme = () => {
    const t = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = t
    setTheme(t)
  }

  const ids = (r: LpRecord) => (r.kind === 'set' ? r.targets ?? [] : [r.id])

  const run = (r: LpRecord) => {
    for (const id of ids(r)) launch(records.find((x) => x.id === id)?.target ?? id)
    setRunning((s) => new Set([...s, ...ids(r)]))
    setPlaying({ recordId: r.id, title: r.title, startedAt: Date.now() })
  }
  const stop = (r: LpRecord) => setRunning((s) => new Set([...s].filter((id) => !ids(r).includes(id))))

  const openPanel = (tab: Tab) => setPanel({ open: true, tab })
  const closePanel = () => setPanel((p) => p && { ...p, open: false })

  const peekIsland = () => {
    setPeek(true)
    clearTimeout(peekTimer.current)
    peekTimer.current = window.setTimeout(() => setPeek(false), 3500)
  }

  // 다음 항목: 앞으로 올 일정/마감 할 일 중 가장 이른 것, 없으면 기한 없는 할 일
  const now = new Date().toISOString()
  const upcoming: NextItem[] = [
    ...events.filter((e) => e.start > now).map((e) => ({ title: e.title, at: e.start, kind: 'event' as const })),
    ...todos.filter((t) => !t.done && t.due && t.due > now).map((t) => ({ title: t.title, at: t.due, kind: 'todo' as const })),
  ].sort((a, b) => a.at!.localeCompare(b.at!))
  const loose = todos.find((t) => !t.done && !t.due)
  const next: NextItem | null = upcoming[0] ?? (loose ? { title: loose.title, kind: 'todo' } : null)

  // 데모 컨트롤
  const fireAlert = () => {
    const t = todos.find((x) => !x.done)
    setAlert(
      t
        ? { id: crypto.randomUUID(), title: t.title, body: t.due ? `마감 시각이 되었어요 · ${new Date(t.due).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}` : '할 일을 확인할 시간이에요', todoId: t.id }
        : { id: crypto.randomUUID(), title: '디자인 리뷰 10분 전', body: '회의실 B · 16:00' },
    )
  }
  const switchApp = () => {
    const singles = records.filter((r) => r.kind === 'single')
    const i = singles.findIndex((r) => r.id === playing?.recordId)
    const r = singles[(i + 1) % singles.length]
    if (!r) return
    setPlaying({ recordId: r.id, title: r.title, startedAt: Date.now() - (3 + Math.floor(Math.random() * 18)) * 60_000 })
  }
  const done = () => {
    if (alert?.todoId) setTodos((all) => all.map((t) => (t.id === alert.todoId ? { ...t, done: true } : t)))
    setAlert(null)
  }
  const snooze = () => {
    if (alert?.todoId) setTodos((all) => all.map((t) => (t.id === alert.todoId ? { ...t, due: new Date(Date.now() + 600_000).toISOString() } : t)))
    setAlert(null)
  }

  return (
    <div className="desktop" data-only={only ?? 'all'}>
      {!only && (
        <>
          <div className="wallpaper" aria-hidden />
          <aside className="demo glass-card" aria-label="데모 컨트롤">
            <header>
              <b>Hera</b>
              <small>시안 A · 인터랙티브 목업</small>
            </header>
            <div className="demo-btns">
              <button onClick={fireAlert}>알림 발생</button>
              <button onClick={switchApp}>앱 전환</button>
              <button onClick={() => (panel?.open ? closePanel() : openPanel('todo'))}>패널</button>
              <button onClick={() => setPalette(true)}>검색 <kbd>Ctrl K</kbd></button>
              <button onClick={toggleTheme} aria-label="테마 전환">{theme === 'dark' ? '라이트' : '다크'} 모드</button>
            </div>
            <p>하단 가운데 점에 마우스를 올리면 독이 펼쳐져요.</p>
          </aside>
          <Taskbar />
        </>
      )}

      {show('turntable') && <Turntable records={records} onPlay={run} onStop={stop} />}
      {show('island') && (
        <Island
          alert={alert}
          next={next}
          playing={playing}
          playingRec={records.find((r) => r.id === playing?.recordId)}
          peek={peek}
          onDone={done}
          onSnooze={snooze}
          onOpen={() => openPanel('todo')}
        />
      )}
      {show('dock') && <Dock records={records} running={running} panelOpen={!!panel?.open} onLaunch={run} onPanel={() => (panel?.open ? closePanel() : openPanel('library'))} />}
      {panel && show('panel') && (
        <Panel
          open={panel.open}
          tab={panel.tab}
          onTab={(tab) => setPanel({ open: true, tab })}
          onClose={closePanel}
          onClosed={() => setPanel(null)}
          onAdded={peekIsland}
          todos={todos}
          setTodos={setTodos}
          events={events}
          setEvents={setEvents}
          records={records}
          setRecords={setRecords}
        />
      )}
      {palette && show('palette') && (
        <Palette records={records} todos={todos} onRun={run} onOpenTodo={() => openPanel('todo')} onClose={() => setPalette(false)} />
      )}
    </div>
  )
}

// Win11 작업표시줄 자리 표시 (독은 작업 영역 = 이 위에 뜬다)
function Taskbar() {
  return (
    <div className="taskbar" aria-hidden>
      <span className="tb-apps">
        <i className="tb-start" />
        <i className="tb-search" />
        <i /><i /><i /><i />
      </span>
      <span className="tb-tray">{new Date().toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}</span>
    </div>
  )
}
