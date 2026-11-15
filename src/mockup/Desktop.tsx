import { useEffect, useRef, useState } from 'react'
import type { AppGroup, Clip, LpRecord, Notification, RunningSession, ShelfFile } from '../data/types'
import {
  clipList, closePalette, closePanelWindow, closeSelf, isTauri, launch, lnkTarget, onAlarm, onEvent, onStore, openAscii, openFx, panelOpen, sendAlert, setClip,
  asciiStop, linkAmbient, linkApply, linkImport, linkPair, linkSend, linkStatus, linkTrust, linkUnpair, type LinkCfg, type LinkFilesEv, type LinkStatus,
  chatSendPaths, floatOpen, fxStop, hubAction, storeSet, teamState, startApps, titleOf, togglePanel, useItems, useValue, watchState, type AlertMsg, type Fg, type FloatKind,
} from '../data/api'
import { COVERS, seedClips, seedEvents, seedGroups, seedRecords, seedShelf, seedTodos, STRESS } from '../data/mock'
import { AMBIENT } from '../surfaces/LinkExtras'
import { Island, type LinkView, type NextItem, type TeamNews } from '../surfaces/Island'
import { CalendarFilter, groupOf, setGroupCount, TeamDemo } from '../surfaces/Team'
import { Panel, TodoTab, type Tab } from '../surfaces/Panel'
import { Hub, type HubKind } from '../surfaces/Hub'
import { ClipsList, FloatShell, ShelfList } from '../surfaces/Float'
import { Player, type PlayerRec } from '../surfaces/Player'
import { ChatWindow, type Msg as ChatMsg } from '../surfaces/Chat'
import { MonthCalendar } from '../surfaces/MonthCalendar'
import { Palette } from '../surfaces/Palette'
import { McpIsland } from '../surfaces/Mcp' // AI 연결(MCP)
import { AsciiFull, pickScene, seasonOf, SCENES, type SceneId } from '../surfaces/Ascii'
import { ASCII_RECORDS } from '../surfaces/Lp'
import { newNote, setV3, useV3, V3Demo, V3Layer } from '../surfaces/Notes'
import { Ocr } from '../surfaces/Ocr'
import { reportHitRects } from '../data/api'
import { GlassDefs } from '../surfaces/GlassDefs'
import { FX_LABEL, Fx, fakeWeather, fetchWeather, geocode, pickFx, type FxKind, type Weather } from '../surfaces/Fx'

