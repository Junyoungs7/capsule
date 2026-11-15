import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppGroup, Clip, LpRecord, Notification, RunningSession, ShelfFile } from '../data/types'
import {
  clipList, closePalette, closePanelWindow, closeSelf, isTauri, launch, lnkTarget, onAlarm, onEvent, onStore, openAscii, openFx, panelOpen, sendAlert, setClip,
  shellKey, startApps, titleOf, togglePanel, useItems, useValue, watchState, windowsList, winClick, winClose, type AlertMsg, type Fg, type Win,
} from '../data/api'
import { COVERS, seedClips, seedEvents, seedGroups, seedRecords, seedShelf, seedTodos } from '../data/mock'
import { SHELF_MAX } from '../surfaces/Shelf'
import { Dock } from '../surfaces/Dock'
import { Island, type NextItem, type TeamNews } from '../surfaces/Island'
import { TeamDemo } from '../surfaces/Team'
import { Panel, type Tab } from '../surfaces/Panel'
import { Palette } from '../surfaces/Palette'
import { AsciiFull, pickScene, seasonOf } from '../surfaces/Ascii'
import { V3Demo, V3Layer } from '../surfaces/Notes'
import { GlassDefs } from '../surfaces/GlassDefs'
import { FX_LABEL, Fx, fakeWeather, fetchWeather, geocode, pickFx, type FxKind, type Weather } from '../surfaces/Fx'

