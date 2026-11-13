import { useEffect, useMemo, useRef, useState } from 'react'
import type { LpRecord, Notification, RunningSession, ShelfFile } from '../data/types'
import {
  activate, closePalette, closePanelWindow, isTauri, launch, lnkTarget, onAlarm, onEvent, onStore, panelOpen, sendAlert, setTurntable, startApps, titleOf, togglePanel,
  useItems, useValue, watchState, type AlertMsg, type Fg,
} from '../data/api'
import { COVERS, seedEvents, seedRecords, seedShelf, seedTodos } from '../data/mock'
import { SHELF_MAX } from '../surfaces/Shelf'
import { Dock } from '../surfaces/Dock'
import { Island, type NextItem } from '../surfaces/Island'
import { Panel, type Tab } from '../surfaces/Panel'
import { Turntable } from '../surfaces/Turntable'
import { Palette } from '../surfaces/Palette'

// 포그라운드 앱 이름: 창 제목의 마지막 " - " 조각(대부분 앱 이름), 없으면 exe 이름
const appName = (f: Fg) => (f.title.includes(' - ') ? f.title.split(' - ').pop()! : f.title) || titleOf(f.exePath)
const matches = (r: LpRecord, keys: Set<string>) => r.kind === 'single' && keys.has((r.exe ?? r.target).toLowerCase())
const hm = (t: string | number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
const key = (r: LpRecord) => (r.exe ?? r.target).toLowerCase()
const fgKeys = (f: Fg) => new Set([f.exePath.toLowerCase(), f.aumid && `shell:appsfolder\\${f.aumid}`.toLowerCase()])

// surface=all: 가짜 바탕화면 + 모든 표면 + 데모 컨트롤. 그 외: 해당 표면만 (Tauri 창 1개 = 표면 1개).
export function Desktop({ only }: { only?: string }) {
  const show = (s: string) => !only || only === s
  const [theme, setTheme] = useState(document.documentElement.dataset.theme)
  const [records, setRecords] = useItems<LpRecord>('record', seedRecords)
  const [pinned, setPinned] = useValue<string[]>('dock.pinned', seedRecords.map((r) => r.id))
  const [todos, setTodos] = useItems('todo', seedTodos)
  const [events, setEvents] = useItems('event', seedEvents)
  const dockRecords = pinned.map((id) => records.find((r) => r.id === id)).filter((r): r is LpRecord => !!r)

  const addRecord = async (target: string, title = titleOf(target)) => {
    const id = crypto.randomUUID()
    // .lnk 는 대상 exe 를 한 번 풀어 둔다 (실행 집합은 exe 경로라서)
    const exe = isTauri && /\.lnk$/i.test(target) ? await lnkTarget(target).catch(() => undefined) : undefined
    setRecords((rs) => [...rs, { id, title, target, exe, kind: 'single', cover: COVERS[rs.length % COVERS.length], glyph: 'text' }])
    setPinned((p) => [...p, id])
  }
  const removeRecord = (id: string) => {
    setRecords((rs) => rs.filter((r) => r.id !== id))
    setPinned((p) => p.filter((x) => x !== id))
  }
  const togglePin = (id: string) => setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  // C2: 세트 = 기존 단일 레코드 묶음 (독에는 고정하지 않음 — 턴테이블 서랍·팔레트에서 쓴다)
  const addSet = (title: string, targets: string[]) =>
    setRecords((rs) => [...rs, { id: crypto.randomUUID(), title, target: '', kind: 'set', targets, cover: COVERS[rs.length % COVERS.length], glyph: 'set' }])

  // C4 파일 선반 (shelf:<id>)
  const [shelf, setShelf] = useItems<ShelfFile>('shelf', seedShelf)
  const shelve = (paths: string[]) =>
    setShelf((fs) => [...fs.filter((f) => !paths.includes(f.path)), ...paths.map((path, i) => ({ id: crypto.randomUUID(), path, at: Date.now() + i }))].sort((a, b) => a.at - b.at).slice(-SHELF_MAX))
  const dropFiles = (paths: string[], toShelf: boolean) => {
    const apps = toShelf ? [] : paths.filter((p) => /\.(exe|lnk)$/i.test(p))
    apps.forEach((p) => addRecord(p))
    const rest = paths.filter((p) => !apps.includes(p))
    if (rest.length) shelve(rest)
  }

  const [running, setRunning] = useState<Set<string>>(() => new Set())
  const [playing, setPlaying] = useState<RunningSession | null>(null)
  // 알림 큐: 앞에서부터 1개씩 표시 (전체화면 뒤 밀린 알림·여러 건 동시 발화)
  const [alerts, setAlerts] = useState<Notification[]>([])
  const alert = alerts[0] ?? null
  const pushAlert = (a: Omit<Notification, 'id'>) => setAlerts((q) => (a.key && q.some((x) => x.key === a.key) ? q : [...q, { id: crypto.randomUUID(), ...a }]))
  const [peek, setPeek] = useState(false)
  const peekTimer = useRef(0)
  const showAlert = (a: AlertMsg) => (isTauri ? void sendAlert(a) : pushAlert(a))

  // B3 (Tauri): 실행 집합(2s) · 포그라운드(30Hz 변화 시) — watch 루프 이벤트. 늦게 뜬 창은 watch_state 로 즉시 동기화.
  const [runKeys, setRunKeys] = useState<Set<string>>(() => new Set())
  const [fg, setFg] = useState<{ key: string; f: Fg; since: number } | null>(null)
  const [remoteOpen, setRemoteOpen] = useState(false)
  useEffect(() => {
    if (!isTauri) return
    const onFg = (f: Fg) => setFg((cur) => (cur?.key === (f.aumid || f.exePath) ? cur : { key: f.aumid || f.exePath, f, since: Date.now() }))
    const onRun = (keys: string[]) => setRunKeys(new Set(keys))
    void watchState().then(([f, keys]) => (f && onFg(f), onRun(keys)))
    void panelOpen().then(setRemoteOpen)
    const offs = [
      onEvent('foreground', onFg),
      onEvent('running', onRun),
      onEvent<boolean>('panel-state', setRemoteOpen),
      onEvent<AlertMsg>('hera-alert', pushAlert),
    ]
    if (only === 'island')
      offs.push(
        onAlarm((a) => pushAlert({ key: a.key, title: a.title, body: `${a.key.startsWith('event:') ? '일정 시작' : '마감 시각이 되었어요'} · ${hm(a.at)}` })),
        // island 창: 다른 창(패널)에서 할 일/일정이 '추가'되면 미리보기를 잠깐 펼친다 (패널의 onAdded 는 패널 창 안에서만 돈다)
        onStore((k, v) => {
          const m = /^(todo|event):(.+)$/.exec(k)
          if (m && v !== undefined && !knownIds.current.has(m[2])) peekIsland()
        }),
      )
    return () => offs.forEach((off) => off())
  }, [])
  const fgRec = fg ? records.find((r) => matches(r, fgKeys(fg.f))) : undefined
  // 살아 있는 레코드 id: 단일 = 실행 집합에 대상이 있음, 세트 = 멤버 중 하나라도 (독 실행 점·턴테이블 회전 공용)
  const aliveIds = useMemo(() => {
    const ids = new Set(records.filter((r) => matches(r, runKeys)).map((r) => r.id))
    for (const r of records) if (r.kind === 'set' && r.targets?.some((id) => ids.has(id))) ids.add(r.id)
    return ids
  }, [records, runKeys])
  const members = (r: LpRecord) => (r.kind === 'set' ? (r.targets ?? []).map((id) => records.find((x) => x.id === id)).filter((x): x is LpRecord => !!x) : [r])

  // C1: 독 우클릭 → 턴테이블에 올리기. 턴테이블 창은 URL ?play= 또는 'tt-play' 이벤트로 받는다.
  const [cue, setCue] = useState(() => {
    const id = new URLSearchParams(location.search).get('play')
    return id ? { id, n: 1 } : null
  })
  useEffect(() => (isTauri && only === 'turntable' ? onEvent<string>('tt-play', (id) => setCue((c) => ({ id, n: (c?.n ?? 0) + 1 }))) : undefined), [])
  const cueRec = cue && records.find((r) => r.id === cue.id)
  const onCue = (r: LpRecord) => (isTauri ? void setTurntable(true, r.id) : setCue((c) => ({ id: r.id, n: (c?.n ?? 0) + 1 })))

  // C3: 팔레트 창은 숨김 상주. 열릴 때('palette-open') 입력 포커스 + 시작 메뉴 앱(첫 열기 때 1회, Rust 캐시 ~1s),
  // 닫을 때 다시 마운트해 검색어를 비운다 (다음 열기에 이전 내용이 비치지 않게).
  const [apps, setApps] = useState<[string, string][]>([])
  const [palN, setPalN] = useState(0)
  useEffect(() => {
    if (!isTauri || only !== 'palette') return
    let loaded = false
    return onEvent('palette-open', () => {
      document.querySelector<HTMLInputElement>('.palette-input input')?.focus()
      // 실패(타임아웃 등)하면 다음 열기에 다시 시도
      if (!loaded) (loaded = true), void startApps().then(setApps, (e) => ((loaded = false), console.error('start_apps', e)))
    })
  }, [])

  const [panel, setPanel] = useState<{ open: boolean; tab: Tab } | null>(only === 'panel' ? { open: true, tab: (new URLSearchParams(location.search).get('tab') as Tab) ?? 'todo' } : null)
  const [palette, setPalette] = useState(only === 'palette')

  useEffect(() => {
    if (isTauri) return // 실제 앱은 전역 단축키(Ctrl+Alt+K, Rust)
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

  // C2: 세트는 순서대로 실행 (앞 앱의 실행 요청이 끝난 뒤 다음)
  const run = async (r: LpRecord) => {
    if (!isTauri) {
      setRunning((s) => new Set([...s, ...ids(r)]))
      setPlaying({ recordId: r.id, title: r.title, startedAt: Date.now() })
    }
    for (const m of members(r)) await launch(m.target).catch((e) => showAlert({ title: `${m.title} 실행 실패`, body: String(e) }))
  }
  const stop = (r: LpRecord) => setRunning((s) => new Set([...s].filter((id) => !ids(r).includes(id))))

  // Tauri: 패널은 별도 창 (dock/island 에서 열면 Rust 가 지연 생성/닫기 요청)
  const remotePanel = isTauri && only !== 'panel'
  const openPanel = (tab: Tab) => (remotePanel ? void togglePanel(tab) : setPanel({ open: true, tab }))
  const closePanel = () => (remotePanel ? void togglePanel('todo') : setPanel((p) => p && { ...p, open: false }))
  const panelClosed = () => (isTauri && only === 'panel' ? void closePanelWindow() : setPanel(null))
  useEffect(() => (isTauri && only === 'panel' ? onEvent('panel-close', closePanel) : undefined), [])

  const knownIds = useRef(new Set<string>())
  knownIds.current = new Set([...todos, ...events].map((x) => x.id))
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
    pushAlert(t ? { title: t.title, body: t.due ? `마감 시각이 되었어요 · ${hm(t.due)}` : '할 일을 확인할 시간이에요', key: `todo:${t.id}` } : { title: '디자인 리뷰 10분 전', body: '회의실 B · 16:00' })
  }
  const switchApp = () => {
    const singles = records.filter((r) => r.kind === 'single')
    const i = singles.findIndex((r) => r.id === playing?.recordId)
    const r = singles[(i + 1) % singles.length]
    if (!r) return
    setPlaying({ recordId: r.id, title: r.title, startedAt: Date.now() - (3 + Math.floor(Math.random() * 18)) * 60_000 })
  }
  // 완료 = 할 일 done (일정은 닫기만 — 발화 집합이 재발화를 막는다). 다시 알림 = snooze 를 지금 +10분으로.
  const ack = (patch: (x: { id: string }) => object) => {
    const [kind, id] = alert?.key?.split(/:(.*)/) ?? []
    const f = <T extends { id: string }>(all: T[]) => all.map((x) => (x.id === id ? { ...x, ...patch(x) } : x))
    if (kind === 'todo') setTodos(f)
    if (kind === 'event') setEvents(f)
    setAlerts((q) => q.slice(1))
  }
  const done = () => ack((x) => ('done' in x ? { done: true } : {}))
  const snooze = () => ack(() => ({ snooze: new Date(Date.now() + 600_000).toISOString() }))

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

      {show('turntable') && (
        <Turntable
          records={records}
          onPlay={run}
          onStop={stop}
          cue={cueRec ? { rec: cueRec, n: cue!.n } : null}
          alive={isTauri ? aliveIds : undefined}
          onActivate={isTauri ? (r) => void activate(members(r).map(key)).catch(() => {}) : undefined}
          onHide={isTauri ? () => void setTurntable(false) : undefined}
        />
      )}
      {show('island') && (
        <Island
          alert={alert}
          next={next}
          playing={isTauri ? fg && { recordId: fgRec?.id ?? '', title: fgRec?.title ?? appName(fg.f), startedAt: fg.since } : playing}
          playingRec={
            isTauri
              ? fg ? fgRec ?? { id: 'fg', title: appName(fg.f), target: fg.f.aumid ? `shell:AppsFolder\\${fg.f.aumid}` : fg.f.exePath, kind: 'single', cover: '#64748B', glyph: 'text' } : undefined
              : records.find((r) => r.id === playing?.recordId)
          }
          peek={peek}
          onDone={done}
          onSnooze={snooze}
          onOpen={() => openPanel('todo')}
        />
      )}
      {show('dock') && (
        <Dock
          records={dockRecords}
          running={isTauri ? aliveIds : running}
          panelOpen={remotePanel ? remoteOpen : !!panel?.open}
          onLaunch={run}
          onPanel={() => (remotePanel || panel?.open ? closePanel() : openPanel('library'))}
          onDropFiles={dropFiles}
          onCue={onCue}
          shelf={shelf}
          onShelfOpen={(f) => void launch(f.path).catch((e) => showAlert({ title: '파일을 열 수 없어요', body: String(e) }))}
          onShelfRemove={(f) => setShelf((fs) => fs.filter((x) => x.id !== f.id))}
        />
      )}
      {panel && show('panel') && (
        <Panel
          open={panel.open}
          tab={panel.tab}
          onTab={(tab) => setPanel({ open: true, tab })}
          onClose={closePanel}
          onClosed={panelClosed}
          onAdded={peekIsland}
          todos={todos}
          setTodos={setTodos}
          events={events}
          setEvents={setEvents}
          records={records}
          pinned={pinned}
          onAddRecord={addRecord}
          onRemoveRecord={removeRecord}
          onTogglePin={togglePin}
          onAddSet={addSet}
        />
      )}
      {palette && show('palette') && (
        <Palette
          key={palN}
          records={records}
          todos={todos}
          apps={apps}
          onRun={run}
          onLaunch={(t) => void launch(t).catch((e) => showAlert({ title: '실행 실패', body: String(e) }))}
          onOpenTodo={() => (isTauri ? void panelOpen().then((o) => o || togglePanel('todo')) : openPanel('todo'))}
          onClose={(restore) => (isTauri ? (void closePalette(restore), setPalN((n) => n + 1)) : setPalette(false))}
        />
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