// 포그라운드 앱 이름: 창 제목의 마지막 " - " 조각(대부분 앱 이름), 없으면 exe 이름
const matches = (r: LpRecord, keys: Set<string>) => r.kind === 'single' && keys.has((r.exe ?? r.target).toLowerCase())
const hm = (t: string | number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
export const SHELF_MAX = 4 // ponytail: 칸 4개, 넘치면 가장 오래된 것부터 뺀다 — 더 필요하면 목록
const FLOATS: FloatKind[] = ['todo', 'calendar', 'chat', 'term', 'clips', 'shelf', 'lp']
const fgKeys = (f: Fg) => new Set([f.exePath.toLowerCase(), f.aumid && `shell:appsfolder\\${f.aumid}`.toLowerCase()])

// surface=all: 가짜 바탕화면 + 모든 표면 + 데모 컨트롤. 그 외: 해당 표면만 (Tauri 창 1개 = 표면 1개).
// Island-only: 독 없음 — island(노치·알림·허브) · float(기능 창 1개, ?f=) · panel · palette · ascii · fx · notes* · ocr.
export function Desktop({ only }: { only?: string }) {
  const show = (s: string) => !only || only === s
  const [theme, setTheme] = useState(document.documentElement.dataset.theme)
  const [records, setRecords] = useItems<LpRecord>('record', seedRecords)
  const [pinned, setPinned] = useValue<string[]>('dock.pinned', seedRecords.map((r) => r.id))
  const [todos, setTodos] = useItems('todo', seedTodos)
  const [events, setEvents] = useItems('event', seedEvents)

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

  // v2 클립보드 기록: 메모리에만 최근 20개. 실제 앱 = Rust AddClipboardFormatListener → 팔레트 창 'clips' (폴링 없음)
  const [clips, setClips] = useState<Clip[]>(isTauri ? [] : seedClips)
  useEffect(() => {
    if (!isTauri || (only !== 'palette' && only !== 'float')) return // 팔레트 + 떠 있는 '최근 복사' 창
    void clipList().then(setClips)
    return onEvent<Clip[]>('clips', setClips)
  }, [])
  const copyClip = (c: Clip) => {
    // 실제 앱: Rust 가 클립보드에 넣으면 리스너가 다시 받아 맨 앞으로 올린다
    if (isTauri) return void setClip(c.text).catch((e) => showAlert({ title: '복사하지 못했어요', body: String(e) }))
    void navigator.clipboard?.writeText(c.text).catch(() => {})
    setClips((cs) => [{ ...c, at: Date.now() }, ...cs.filter((x) => x.id !== c.id)].slice(0, 20))
  }

  // Hera Link: 엔진 상태(모든 창) · 파일 채널 페어링/전송 · 화면 전환 애니메이션(Island). 시안 = 꺼짐.
  const [linkOn, setLinkOn] = useValue('link.enabled', false)
  const [linkCfg, setLinkCfg] = useValue<LinkCfg | null>('link.cfg', null)
  const [peerName] = useValue<string | null>('link.peerName', null)
  const [link, setLink] = useState<LinkStatus | null>(null)
  const [filesPeer, setFilesPeer] = useState<string | null>(null)
  const [pair, setPair] = useState<{ code: string; name: string } | null>(null)
  const [xfer, setXfer] = useState<{ dir: 'in' | 'out'; name: string; bytes: number; size: number; done?: boolean } | null>(null)
  const [swap, setSwap] = useState<{ onPeer: boolean; n: number } | null>(null)
  const [ime, setIme] = useState<{ source: 'ko' | 'en'; n: number } | null>(null)
  const imeTimer = useRef(0)
  const [peerAscii, setPeerAscii] = useState(false)
  const swapTimer = useRef(0)
  const xferTimer = useRef(0)
  const shelveRef = useRef<(paths: string[]) => void>(() => {})
  shelveRef.current = shelve
  useEffect(() => {
    if (!isTauri) return
    void linkStatus().then(([st, f]) => (setLink(st), setFilesPeer(f)))
    const offs = [
      onEvent<LinkStatus>('link-status', setLink),
      onEvent<{ onPeer: boolean }>('link-switch', (e) => {
        setSwap((s) => ({ onPeer: e.onPeer, n: (s?.n ?? 0) + 1 }))
        clearTimeout(swapTimer.current)
        swapTimer.current = window.setTimeout(() => setSwap(null), 1600)
      }),
      onEvent<LinkFilesEv>('link-files', (e) => {
        if (e.kind === 'peer') (setFilesPeer(e.state === 'ready' ? e.name : null), setPair(e.state === 'pairing' ? { code: e.code, name: e.name } : null))
        if (e.kind === 'xfer') (clearTimeout(xferTimer.current), setXfer({ dir: e.dir, name: e.name, bytes: e.bytes, size: e.size }))
        if (e.kind === 'received' || e.kind === 'sent') {
          setXfer((x) => x && { ...x, done: true, bytes: x.size })
          xferTimer.current = window.setTimeout(() => setXfer(null), 1400)
          if (e.kind === 'sent' && !e.ok) showAlert({ title: '보내지 못했어요', body: e.error })
        }
      }),
    ]
    if (only === 'island') offs.push(onEvent<string>('link-received', (path) => shelveRef.current([path])), onEvent<string>('shelf-add', (path) => shelveRef.current([path])))
    // 한/영 칩: 이 PC 의 IME 변화(Rust WinEvent) 또는 맥이 알려 준 입력 소스
    if (only === 'island')
      offs.push(onEvent<{ source: 'ko' | 'en' }>('ime-state', (e) => {
        setIme((s) => ({ source: e.source, n: (s?.n ?? 0) + 1 }))
        clearTimeout(imeTimer.current)
        imeTimer.current = window.setTimeout(() => setIme(null), 800)
      }))
    return () => offs.forEach((off) => off())
  }, [])
  const linkView: LinkView | null = link && link.state !== 'off' ? { connected: link.state === 'connected', peer: link.peer || linkCfg?.peer || 'Mac', files: !!filesPeer, swap, pair, xfer } : pair || xfer || swap ? { connected: !isTauri, peer: pair?.name ?? 'MacBook', files: !isTauri || !!filesPeer, swap, pair, xfer } : null
  const sendToPeer = (paths: string[]) => paths.forEach((p) => void linkSend(p).catch((e) => showAlert({ title: '보내지 못했어요', body: String(e) })))
  // 설정 저장은 store 에 비동기로 쓰인다 → 잠깐 뒤에 Rust 가 다시 읽게
  const applyLink = () => window.setTimeout(() => void linkApply(), 250)

  // v2 시간·계절 (시안 데모 바에서 바꿔 볼 수 있음) → 아스키 장면·효과 선택
  const [demoNow, setDemoNow] = useState<Date | null>(null)
  const clock = demoNow ?? new Date()
  // 아스키 창: ?scene= 으로 장면 지정 (AI 연결 start_ascii(scene) 등), 없으면 계절·시간대
  const urlScene = new URLSearchParams(location.search).get('scene') as SceneId | null
  const scene = only === 'ascii' && urlScene && urlScene in SCENES ? urlScene : pickScene(clock)

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
    if (!isTauri || only !== 'island') return
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
  // scene = 아스키 LP 로 고른 장면 (없으면 계절·시간대 자동), lp = Island 에 '아스키 재생 중' 으로 보여 줄 레코드 이름
  type AsciiState = { open: boolean; from: DOMRect | null; saver: boolean; scene?: SceneId; lp?: string }
  const [ascii, setAscii] = useState<AsciiState>(() => {
    const q = new URLSearchParams(location.search), f = q.get('from')?.split(',').map(Number), sc = q.get('scene') as SceneId | null
    return { open: only === 'ascii', from: f?.length === 4 ? new DOMRect(f[0], f[1], f[2], f[3]) : null, saver: q.get('saver') === '1', scene: sc && sc in SCENES ? sc : undefined }
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

  const [playing, setPlaying] = useState<RunningSession | null>(null)
  // 알림 큐: 앞에서부터 1개씩 표시 (전체화면 뒤 밀린 알림·여러 건 동시 발화)
  const [alerts, setAlerts] = useState<Notification[]>([])
  const alert = alerts[0] ?? null
  const pushAlert = (a: Omit<Notification, 'id'>) => setAlerts((q) => (a.key && q.some((x) => x.key === a.key) ? q : [...q, { id: crypto.randomUUID(), ...a }]))
  const [peek, setPeek] = useState(false)
  const peekTimer = useRef(0)
  const showAlert = (a: AlertMsg) => (isTauri ? void sendAlert(a) : pushAlert(a))

  // B3 (Tauri): 실행 집합(2s) · 포그라운드(30Hz 변화 시) — watch 루프 이벤트. 늦게 뜬 창은 watch_state 로 즉시 동기화.
  const [fg, setFg] = useState<{ key: string; f: Fg; since: number } | null>(null)
  useEffect(() => {
    if (!isTauri) return
    const onFg = (f: Fg) => setFg((cur) => (cur?.key === (f.aumid || f.exePath) ? cur : { key: f.aumid || f.exePath, f, since: Date.now() }))
    void watchState().then(([f]) => f && onFg(f))
    const offs = [
      onEvent('foreground', onFg),
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
  useEffect(() => void (STRESS && setGroupCount(12)), [])
  const fgRec = fg ? records.find((r) => matches(r, fgKeys(fg.f))) : undefined
  const members = (r: LpRecord) => (r.kind === 'set' ? (r.targets ?? []).map((id) => records.find((x) => x.id === id)).filter((x): x is LpRecord => !!x) : [r])

  // 아스키 LP: 전체화면 아스키가 Island 자리에서 커진다. Island 는 '아스키 재생 중' + 정지.
  const playAscii = (r: LpRecord) => {
    const scene = !r.scene || r.scene === 'auto' ? pickScene(clock) : r.scene
    const from = document.querySelector('.island-shape')?.getBoundingClientRect() ?? null
    if (isTauri) return void openAscii(from && [from.left + screenX, from.top + screenY, from.width, from.height], scene)
    setAscii({ open: true, from, saver: false, scene, lp: `${SCENES[scene].name}${r.scene === 'auto' ? ' · 자동' : ''}` })
  }
  // LP 플레이어로 튼 화면 효과 → Island '재생 중' 알약 (효과 창 수명을 따른다)
  const [fxPlaying, setFxPlaying] = useState<string | null>(null)
  // 실제 앱: 아스키·효과 창 열림/닫힘 → Island '재생 중' · Hera Team 변경 소식 → Island
  useEffect(() => {
    if (!isTauri || only !== 'island') return
    const offs = [
      onEvent<{ scene: SceneId | null; saver: boolean }>('ascii-open', (e) => {
        const sc = e.scene ?? pickScene(new Date())
        if (!e.saver) setAscii({ open: true, from: null, saver: false, scene: sc, lp: `${SCENES[sc].name}${e.scene ? '' : ' · 자동'}` })
      }),
      onEvent('ascii-closed', () => setAscii((a) => ({ ...a, open: false }))),
      onEvent<string>('fx-open', (k) => setFxPlaying(`${FX_LABEL[k as FxKind] ?? k} · 화면 효과`)),
      onEvent('fx-closed', () => setFxPlaying(null)),
      onEvent<{ group: string; by: string; action: string; title: string }>('team-news', (e) =>
        setNews((n) => ({ who: e.by, group: e.group, what: e.action === 'delete' ? '항목 삭제' : e.title ? '항목 변경' : '변경', detail: e.title, n: (n?.n ?? 0) + 1 })),
      ),
    ]
    return () => offs.forEach((off) => off())
  }, [])

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

  // 팀 채팅: 받은 메시지 → Island 알림 + 빠른 답장, 읽지 않음 수 = store `chat.unread` (채팅 창이 열리면 0)
  const [chatUnread, setChatUnread] = useValue('chat.unread', 0)
  const [msg, setMsg] = useState<{ who: string; group: string; color: string; text: string; n: number; gid: string } | null>(null)
  const msgT = useRef(0)
  const [meTeam, setMeTeam] = useState({ name: '나', pk: 'me' })
  const showMsg = (m: ChatMsg) => {
    const g = groupOf(m.group)
    setMsg((x) => ({ who: m.by, group: g?.name ?? '', color: g?.color ?? '#64748b', gid: m.group, text: m.kind === 'text' ? m.text ?? '' : m.kind === 'image' ? `사진 · ${m.name}` : `파일 · ${m.name}`, n: (x?.n ?? 0) + 1 }))
    const hide = () => {
      clearTimeout(msgT.current)
      // 답장을 쓰는 중이면 기다린다
      msgT.current = window.setTimeout(() => (document.activeElement?.closest('.hubmsg') ? hide() : setMsg(null)), 7000)
    }
    hide()
  }
  useEffect(() => {
    if (!isTauri || only !== 'island') return
    void teamState().then((t) => setMeTeam({ name: t.name, pk: t.pk }), () => {})
    return onEvent<ChatMsg>('chat-msg', showMsg)
  }, [])
  // 채팅 창이 열려 있으면 노치 드롭존 오른쪽 = '채팅에 보내기' (Rust float-opened/float-closed)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatGroup] = useValue<string>('chat.group', '')
  useEffect(() => {
    if (!isTauri || only !== 'island') return
    const offs = [onEvent<string>('float-opened', (f) => f === 'chat' && setChatOpen(true)), onEvent<string>('float-closed', (f) => f === 'chat' && setChatOpen(false))]
    return () => offs.forEach((off) => off())
  }, [])
  const reply = (t: string) => {
    if (!msg) return
    const id = crypto.randomUUID()
    storeSet(`chat:${id}`, { id, group: msg.gid, by: meTeam.name, byPk: meTeam.pk, kind: 'text', text: t, at: Date.now() })
    setMsg(null)
    setChatUnread(0)
  }

  // C3: 팔레트 창은 숨김 상주. 열릴 때('palette-open') 입력 포커스 + 시작 메뉴 앱(첫 열기 때 1회, Rust 캐시 ~1s),
  // 닫을 때 다시 마운트해 검색어를 비운다 (다음 열기에 이전 내용이 비치지 않게).
  const [apps, setApps] = useState<[string, string][]>([])
  const [palN, setPalN] = useState(0)
  const [palQ, setPalQ] = useState('') // 처음 검색어 (허브 '스니펫' = ';')
  useEffect(() => {
    if (!isTauri || only !== 'palette') return
    let loaded = false
    return onEvent<string | null>('palette-open', (q) => {
      if (q != null) (setPalQ(q), setPalN((n) => n + 1)) // 다시 마운트해 그 검색어로
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.palette-input input')?.focus())
      // 실패(타임아웃 등)하면 다음 열기에 다시 시도
      if (!loaded) (loaded = true), void startApps().then(setApps, (e) => ((loaded = false), console.error('start_apps', e)))
    })
  }, [])

  const [panel, setPanel] = useState<{ open: boolean; tab: Tab; sec?: string } | null>(() => {
    const q = new URLSearchParams(location.search)
    return only === 'panel' ? { open: true, tab: (q.get('tab') as Tab) ?? 'todo', sec: q.get('sec') ?? undefined } : null
  })
  // 이미 열린 패널에 허브가 다른 탭·섹션을 요청 ("settings&sec=team")
  useEffect(() => {
    if (!isTauri || only !== 'panel') return
    return onEvent<string>('panel-tab', (t) => {
      const q = new URLSearchParams('tab=' + t)
      setPanel({ open: true, tab: (q.get('tab') as Tab) ?? 'todo', sec: q.get('sec') ?? undefined })
    })
  }, [])
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


  // C2: 세트는 순서대로 실행 (앞 앱의 실행 요청이 끝난 뒤 다음)
  const run = async (r: LpRecord) => {
    if (!isTauri) {
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

  /* ── Island-only: 허브(노치 아래) · 떠 있는 기능 창 ── */
  const [hub, setHub] = useState(false)
  const [hubRect, setHubRect] = useState<DOMRect | null>(null)
  const [dragNear, setDragNear] = useState(false)
  const [mockFloats, setMockFloats] = useState<FloatKind[]>([])
  const { notes: notesShown } = useV3()
  const dwell = useRef(0)
  const onHover = (on: boolean, type: string) => {
    clearTimeout(dwell.current)
    if (on && type === 'mouse') dwell.current = window.setTimeout(() => setHub(true), 300)
  }
  const [, tickClock] = useState(0) // 노치·알약 시계 (30초마다)
  useEffect(() => {
    if (only && only !== 'island') return
    const t = setInterval(() => tickClock((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!isTauri || only !== 'island') return
    // 실제 앱: 아일랜드 창은 클릭 통과라 바깥 클릭을 못 본다 → watch 루프가 알려 줌 · 파일을 끌고 위쪽 가운데로 오면 드롭존
    const offs = [onEvent('island-outside', () => setHub(false)), onEvent<boolean>('drag-near', setDragNear)]
    return () => offs.forEach((off) => off())
  }, [])
  useEffect(() => {
    if (!hub || isTauri) return
    const down = (e: PointerEvent) => !(e.target as Element).closest?.('.hub, .island-shape') && setHub(false)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setHub(false)
    addEventListener('pointerdown', down, true)
    addEventListener('keydown', key)
    return () => (removeEventListener('pointerdown', down, true), removeEventListener('keydown', key))
  }, [hub])
  const openFloat = (f: FloatKind) => (isTauri ? void floatOpen(f).catch((e) => showAlert({ title: '창을 열 수 없어요', body: String(e) })) : setMockFloats((fs) => [...fs.filter((x) => x !== f), f]))
  const pick = (k: HubKind) => {
    setHub(false)
    if ((FLOATS as string[]).includes(k)) return openFloat(k as FloatKind)
    if (isTauri) return void hubAction(k as 'notes').catch((e) => showAlert({ title: '열 수 없어요', body: String(e) }))
    if (k === 'notes') return setV3({ notes: !notesShown })
    if (k === 'ocr') return setV3({ ocr: true })
    if (k === 'snippets') return setPalette(true)
    openPanel('settings')
  }
  // 허브 '+ 새 메모': 실제 앱은 메모 창이 따로라 store 에 쓰고 note.edit 로 편집 상태를 알린다
  const addNote = () => {
    setHub(false)
    if (!isTauri) return (setV3({ notes: true }), void setTimeout(() => newNote(), 60))
    const id = crypto.randomUUID()
    storeSet(`note:${id}`, { id, text: '', color: 0, x: Math.round(innerWidth / 2 - 105), y: 160, w: 210, h: 140, pinned: false })
    storeSet('notes.shown', true)
    storeSet('note.edit', id)
    setTimeout(() => storeSet('note.edit', null), 3000)
  }
  const nextLabel = next ? `${next.at ? hm(next.at) + ' ' : ''}${next.title}` : undefined
  const openTodos = todos.filter((t) => !t.done).length
  const floatBody = (f: FloatKind) =>
    f === 'todo' ? <TodoTab todos={todos} setTodos={setTodos} onAdded={peekIsland} />
    : f === 'calendar' ? <><div className="float-tools"><CalendarFilter /></div><MonthCalendar events={events} setEvents={setEvents} todos={todos} onAdded={peekIsland} /></>
    : f === 'clips' ? <ClipsList clips={clips} onCopy={copyClip} />
    : f === 'shelf' ? (
      <ShelfList files={shelf} onOpen={(x) => void launch(x.path).catch((e) => showAlert({ title: '파일을 열 수 없어요', body: String(e) }))}
        onRemove={(x) => setShelf((fs) => fs.filter((y) => y.id !== x.id))} onSend={filesPeer ? (x) => sendToPeer([x.path]) : undefined} peer={filesPeer ?? undefined} />
    )
    : f === 'chat' ? <ChatWindow setEvents={setEvents} />
    : f === 'lp' ? <Player onPlay={isTauri ? undefined : mockPlay} onStop={isTauri ? undefined : mockStop} />
    : <p className="float-empty">준비 중이에요.</p>
  const floatQ = new URLSearchParams(location.search).get('f') as FloatKind | null
  // 시안: LP 플레이어가 실제 창 대신 이 페이지에서 재생
  const mockPlay = (r: PlayerRec) =>
    r.kind === 'fx' ? setFx((f) => ({ kind: r.arg as FxKind, n: (f?.n ?? 0) + 1 })) : setAscii({ open: true, from: null, saver: false, scene: r.arg === 'auto' ? pickScene(clock) : (r.arg as SceneId), lp: `${r.title} · 아스키` })
  const mockStop = (r: PlayerRec) => (r.kind === 'fx' ? setFx(null) : setAscii((a) => ({ ...a, open: false })))

  return (
    <div className="desktop" data-only={only ?? 'all'} data-real={isTauri} data-ascii={ascii.open}>
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
              <button onClick={() => setHub((h) => !h)}>허브 열기</button>
              <button onClick={() => (setChatUnread((n) => n + 1), showMsg({ id: 'demo', group: 'tg-dev', by: '민수', kind: 'text', text: '내일 3시 회의 어때요? 배포 체크리스트 같이 봐요', at: Date.now() }))}>메시지 받기</button>
              <button onClick={() => (panel?.open ? closePanel() : openPanel('todo'))}>패널</button>
              <button onClick={() => setPalette(true)}>검색 <kbd>Ctrl K</kbd></button>
              <button onClick={toggleTheme} aria-label="테마 전환">{theme === 'dark' ? '라이트' : '다크'} 모드</button>
            </div>
            <p>맨 위 가운데 얇은 노치를 누르거나 0.3초 올려 두면 허브가 펼쳐져요. 앱은 작업 표시줄·시작·Ctrl K.</p>
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
            <div className="demo-btns v2">
              <button onClick={() => (setSwap((s) => ({ onPeer: !s?.onPeer, n: (s?.n ?? 0) + 1 })), clearTimeout(swapTimer.current), (swapTimer.current = window.setTimeout(() => setSwap(null), 1600)))}>→ Mac</button>
              <button onClick={() => setPair((p) => (p ? null : { code: '482913', name: 'MacBook' }))}>페어링</button>
              <button onClick={() => {
                // 시안: 전송 진행 흉내 (2초) → 완료 애니메이션
                const size = 5_000_000, dir = Math.random() < 0.5 ? 'out' : 'in'
                let b = 0
                const t = window.setInterval(() => {
                  b = Math.min(size, b + size / 12)
                  setXfer({ dir, name: '회의록 최종.pdf', bytes: b, size, done: b >= size })
                  if (b >= size) (clearInterval(t), (xferTimer.current = window.setTimeout(() => setXfer(null), 1400)))
                }, 170)
              }}>파일 전송</button>
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
          playing={null}
          peek={peek}
          ascii={ascii.open && ascii.lp ? ascii.lp : fxPlaying ?? (!isTauri && fx && !only ? `${FX_LABEL[fx.kind]} · 화면 효과` : null)}
          onAscii={() => playAscii(ASCII_RECORDS[0])}
          onAsciiStop={() => (ascii.open ? (isTauri ? void asciiStop() : setAscii((a) => ({ ...a, open: false }))) : isTauri ? void fxStop() : setFx(null))}
          news={news}
          onDone={done}
          onSnooze={snooze}
          onOpen={() => setHub((h) => !h)}
          onDropFiles={(paths) => (setDragNear(false), dropFiles(paths, true))}
          pill={{ clock: hm(Date.now()), next: nextLabel, notch: !hub, shelf: shelf.length, onShelf: () => pick('shelf'), badge: chatUnread }}
          onHover={onHover}
          forceDrop={dragNear}
          msg={msg}
          onReply={reply}
          onMsgOpen={() => (setMsg(null), openFloat('chat'))}
          dropTo={chatOpen ? { label: '채팅에 보내기', sub: groupOf(chatGroup)?.name ?? '열린 채팅방', onFiles: (paths) => void (isTauri && chatGroup ? chatSendPaths(chatGroup, paths).catch((e) => showAlert({ title: '보내지 못했어요', body: String(e) })) : undefined) } : null}
          extraRect={hub ? hubRect : null}
          link={linkView}
          onSendFiles={sendToPeer}
          onPair={(ok) => void linkPair(ok)}
          ime={ime}
          onChip={filesPeer ? () => void linkAmbient({ kind: 'ascii', action: peerAscii ? 'stop' : 'start' }).then(() => setPeerAscii((v) => !v)) : undefined}
        />
      )}
      {show('island') && (
        <Hub open={hub} next={next} todos={openTodos} onPick={pick} onNewNote={addNote} onRect={setHubRect}
          onPalette={() => (setHub(false), isTauri ? void hubAction('palette') : setPalette(true))}
          badges={{ notes: notesShown && '•', todo: openTodos || null, shelf: shelf.length || null, chat: chatUnread || null }} />
      )}
      {only === 'island' && <McpIsland />} {/* AI 연결(MCP) 확인 카드·칩 — Mcp.tsx */}
      {only === 'float' && floatQ && <FloatShell f={floatQ}>{floatBody(floatQ)}</FloatShell>}
      {!only && mockFloats.map((f, i) => (
        <div key={f} className="mock-float" style={{ left: 340 + i * 36, top: 90 + i * 30 }}>
          <FloatShell f={f} mock onClose={() => setMockFloats((fs) => fs.filter((x) => x !== f))}>{floatBody(f)}</FloatShell>
        </div>
      ))}
      {panel && show('panel') && (
        <Panel
          open={panel.open}
          tab={panel.tab}
          sec={panel.sec}
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
          link={{
            on: linkOn,
            setOn: (v) => (setLinkOn(v), applyLink()),
            cfg: linkCfg,
            setCfg: (c) => (setLinkCfg(c), applyLink()),
            status: link,
            filesPeer,
            pairedName: peerName,
            pair,
            onPair: (ok) => void linkPair(ok),
            onImport: () => linkImport().then(setLinkCfg),
            onTrust: (fp) => void linkTrust(fp).catch((e) => showAlert({ title: '신뢰하지 못했어요', body: String(e) })),
            onUnpair: () => void linkUnpair(),
          }}
        />
      )}
      {palette && show('palette') && (
        <Palette
          key={palN}
          initialQ={palQ}
          records={records}
          todos={todos}
          apps={apps}
          onRun={run}
          onLaunch={(t) => void launch(t).catch((e) => showAlert({ title: '실행 실패', body: String(e) }))}
          onOpenTodo={() => (isTauri ? void panelOpen().then((o) => o || togglePanel('todo')) : openPanel('todo'))}
          onClose={(restore) => (isTauri ? (void closePalette(restore), setPalN((n) => n + 1)) : setPalette(false))}
          clips={clips}
          onCopy={copyClip}
          cmds={filesPeer ? AMBIENT.map(([label, a]) => ({ key: `amb-${label}`, title: `${filesPeer}에 ${label} 켜기`, sub: 'Hera Link · 상대 PC 화면', run: () => void linkAmbient(a).catch((e) => showAlert({ title: '보내지 못했어요', body: String(e) })) })).concat([{ key: 'amb-off', title: `${filesPeer} 화면 효과 끄기`, sub: 'Hera Link', run: () => void (linkAmbient({ kind: 'ascii', action: 'stop' }), linkAmbient({ kind: 'fx', action: 'stop' })) }]) : []}
        />
      )}
      {only?.startsWith('notes') && <NotesWindow records={records} fgId={fgRec?.id} />}
      {only === 'ocr' && <Ocr open onClose={() => void closeSelf()} onToast={(msg) => showAlert({ title: msg, body: '' })} />}
      {show('ascii') && (
        <AsciiFull
          open={ascii.open}
          id={ascii.scene ?? scene}
          from={ascii.from}
          saver={ascii.saver}
          caption={`${clock.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} · ${seasonOf(clock)}`}
          onClose={() => setAscii((a) => ({ ...a, open: false }))}
          onClosed={isTauri ? () => void closeSelf() : undefined}
        />
      )}
      {fx && show('fx') && <Fx key={fx.n} kind={fx.kind} onDone={() => (isTauri ? void closeSelf() : setFx(null))} />}
      {only === 'fx' && <FxCloser />}
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

/* v3 메모 창 (실제 앱): 모니터마다 창 1개 — URL ?x&y&s = 그 모니터의 원점(물리 px)과 배율.
   메모 좌표는 가상 데스크톱(주 모니터 배율 기준 논리 px) → 이 창 원점만큼 옮겨 그린다 (CSS transform = fixed 요소의 기준).
   앱 메모는 앞 앱 창(Rust 'fg-rect')이 있는 모니터의 창에서만. 클릭 통과: 메모 카드·팝오버 rect 만 히트로 보고. */
function NotesWindow({ records, fgId }: { records: LpRecord[]; fgId?: string }) {
  const q = new URLSearchParams(location.search)
  const [ox, oy, sc] = [Number(q.get('x') ?? 0), Number(q.get('y') ?? 0), Number(q.get('s') ?? 1)]
  const [fgRect, setFgRect] = useState<[number, number, number, number] | null>(null)
  useEffect(() => onEvent<{ rect: [number, number, number, number] | null }>('fg-rect', (e) => setFgRect(e.rect)), [])
  // 앞 앱 창이 이 모니터 안에 있나 (가운데 점 기준) → 이 창 기준 CSS rect
  const mine = fgRect && fgRect[0] + fgRect[2] / 2 >= ox && fgRect[0] + fgRect[2] / 2 < ox + innerWidth * sc && fgRect[1] + fgRect[3] / 2 >= oy && fgRect[1] + fgRect[3] / 2 < oy + innerHeight * sc
  const anchor = mine ? new DOMRect((fgRect[0] - ox) / sc, (fgRect[1] - oy) / sc, fgRect[2] / sc, fgRect[3] / sc) : undefined
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = root.current!
    let raf = 0
    const send = () => {
      raf = 0
      const rects = [...el.querySelectorAll<HTMLElement>('.note, .note-pop, .app-note, .notes-toast')].map((n) => n.getBoundingClientRect()).filter((r) => r.width && r.height)
      reportHitRects('notes', rects)
    }
    const kick = () => void (raf ||= requestAnimationFrame(send))
    // 메모를 끌거나 크기를 바꾸면 style 이 바뀐다 → 다음 프레임에 1번 (폴링 없음)
    const mo = new MutationObserver(kick)
    mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'data-shown'] })
    kick()
    return () => (mo.disconnect(), cancelAnimationFrame(raf))
  }, [])
  // 주 모니터 기준 논리 좌표 → 이 창: (가상 원점 / 이 창 배율) 만큼 반대로
  return (
    <div ref={root} className="notes-window" style={{ position: 'fixed', inset: 0, transform: `translate(${-ox / sc}px, ${-oy / sc}px)` }}>
      <V3Layer records={records} fgId={mine ? fgId : undefined} anchor={anchor && new DOMRect(anchor.x + ox / sc, anchor.y + oy / sc, anchor.width, anchor.height)} />
    </div>
  )
}

/** 효과 창: LP 플레이어에서 판을 내리면 'fx-close' → 바로 닫기 (Rust 가 3초 안전망으로 파괴) */
function FxCloser() {
  useEffect(() => onEvent('fx-close', () => void closeSelf()), [])
  return null
}