// 포그라운드 앱 이름: 창 제목의 마지막 " - " 조각(대부분 앱 이름), 없으면 exe 이름
const appName = (f: Fg) => (f.title.includes(' - ') ? f.title.split(' - ').pop()! : f.title) || titleOf(f.exePath)
const matches = (r: LpRecord, keys: Set<string>) => r.kind === 'single' && keys.has((r.exe ?? r.target).toLowerCase())
const hm = (t: string | number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
const key = (r: LpRecord) => (r.exe ?? r.target).toLowerCase()
// 실행 중 앱 이름: 제목의 마지막 " - " 조각, 패키지 앱은 창 제목(예: 계산기), 그 외 exe 이름
const winName = (w: Win) => (w.title.includes(' - ') ? w.title.split(' - ').pop()! : w.aumid ? w.title : titleOf(w.exe)) || titleOf(w.exe)
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
  // C2: 세트 = 기존 단일 레코드 묶음 (독에는 고정하지 않음 — LP 크레이트·팔레트에서 쓴다)
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

  // v2 앱 묶음 (group:<id>) — 독에는 레코드 뒤에 모두 표시
  const [groups, setGroups] = useItems<AppGroup>('group', seedGroups)
  const saveGroup = (g: AppGroup) => setGroups((gs) => (gs.some((x) => x.id === g.id) ? gs.map((x) => (x.id === g.id ? g : x)) : [...gs, g]))
  const dockGroups = groups.map((group) => ({ group, recs: group.recordIds.map((id) => records.find((r) => r.id === id)).filter((r): r is LpRecord => !!r) }))

  // v2 클립보드 기록: 메모리에만 최근 20개. 실제 앱 = Rust AddClipboardFormatListener → 팔레트 창 'clips' (폴링 없음)
  const [clips, setClips] = useState<Clip[]>(isTauri ? [] : seedClips)
  useEffect(() => {
    if (!isTauri || only !== 'palette') return
    void clipList().then(setClips)
    return onEvent<Clip[]>('clips', setClips)
  }, [])
  const copyClip = (c: Clip) => {
    // 실제 앱: Rust 가 클립보드에 넣으면 리스너가 다시 받아 맨 앞으로 올린다
    if (isTauri) return void setClip(c.text).catch((e) => showAlert({ title: '복사하지 못했어요', body: String(e) }))
    void navigator.clipboard?.writeText(c.text).catch(() => {})
    setClips((cs) => [{ ...c, at: Date.now() }, ...cs.filter((x) => x.id !== c.id)].slice(0, 20))
  }

  // v2 시간·계절 (시안 데모 바에서 바꿔 볼 수 있음) → 아스키 장면·효과 선택
  const [demoNow, setDemoNow] = useState<Date | null>(null)
  const clock = demoNow ?? new Date()
  const scene = pickScene(clock)

  // v2 효과: 스위치·도시는 저장 (스위치는 트레이와 공유, Rust 가 판정). 날씨: 시안 = 가짜, 실제 앱 = 독 창이 30분마다 받아 store 에.
  const [fxOn, setFxOn] = useValue('fx.enabled', true)
  const [city, setCity] = useValue('fx.city', '서울')
  const [liveWeather, setLiveWeather] = useValue<Weather | null>('fx.weather', null)
  const [coords, setCoords] = useValue<[number, number] | null>('fx.coords', null)
  const coordsNow = useRef(coords)
  coordsNow.current = coords
  const [weatherOverride, setWeatherOverride] = useState<Weather | null>(null)
  const weather = weatherOverride ?? (isTauri ? liveWeather : fakeWeather(city))
  useEffect(() => {
    if (!isTauri || only !== 'dock') return
    let live = true, t = 0
    const tick = () => {
      // 실패하면 그대로 둔다 → 효과는 계절·시간대만으로
      // 좌표(일출·일몰 계산용)는 날씨 서버가 막혀도 저장된다 — 바뀌었을 때만 쓴다
      geocode(city)
        .then((c) => (live && String(c) !== String(coordsNow.current) && setCoords(c), fetchWeather(c)))
        .then((w) => live && setLiveWeather(w), (e) => console.warn('weather', e))
      t = window.setTimeout(tick, 30 * 60_000)
    }
    tick()
    return () => ((live = false), clearTimeout(t))
  }, [city])
  const [fx, setFx] = useState<{ kind: FxKind; n: number } | null>(() => {
    const k = new URLSearchParams(location.search).get('fx') as FxKind | null
    return only === 'fx' ? { kind: k && k in FX_LABEL ? k : pickFx(new Date(), fakeWeather('서울')), n: 0 } : null
  })
  const playFx = (kind: FxKind) => (isTauri ? void openFx(kind) : setFx((f) => ({ kind, n: (f?.n ?? 0) + 1 })))
  // 자동 이벤트(날씨 변화·노을·달 뜸·계절 첫날)는 스위치가 켜져 있을 때만. 시안 = 데모 바에서 바꾸면 발생
  const event = (kind: FxKind | null) => kind && fxOn && playFx(kind)

  // v2 아스키 전체화면: from = 위젯 rect(확대 출발점), saver = 자리 비움 화면보호기
  // 실제 앱: 아스키 창(surface=ascii)을 Rust 가 연다 — ?saver=1 화면보호기, ?from=x,y,w,h 위젯 화면 rect
  const [ascii, setAscii] = useState<{ open: boolean; from: DOMRect | null; saver: boolean }>(() => {
    const q = new URLSearchParams(location.search), f = q.get('from')?.split(',').map(Number)
    return { open: only === 'ascii', from: f?.length === 4 ? new DOMRect(f[0], f[1], f[2], f[3]) : null, saver: q.get('saver') === '1' }
  })
  // 화면보호기: watch 루프가 입력(키 포함)을 감지하면 'ascii-close'
  useEffect(() => (isTauri && only === 'ascii' ? onEvent('ascii-close', () => setAscii((a) => ({ ...a, open: false }))) : undefined), [])
  const [idleMin, setIdleMin] = useValue('ascii.idleMin', 10)
  const [idleDemo, setIdleDemo] = useState(false) // 시안: 대기 시간을 5초로
  const idleMs = idleDemo ? 5_000 : idleMin * 60_000
  const asciiOpen = useRef(false)
  asciiOpen.current = ascii.open
  useEffect(() => {
    // 시안: 마지막 입력 시각만 기록 + 타이머 1개(남은 시간만큼 재무장). 실제 앱 = Rust GetLastInputInfo(watch 루프) + 전체화면 앱이면 안 뜸
    if (isTauri || !idleMs || (only && only !== 'ascii')) return
    let last = Date.now(), t = 0
    const mark = () => void (last = Date.now())
    const check = () => {
      const left = idleMs - (Date.now() - last)
      if (left <= 0 && !asciiOpen.current) setAscii({ open: true, from: null, saver: true })
      t = window.setTimeout(check, Math.max(left, 1000))
    }
    const evs = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const
    evs.forEach((e) => addEventListener(e, mark, { passive: true }))
    t = window.setTimeout(check, idleMs)
    return () => (clearTimeout(t), evs.forEach((e) => removeEventListener(e, mark)))
  }, [idleMs])

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
  // 작업 표시줄 대체: 실행 중 앱 창 (독 창만). 독에 고정된 레코드와 같은 앱은 실행 점만, 나머지는 구분선 뒤에 앱별로.
  const [wins, setWins] = useState<Win[]>([])
  useEffect(() => {
    if (!isTauri || only !== 'dock') return
    void windowsList().then(setWins)
    return onEvent<Win[]>('windows', setWins)
  }, [])
  const runApps = useMemo(() => {
    const pinnedKeys = new Set(dockRecords.filter((r) => r.kind === 'single').map(key))
    const m = new Map<string, Win[]>()
    for (const w of wins) if (!w.keys.some((k) => pinnedKeys.has(k))) m.set(w.key, [...(m.get(w.key) ?? []), w])
    return [...m.values()].map((ws) => {
      const w = ws[0]
      const rec: LpRecord = { id: 'run:' + w.key, title: winName(w), target: w.aumid ? `shell:AppsFolder\\${w.aumid}` : w.exe, kind: 'single', cover: '#64748B', glyph: 'text' }
      return { rec, wins: ws }
    })
  }, [wins, dockRecords])
  // 깜빡임(주의): 레코드 id · 'run:<키>' — 창이 맨 앞으로 오면 Rust 가 지운다
  const attention = useMemo(() => {
    const keys = new Set(wins.filter((w) => w.flash).flatMap((w) => w.keys))
    const ids = new Set(dockRecords.filter((r) => r.kind === 'single' && keys.has(key(r))).map((r) => r.id))
    for (const a of runApps) if (a.wins.some((w) => w.flash)) ids.add(a.rec.id)
    return ids
  }, [wins, dockRecords, runApps])
  const fgRec = fg ? records.find((r) => matches(r, fgKeys(fg.f))) : undefined
  // 살아 있는 레코드 id: 단일 = 실행 집합에 대상이 있음, 세트 = 멤버 중 하나라도 (독 실행 점·Island LP 회전 공용)
  const aliveIds = useMemo(() => {
    const ids = new Set(records.filter((r) => matches(r, runKeys)).map((r) => r.id))
    for (const r of records) if (r.kind === 'set' && r.targets?.some((id) => ids.has(id))) ids.add(r.id)
    return ids
  }, [records, runKeys])
  const members = (r: LpRecord) => (r.kind === 'set' ? (r.targets ?? []).map((id) => records.find((x) => x.id === id)).filter((x): x is LpRecord => !!x) : [r])

  // LP → Island (턴테이블 대체): 독 우클릭 'Island에 올리기' · 크레이트에서 끌어 놓기 = 실행.
  // 시안: 실행하면 playing 이 그 레코드 → Island nowPlaying 의 LP 가 돈다. 실제 앱: 포그라운드가 그 앱이 되면 Island 가 받는다.
  const onCue = (r: LpRecord) => void run(r)
  const [lpDrag, setLpDrag] = useState<'off' | 'drag' | 'over'>('off')

  // Hera Team 변경 소식 (시안: 데모 바에서 발생, 4초 뒤 사라짐). 실제 앱: 그룹원이 바꾸면 Hera Link 로 받아 Island 에.
  const [news, setNews] = useState<TeamNews | null>(null)
  useEffect(() => {
    if (!news) return
    const t = window.setTimeout(() => setNews(null), 4200)
    return () => clearTimeout(t)
  }, [news?.n])
  const NEWS = [
    { who: '민수', group: 'tg-dev', what: '일정 추가', detail: '금 14:00 · 배포' },
    { who: '서연', group: 'tg-banner', what: '메모 수정', detail: '메인 배너 카피 A/B 안 정리' },
    { who: '지은', group: 'tg-dev', what: '일정 변경', detail: '코드 리뷰 데이 · 내일 10:00 → 11:00' },
  ]
  const fireNews = () => setNews((n) => ({ ...NEWS[(n?.n ?? 0) % NEWS.length], n: (n?.n ?? 0) + 1 }))

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
      <GlassDefs />
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
            <header className="demo-sub">
              <b>v2</b>
              <small>{clock.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })} {clock.getHours()}시 · {seasonOf(clock)} · {city} {weather?.text}</small>
            </header>
            <div className="demo-btns v2">
              {(Object.keys(FX_LABEL) as FxKind[]).map((k) => (
                <button key={k} onClick={() => playFx(k)}>{FX_LABEL[k]}</button>
              ))}
              <button onClick={() => playFx(pickFx(clock, weather))}>지금 보기</button>
            </div>
            <div className="demo-seg" role="group" aria-label="시간대">
              {([['지금', null], ['아침', 9], ['오후', 15], ['노을', 18], ['밤', 22]] as const).map(([label, h]) => (
                <button key={label} aria-pressed={h === null ? !demoNow : demoNow?.getHours() === h} onClick={() => (setDemoNow((d) => (h === null ? null : withTime(d ?? new Date(), h))), event(h === 9 ? 'dawn' : h === 18 ? 'sunset' : h === 22 ? 'moon' : null))}>{label}</button>
              ))}
            </div>
            <div className="demo-seg" role="group" aria-label="계절">
              {([['봄', 3], ['여름', 6], ['가을', 9], ['겨울', 0], ['12월', 11]] as const).map(([label, m]) => (
                <button key={label} aria-pressed={clock.getMonth() === m || (m === 9 && seasonOf(clock) === '가을' && clock.getMonth() !== 11)} onClick={() => (setDemoNow((d) => withMonth(d ?? new Date(), m)), event(m === 9 ? 'leaves' : null))}>{label}</button>
              ))}
            </div>
            <div className="demo-seg" role="group" aria-label="날씨">
              {(['맑음', '비', '눈'] as const).map((w) => (
                <button key={w} aria-pressed={weather?.text === w} onClick={() => (setWeatherOverride({ text: w, temp: w === '눈' ? -2 : 9 }), event(w === '비' ? 'rain' : w === '눈' ? 'snow' : null))}>{w}</button>
              ))}
            </div>
            <div className="demo-btns v2">
              <button onClick={() => setAscii({ open: true, from: null, saver: false })}>아스키 전체화면</button>
              <button aria-pressed={idleDemo} onClick={() => setIdleDemo((d) => !d)}>화면보호기 5초 {idleDemo ? '켬' : '끔'}</button>
            </div>
 <TeamDemo
              onSettings={() => openPanel('settings')}
              onCalendar={() => openPanel('calendar')}
              onNews={fireNews}
              onAlarm={() => pushAlert({ title: '배포', body: '금 14:00 시작 · 민수님이 추가한 일정', key: 'event:t1', group: 'tg-dev' })}
            />
            <V3Demo records={records} fgId={playing?.recordId} onApp={(r) => setPlaying({ recordId: r.id, title: r.title, startedAt: Date.now() - 4 * 60_000 })} onPanel={openPanel} onPalette={() => setPalette(true)} />
          </aside>
          <Taskbar />
          <V3Layer records={records} fgId={playing?.recordId} />
        </>
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
          alive={isTauri ? !!fgRec && aliveIds.has(fgRec.id) : !!playing && ids(records.find((r) => r.id === playing.recordId) ?? { id: playing.recordId, kind: 'single' } as LpRecord).some((id) => running.has(id))}
          lp={lpDrag}
          news={news}
          onDone={done}
          onSnooze={snooze}
          onOpen={() => openPanel('todo')}
          onDropFiles={(paths) => dropFiles(paths, true)}
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
          library={records}
          onRemoveRecord={(r) => removeRecord(r.id)}
          onLibrary={() => openPanel('library')}
          onLpDrag={setLpDrag}
          shelf={shelf}
          onShelfOpen={(f) => void launch(f.path).catch((e) => showAlert({ title: '파일을 열 수 없어요', body: String(e) }))}
          onShelfRemove={(f) => setShelf((fs) => fs.filter((x) => x.id !== f.id))}
          groups={dockGroups}
          scene={scene}
          runApps={runApps}
          attention={attention}
          onWinClick={(w) => void winClick(w.hwnd).catch((e) => showAlert({ title: '창을 열 수 없어요', body: String(e) }))}
          onWinClose={(w) => void winClose(w.hwnd).catch(() => {})}
          onPin={(r) => void addRecord(r.target, r.title)}
          onKey={(k) => void shellKey(k).catch((e) => showAlert({ title: '키를 보내지 못했어요', body: String(e) }))}
          onAscii={(from) => (isTauri ? void openAscii([from.left + screenX, from.top + screenY, from.width, from.height]) : setAscii({ open: true, from, saver: false }))}
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
          groups={groups}
          onSaveGroup={saveGroup}
          onRemoveGroup={(id) => setGroups((gs) => gs.filter((g) => g.id !== id))}
          fxOn={fxOn}
          setFxOn={setFxOn}
          city={city}
          setCity={(c) => (setCity(c), setWeatherOverride(null))}
          weather={weather}
          idleMin={idleMin}
          setIdleMin={setIdleMin}
          onFxNow={() => playFx(pickFx(clock, weather))}
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
          clips={clips}
          onCopy={copyClip}
        />
      )}
      {show('ascii') && (
        <AsciiFull
          open={ascii.open}
          id={scene}
          from={ascii.from}
          saver={ascii.saver}
          caption={`${clock.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} · ${seasonOf(clock)}`}
          onClose={() => setAscii((a) => ({ ...a, open: false }))}
          onClosed={isTauri ? () => void closeSelf() : undefined}
        />
      )}
      {fx && show('fx') && <Fx key={fx.n} kind={fx.kind} onDone={() => (isTauri ? void closeSelf() : setFx(null))} />}
    </div>
  )
}

const withTime = (d: Date, h: number) => {
  const x = new Date(d)
  x.setHours(h, 0, 0, 0)
  return x
}
const withMonth = (d: Date, m: number) => {
  const x = new Date(d)
  x.setMonth(m, 14)
  return x
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
