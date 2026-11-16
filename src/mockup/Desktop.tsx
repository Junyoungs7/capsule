import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { AppGroup, Clip, LpRecord, Notification, RunningSession, ShelfFile } from '../data/types'
import {
  clipList, closePalette, closeSelf, isTauri, islandOpen, launch, openAscii, lnkTarget, onAlarm, onEvent, onStore, openFx, openSettings, sendAlert, setClip,
  asciiStop, linkAmbient, linkApply, linkImport, linkPair, linkSend, linkStatus, linkTrust, linkUnpair, type LinkCfg, type LinkFilesEv, type LinkStatus,
  chatSendPaths, floatAbsorbed, floatOpen, floatPrepare, floatShow, fxStop, hubAction, islandFocus, noteNotepad, islandPaste, islandTall, storeSet, startApps, titleOf, useItems, useValue, type AlertMsg, type FloatKind,
} from '../data/api'
import { COVERS, seedClips, seedEvents, seedGroups, seedRecords, seedShelf, seedTodos, STRESS } from '../data/mock'
import { AMBIENT } from '../surfaces/LinkExtras'
import { fmtWhen, Island, type Alert, type NextItem } from '../surfaces/Island'
import { CalendarFilter, groupOf, setGroupCount, TeamDemo, TeamSection } from '../surfaces/Team'
import { TodoTab } from '../surfaces/Todo'
import { SettingsWin } from '../surfaces/Settings'
import { ConnectHead, ConnectView, linkLook, useShare, type LinkBundle } from '../surfaces/Connect'
import { FX_RECORDS, Launcher, useStar, type FxRec } from '../surfaces/Launcher'
import { SnippetTab } from '../surfaces/Snippets'
import { DETACHABLE, FIXED_H, GhostLayer, recordFrames, HubHome, ViewShell, VIEW_SIZE, VIEWS, WinChrome, type Ghost, type HubKind, type ViewKind } from '../surfaces/Hub'
import { customOf, refreshPets, useCustomPets, type IslandPrefs } from '../surfaces/PetSettings'
import { NOTE_COLORS } from '../surfaces/Notes'
import { Ico } from '../surfaces/Icons'
import type { CapSize } from '../surfaces/Pet'
import { useSnippets } from '../surfaces/Snippets'
import { expand } from '../data/snippets'
import { ClipsList, FloatShell, FloatWin, ShelfList } from '../surfaces/Float'
import { ChatWindow, type Msg as ChatMsg } from '../surfaces/Chat'
import { TermPreview, TermWindow } from '../surfaces/Term'
import { MonthCalendar } from '../surfaces/MonthCalendar'
import { Palette } from '../surfaces/Palette'
import { McpIsland } from '../surfaces/Mcp' // AI 연결(MCP)
import { AsciiFull, pickScene, seasonOf, SCENES, type SceneId } from '../surfaces/Ascii'
import { freeSlot, NoteBoard, seedNotes, setV3, useV3, V3Demo, type Note } from '../surfaces/Notes'
import { Ocr } from '../surfaces/Ocr'
import { GlassDefs } from '../surfaces/GlassDefs'
import { FX_LABEL, Fx, fakeWeather, fetchWeather, geocode, pickFx, type FxKind, type Weather } from '../surfaces/Fx'

// 포그라운드 앱 이름: 창 제목의 마지막 " - " 조각(대부분 앱 이름), 없으면 exe 이름
const hm = (t: string | number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
export const SHELF_MAX = 4 // ponytail: 칸 4개, 넘치면 가장 오래된 것부터 뺀다 — 더 필요하면 목록

// surface=all: 가짜 바탕화면 + 모든 표면 + 데모 컨트롤. 그 외: 해당 표면만 (Tauri 창 1개 = 표면 1개).
// Island-only: 독 없음 — island(노치·알림·허브) · float(기능 창 1개, ?f=) · panel · palette · ascii · fx · notes* · ocr.
export function Desktop({ only }: { only?: string }) {
  const show = (s: string) => !only || only === s
  const [theme, setTheme] = useState(document.documentElement.dataset.theme)
  const [records, setRecords] = useItems<LpRecord>('record', seedRecords)
  const [star, setStar] = useStar() // (a6) LP ★ = 상자 맨 앞 + 검색 맨 위
  const [todos, setTodos] = useItems('todo', seedTodos)
  const [events, setEvents] = useItems('event', seedEvents)

  const addRecord = async (target: string, title = titleOf(target)) => {
    const id = crypto.randomUUID()
    // .lnk 는 대상 exe 를 한 번 풀어 둔다 (실행 집합은 exe 경로라서)
    const exe = isTauri && /\.lnk$/i.test(target) ? await lnkTarget(target).catch(() => undefined) : undefined
    setRecords((rs) => [...rs, { id, title, target, exe, kind: 'single', cover: COVERS[rs.length % COVERS.length], glyph: 'text' }])
  }
  const removeRecord = (id: string) => {
    setRecords((rs) => rs.filter((r) => r.id !== id))
    setStar({ ...star, app: (star.app ?? []).filter((x) => x !== id) })
  }
  // C2: 세트 = 기존 단일 레코드 묶음 (독에는 고정하지 않음 — LP 크레이트·팔레트에서 쓴다)
  const addSet = (title: string, targets: string[]) =>
    setRecords((rs) => [...rs, { id: crypto.randomUUID(), title, target: '', kind: 'set', targets, cover: COVERS[rs.length % COVERS.length], glyph: 'set' }])

  // C4 파일 선반 (shelf:<id>)
  const [shelf, setShelf] = useItems<ShelfFile>('shelf', seedShelf)
  const shelve = (paths: string[]) => (
    setShelfPing((x) => ({ n: (x?.n ?? 0) + 1, count: paths.length })),
    setShelf((fs) => [...fs.filter((f) => !paths.includes(f.path)), ...paths.map((path, i) => ({ id: crypto.randomUUID(), path, at: Date.now() + i }))].sort((a, b) => a.at - b.at).slice(-SHELF_MAX)))
  const dropFiles = (paths: string[], toShelf: boolean) => {
    const apps = toShelf ? [] : paths.filter((p) => /\.(exe|lnk)$/i.test(p))
    apps.forEach((p) => addRecord(p))
    const rest = paths.filter((p) => !apps.includes(p))
    if (rest.length) shelve(rest)
  }
  // (a4) 선반에 놓으면 펫이 상자를 잠깐 들었다가(알림 6초) 평소로 — 예전엔 선반에 파일이 있는 동안 내내 상자 자세였다
  const [shelfPing, setShelfPing] = useState<{ n: number; count: number } | null>(null)
  useEffect(() => {
    if (!shelfPing) return
    const t = setTimeout(() => setShelfPing(null), 6500)
    return () => clearTimeout(t)
  }, [shelfPing?.n])

  // v2 앱 묶음 (group:<id>) — 독에는 레코드 뒤에 모두 표시
  const [groups, setGroups] = useItems<AppGroup>('group', seedGroups)
  const saveGroup = (g: AppGroup) => setGroups((gs) => (gs.some((x) => x.id === g.id) ? gs.map((x) => (x.id === g.id ? g : x)) : [...gs, g]))

  // v2 클립보드 기록: 메모리에만 최근 20개. 실제 앱 = Rust AddClipboardFormatListener → 팔레트 창 'clips' (폴링 없음)
  const [clips, setClips] = useState<Clip[]>(isTauri ? [] : seedClips)
  useEffect(() => {
    // (a4) 최근 복사 화면은 이제 아일랜드 안 — 예전엔 팔레트·떠 있는 창만 받아서 아일랜드에서는 늘 비어 있었다
    if (!isTauri || (only !== 'palette' && only !== 'float' && only !== 'island')) return
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
  const linkView = link && link.state !== 'off' ? { connected: link.state === 'connected', peer: link.peer || linkCfg?.peer || 'Mac', files: !!filesPeer, swap, pair, xfer } : pair || xfer || swap ? { connected: !isTauri, peer: pair?.name ?? 'MacBook', files: !isTauri || !!filesPeer, swap, pair, xfer } : null
  const sendToPeer = (paths: string[]) => paths.forEach((p) => void linkSend(p).catch((e) => showAlert({ title: '보내지 못했어요', body: String(e) })))
  // 설정 저장은 store 에 비동기로 쓰인다 → 잠깐 뒤에 Rust 가 다시 읽게
  const applyLink = () => window.setTimeout(() => void linkApply(), 250)
  // (a6) 연결 묶음: 아일랜드 '연결' 화면 · 허브 점 · 설정 창이 같이 쓴다
  const linkB: LinkBundle = {
    on: linkOn, setOn: (v) => (setLinkOn(v), applyLink()), cfg: linkCfg, setCfg: (c) => (setLinkCfg(c), applyLink()), status: link, filesPeer, pairedName: peerName, pair,
    onPair: (ok) => void linkPair(ok), onImport: () => linkImport().then(setLinkCfg), onTrust: (fp) => void linkTrust(fp).catch((e) => showAlert({ title: '신뢰하지 못했어요', body: String(e) })), onUnpair: () => void linkUnpair(), xfer,
  }
  const [getShare] = useShare(linkB)
  const filesTo = getShare('files') ? filesPeer : null // 함께 쓰기 → 파일을 끄면 보내기 대상 없음

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

  const [, setPlaying] = useState<RunningSession | null>(null)
  // 알림 큐: 앞에서부터 1개씩 표시 (전체화면 뒤 밀린 알림·여러 건 동시 발화)
  const [alerts, setAlerts] = useState<Notification[]>([])
  const alert = alerts[0] ?? null
  const pushAlert = (a: Omit<Notification, 'id'>) => setAlerts((q) => (a.key && q.some((x) => x.key === a.key) ? q : [...q, { id: crypto.randomUUID(), ...a }]))
  const [peek, setPeek] = useState(false)
  const peekTimer = useRef(0)
  const showAlert = (a: AlertMsg) => (isTauri ? void sendAlert(a) : pushAlert(a))

  // (a4) 앞 앱 추적(앱 메모용 'foreground' 구독)은 메모 보드로 바뀌며 지웠다 — 앱을 바꿀 때마다 모든 창이 다시 그리던 비용도 없어짐
  useEffect(() => {
    if (!isTauri) return
    const offs = [onEvent<AlertMsg>('hera-alert', pushAlert)]
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
  const members = (r: LpRecord) => (r.kind === 'set' ? (r.targets ?? []).map((id) => records.find((x) => x.id === id)).filter((x): x is LpRecord => !!x) : [r])

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
  const [news, setNews] = useState<{ who: string; group: string; what: string; detail: string; n: number } | null>(null)
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
    return onEvent<ChatMsg>('chat-msg', showMsg)
  }, [])
  // 한 줄 알림 (터미널 완료 ✓ / 실패 ✕ · 아라로 넘기는 중 …)
  const [flash, setFlash] = useState<{ text: string; n: number; icon?: 'ok' | 'fail' | 'spin' } | null>(null)
  const flashT = useRef(0)
  const say = (text: string, icon?: 'ok' | 'fail' | 'spin', ms = 2200) => {
    setFlash((f) => ({ text, icon, n: (f?.n ?? 0) + 1 }))
    clearTimeout(flashT.current)
    flashT.current = window.setTimeout(() => setFlash(null), ms)
  }
  // 터미널: 실행 중 = 노치 초록 점 · 알약 '터미널 · 실행 중', 창을 안 보는 동안 끝나면 완료/실패
  const [termRun, setTermRun] = useState<string | null>(null)
  const hubNow = useRef({ hub: false, view: null as string | null }) // 드롭다운이 열려 있으면 알리지 않음
  const [flashTerm, setFlashTerm] = useState(false) // 지금 알림 = 터미널 완료/실패 → 누르면 드롭다운
  useEffect(() => void (!flash && setFlashTerm(false)), [flash])
  useEffect(() => {
    if (!isTauri || only !== 'island') return
    const offs = [
      onEvent<{ running: boolean; cmd: string }>('term-state', (e) => setTermRun(e.running ? e.cmd || '명령' : null)),
      onEvent<{ ok: boolean; cmd: string; ms: number; focused: boolean }>('term-done', (e) => !e.focused && e.ms >= 1000 && !(hubNow.current.hub && hubNow.current.view === 'term') && (say(`${e.ok ? '완료' : '실패'} · ${e.cmd}`, e.ok ? 'ok' : 'fail', 4000), setFlashTerm(true))),
      onEvent<{ text: string; icon?: 'ok' | 'fail' | 'spin'; ms?: number }>('island-flash', (e) => say(e.text, e.icon, e.ms)),
    ]
    return () => offs.forEach((off) => off())
  }, [])
  // 채팅 창이 열려 있으면 노치 드롭존 오른쪽 = '채팅에 보내기' (Rust float-opened/float-closed)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatGroup] = useValue<string>('chat.group', '')
  useEffect(() => {
    if (!isTauri || only !== 'island') return
    const offs = [onEvent<string>('float-opened', (f) => f === 'chat' && setChatOpen(true)), onEvent<string>('float-closed', (f) => f === 'chat' && setChatOpen(false))]
    return () => offs.forEach((off) => off())
  }, [])

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

  // (a6) 설정 창: 실제 앱 = 별도 창(Rust 가 처음 열 때 생성), 시안 = 이 페이지 안 창
  const [mockSettings, setMockSettings] = useState<string | null>(null)
  const openSettingsWin = (sec = 'general') => (isTauri ? void openSettings(sec).catch((e) => showAlert({ title: '설정을 열 수 없어요', body: String(e) })) : setMockSettings(sec))
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

  /* ── Island (a3): 모서리 펫 캡슐 · 허브 · 안의 화면 · 떼어낸 창 ── */
  const [hub, setHub] = useState(false)
  const [hubView, setHubView] = useState<ViewKind | null>(null)
  hubNow.current = { hub, view: hubView }
  const [ghost, setGhost] = useState<(Ghost & { hold?: boolean }) | null>(null)
  const [detached, setDetached] = useState<Set<string>>(new Set())
  const [magnet, setMagnet] = useState<'near' | 'hot' | null>(null)
  const [gulp, setGulp] = useState(0)
  const nextView = useRef<ViewKind | null>(null) // 흡수한 화면 = 다음에 캡슐을 누르면 그 화면
  const [snippets] = useSnippets()
  const [dragNear, setDragNear] = useState(false)
  const [mockFloats, setMockFloats] = useState<FloatKind[]>([])
  const v3 = useV3()
  // 캡슐 설정 (설정 화면): 펫 · 크기 · 위치 · 전체화면 숨김 · 알림
  const [petKey, setPetKey] = useValue('island.pet', 'cat')
  const [capSize, setCapSize] = useValue<CapSize>('island.size', 'm')
  const [place, setPlace] = useValue<'br' | 'bl'>('island.place', 'br')
  const [autohide, setAutohide] = useValue('island.autohide', true)
  const [petAlerts, setPetAlerts] = useValue('island.alerts', true)
  const prefs: IslandPrefs = { pet: petKey, size: capSize, place, autohide, alerts: petAlerts }
  const setPref = <K extends keyof IslandPrefs>(k: K, v: IslandPrefs[K]) =>
    void ({ pet: setPetKey, size: setCapSize, place: setPlace, autohide: setAutohide, alerts: setPetAlerts } as Record<keyof IslandPrefs, (x: unknown) => void>)[k](v)
  const customs = useCustomPets()
  // (a6) 펫 추가·편집은 설정 창(다른 창)에서 → 모르는 내 펫이 고르면 목록을 다시 읽는다
  useEffect(() => void (petKey.startsWith('custom:') && !customOf(petKey, customs) && refreshPets()), [petKey])
  useEffect(() => (isTauri && only === 'island' ? onEvent('pets-changed', () => void refreshPets()) : undefined), [])
  const [toastMsg, setToastMsg] = useState<{ text: string; n: number } | null>(null)
  useEffect(() => {
    if (!toastMsg) return
    const t = setTimeout(() => setToastMsg(null), 1800)
    return () => clearTimeout(t)
  }, [toastMsg?.n])
  useEffect(() => {
    if (!isTauri || only !== 'island') return
    // 실제 앱: 아일랜드 창은 클릭 통과라 바깥 클릭을 못 본다 → watch 루프가 알려 줌 · 파일을 끌고 캡슐 근처로 오면 드롭존
    const offs = [
      onEvent('island-outside', () => !ghostRef.current && setHub(false)),
      onEvent<boolean>('drag-near', setDragNear),
      // Ctrl+` = 터미널 (모서리에서 위로 640×300)
      onEvent<string>('island-open', (v) => ((VIEWS as string[]).includes(v) ? openHub(v as ViewKind) : openHub())),
      // 떼어낸 창 목록 · 흡수 (창을 머리줄로 끌어 캡슐에 놓기 · 'Island로')
      onEvent<string>('float-opened', (f) => setDetached((d) => new Set(d).add(f))),
      onEvent<string>('float-closed', (f) => setDetached((d) => ((d = new Set(d)), d.delete(f), d))),
      onEvent<{ f: string; d: number }>('absorb-near', (e) => setMagnet(e.d < 48 ? 'hot' : e.d < 160 ? 'near' : null)),
      onEvent<{ f: string; rect: [number, number, number, number] }>('absorb', (e) => void absorb(e.f as ViewKind, new DOMRect(...e.rect))),
    ]
    return () => offs.forEach((off) => off())
  }, [])
  // 허브가 접히면 키보드 포커스를 직전 앱에 돌려주고 첫 화면으로
  useEffect(() => {
    if (hub) return
    if (isTauri) void islandFocus(false)
    const t = setTimeout(() => setHubView(null), 420)
    return () => clearTimeout(t)
  }, [hub])
  useEffect(() => {
    if (!hub) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && setHub(false)
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [hub])
  useEffect(() => {
    if (!hub || isTauri) return
    const down = (e: PointerEvent) => !(e.target as Element).closest?.('.isl, .ghost, .mock-float') && setHub(false)
    addEventListener('pointerdown', down, true)
    return () => removeEventListener('pointerdown', down, true)
  }, [hub])
  const openFloat = (f: FloatKind) => (isTauri ? void floatOpen(f).catch((e) => showAlert({ title: '창을 열 수 없어요', body: String(e) })) : setMockFloats((fs) => [...fs.filter((x) => x !== f), f]))
  // 허브 열기 (v = 바로 그 화면). 떼어낸 화면이면 그 창을 앞으로.
  const openHub = (v?: ViewKind | null) => {
    const want = v ?? nextView.current
    nextView.current = null
    if (want && detachedRef.current.has(want)) return openFloat(want as FloatKind)
    setHubView(want ?? null)
    setHub(true)
    if (isTauri && want) void islandFocus(true)
  }
  const go = (k: HubKind) => {
    if (k === 'settings') return (setHub(false), openSettingsWin('general')) // (a6) 설정 = 별도 창
    if (detachedRef.current.has(k)) return (setHub(false), openFloat(k as FloatKind))
    setHubView(k)
  }
  const detachedRef = useRef(detached)
  detachedRef.current = detached

  /* ── 떼어내기 · 흡수 ──
     움직이는 동안만 아일랜드 창이 작업 영역 크기 (모서리 기준이라 내용은 그대로). 크기를 먼저 바꾸고, 진짜 창도 먼저 만든 뒤(첫 페인트까지) 움직인다:
     창 생성·큰 투명 표면 합성이 움직임과 겹치지 않는다. 다 움직이면 진짜 창을 보이고 유령을 지운다. */
  const ghostRef = useRef(ghost)
  ghostRef.current = ghost
  const tall = useRef(false)
  const goTall = async () => {
    if (!isTauri) return [0, 0] as const
    const [x0, y0] = [screenX, screenY]
    if (!tall.current) {
      tall.current = true
      const resized = new Promise<void>((r) => {
        const f = () => (removeEventListener('resize', f), r())
        addEventListener('resize', f)
        setTimeout(f, 400)
      })
      await islandTall(true)
      await resized
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return [x0 - screenX, y0 - screenY] as const
  }
  const release = () => {
    if (!isTauri || !tall.current) return
    tall.current = false
    void islandTall(false)
  }
  const skinRect = () => document.querySelector('.isl .skin')?.getBoundingClientRect() ?? new DOMRect(innerWidth - 80, innerHeight - 68, 64, 48)
  const detach = async (k: ViewKind) => {
    if (!DETACHABLE(k)) return
    if (!isTauri) {
      const [w, h] = VIEW_SIZE[k]
      const r = skinRect()
      const to = new DOMRect(Math.max(24, place === 'br' ? r.right - 360 - w - 104 : r.left + 464), Math.max(24, innerHeight - 72 - h - 40), w, h + 40)
      setMockRects((m) => ({ ...m, [k]: to }))
      setGhost({ kind: k, mode: 'detach', rect: to, capsule: r })
      setHub(false)
      return
    }
    try {
      const ready = new Promise<void>((res) => {
        const off = onEvent<string>('float-ready', (f) => f === k && (off(), res()))
        setTimeout(() => (off(), res()), 3000)
      })
      // (a4) 창 = 지금 화면이 잰 크기 (머리줄 48 → 창 머리줄 40) — 내용에 맞아 스크롤이 생기지 않는다
      const sk = skinRect()
      await floatPrepare(k as FloatKind, [Math.round(sk.width), Math.round(sk.height) - 8])
      await ready
      // 아일랜드 창 크기는 그대로 (작업 영역 크기로 키우는 비싼 합성 없음): 화면은 캡슐로 접히고, 창은 제자리에서 들어온다(창 안 transform/opacity)
      const stop = recordFrames()
      setHub(false)
      await floatShow(k as FloatKind, null)
      setTimeout(stop, 600)
    } catch (e) {
      showAlert({ title: '떼어내지 못했어요', body: String(e) })
    }
  }
  const absorb = async (k: ViewKind, rect0: DOMRect) => {
    setMagnet(null)
    const [ox, oy] = await goTall()
    const rect = new DOMRect(rect0.x + ox, rect0.y + oy, rect0.width, rect0.height)
    setGhost({ kind: k, mode: 'absorb', rect, capsule: skinRect(), hold: true })
    // 유령이 그려진 다음 프레임에 진짜 창을 파괴하고 (바꿔치기) 움직이기 시작
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (isTauri) void floatAbsorbed(k as FloatKind)
      else setMockFloats((fs) => fs.filter((x) => x !== k))
      setGhost((g) => g && { ...g, hold: false })
    }))
    nextView.current = k
  }
  const ghostDone = async (g: Ghost) => {
    if (g.mode === 'detach') {
      if (isTauri) {
        // 진짜 창이 유령과 같은 자리·그림으로 보이면(이미 그려 둠) 유령을 지운다
        await new Promise<void>((done) => {
          const off = onEvent<string>('float-shown', (f) => f === g.kind && (clearTimeout(t), off(), done()))
          const t = setTimeout(() => (off(), done()), 1500)
          void floatShow(g.kind as FloatKind, g.rect).catch(() => (clearTimeout(t), off(), done()))
        })
        await new Promise((r) => requestAnimationFrame(r))
      } else setMockFloats((fs) => [...fs.filter((x) => x !== g.kind), g.kind as FloatKind])
    } else setGulp((n) => n + 1)
    setGhost(null)
    setTimeout(() => !ghostRef.current && release(), 80)
  }
  const [mockRects, setMockRects] = useState<Record<string, DOMRect>>({})
  // (a4) 메모 = 메모 보드(떠 있는 창 float-notes)에 붙는다. '보드에 붙이기' · 새 메모 = 빈 칸에 쓰고 보드를 연다 (note.edit = 바로 편집)
  const [boardNotes, setBoardNotes] = useItems<Note>('note', seedNotes)
  const addNote = (text = '') => {
    setHub(false)
    const id = crypto.randomUUID()
    setBoardNotes((all) => [...all, { id, text, color: 0, ...freeSlot(all), w: 210, h: 140 }])
    if (isTauri) storeSet('note.edit', id)
    openFloat('notes')
  }
  const notepad = (id: string) => (isTauri ? void noteNotepad(id).catch((e) => showAlert({ title: '메모장으로 열지 못했어요', body: String(e) })) : undefined)
  const openTodos = todos.filter((t) => !t.done).length
  const [snipEdit, setSnipEdit] = useState(false) // 스니펫 화면 안 '편집' (예전 패널 '상용구' 탭)
  // (a6) LP 런처: 아일랜드 안 화면 = 떼어낸 LP 창과 같은 것
  const lpBody = () => (
    <Launcher records={records} groups={groups} onRun={run} onAddRecord={(t, n) => void addRecord(t, n)} onRemoveRecord={removeRecord} onAddSet={addSet}
      onSaveGroup={saveGroup} onRemoveGroup={(id) => setGroups((gs) => gs.filter((g) => g.id !== id))} onPlayFx={isTauri ? undefined : mockPlay} onStopFx={isTauri ? undefined : mockStop} />
  )
  const viewBody = (k: ViewKind, ghostOnly = false): ReactNode =>
    k === 'notes' ? <NotesView notes={boardNotes} onAttach={(text) => (addNote(text), say('보드에 붙였어요', 'ok'))} onBoard={() => (setHub(false), openFloat('notes'))} onNotepad={notepad} />
    : k === 'term' ? (ghostOnly ? <TermPreview /> : <TermWindow inIsland onEsc={() => setHub(false)} />)
    : k === 'snippets' && snipEdit ? <div className="snip-edit"><SnippetTab /><div className="foot"><small>어디서든 ; 로 시작</small><button className="btn ghost" onClick={() => setSnipEdit(false)}>완료</button></div></div>
    : k === 'snippets' ? (
      <>
        <div className="sect">어디서든 ; 로 시작 · 누르면 앞 앱에 붙여 넣기</div>
        {snippets.map((sn) => (
          <button key={sn.id} className="row" onClick={() => (setHub(false), isTauri ? void islandPaste(expand(sn.body)).catch((e) => showAlert({ title: '붙여넣지 못했어요', body: String(e) })) : undefined)}>
            <span className="trig">;{sn.title.slice(0, 6)}</span><span className="tt"><b>{sn.title}</b><small>{sn.body.split('\n')[0]}</small></span>
          </button>
        ))}
        <div className="foot"><small>상용구 {snippets.length}개</small><button className="btn ghost" data-snipedit onClick={() => setSnipEdit(true)}>편집</button></div>
      </>
    )
    : k === 'ocr' ? (
      <>
        <button className="ocr-cta" onClick={() => (setHub(false), isTauri ? void hubAction('ocr') : setV3({ ocr: true }))}>
          <Ico k="ocr" /><div><b>화면 글자 복사</b><small>영역을 고르면 글자를 읽어 복사해요 · Ctrl Alt T</small></div>
        </button>
        <div className="foot"><small>인식은 이 PC 에서만 (Windows OCR)</small></div>
      </>
    )
    : k === 'team' ? <div className="view-team"><TeamSection /></div>
    : k === 'link' ? <ConnectView b={linkB} onSettings={(sec) => (setHub(false), openSettingsWin(sec))} />
    : k === 'lp' ? lpBody()
    : floatBody(k as FloatKind)
  const floatBody = (f: FloatKind) =>
    f === 'todo' ? <TodoTab todos={todos} setTodos={setTodos} onAdded={peekIsland} />
    : f === 'calendar' ? <><div className="float-tools"><CalendarFilter /></div><MonthCalendar events={events} setEvents={setEvents} todos={todos} onAdded={peekIsland} /></>
    : f === 'clips' ? <ClipsList clips={clips} onCopy={copyClip} />
    : f === 'shelf' ? (
      <>
        <div className="dropz"><div><Ico k="upload" />파일을 캡슐로 끌어다 놓으세요<br /><small style={{ color: 'var(--t3)' }}>최대 4개 · 나중에 다른 앱으로 끌어 쓰기</small></div></div>
        <ShelfList files={shelf} onOpen={(x) => void launch(x.path).catch((e) => showAlert({ title: '파일을 열 수 없어요', body: String(e) }))}
          onRemove={(x) => setShelf((fs) => fs.filter((y) => y.id !== x.id))} onSend={filesTo ? (x) => sendToPeer([x.path]) : undefined} peer={filesTo ?? undefined} />
      </>
    )
    : f === 'chat' ? <ChatWindow setEvents={setEvents} onTeam={only === 'island' ? () => setHubView('team') : undefined} />
    : f === 'term' ? <TermWindow />
    : f === 'notes' ? <NoteBoard onNotepad={notepad} />
    : f === 'snippets' || f === 'ocr' || f === 'team' || f === 'link' ? viewBody(f)
    : f === 'lp' ? lpBody()
    : <p className="float-empty">준비 중이에요.</p>
  /* 캡슐 알림 = 펫 자세 + 짧은 글 (예전 알약들을 한 곳에) */
  const flashParts = flash ? ((x) => (x.length > 1 ? [x.slice(1).join(' · '), x[0]] : [flash.text, flash.icon === 'ok' ? '완료' : flash.icon === 'fail' ? '실패' : '']))(flash.text.split(' · ')) : ['', '']
  const asciiLabel = ascii.open && ascii.lp ? ascii.lp : fxPlaying ?? (!isTauri && fx && !only ? `${FX_LABEL[fx.kind]} · 화면 효과` : null)
  const stopPlaying = () => (ascii.open ? (isTauri ? void asciiStop() : setAscii((a) => ({ ...a, open: false }))) : isTauri ? void fxStop() : setFx(null))
  const pct = linkView?.xfer ? Math.round((100 * linkView.xfer.bytes) / Math.max(1, linkView.xfer.size)) : 0
  const islandAlert: Alert | null = linkView?.pair
    ? { key: 'pair', pet: 'event', b: `${linkView.pair.code.slice(0, 3)} ${linkView.pair.code.slice(3)}`, s: `${linkView.pair.name} 연결 · 양쪽 숫자가 같나요?`, sticky: true, acts: [{ label: '취소', run: () => void linkPair(false) }, { label: '같아요', primary: true, run: () => void linkPair(true) }] }
    : alert
      ? { key: alert.id, pet: 'event', b: alert.title, s: alert.body, cls: 'warn', sticky: true, onOpen: () => openHub(alert.key?.startsWith('todo:') ? 'todo' : 'calendar'), acts: [{ label: '10분 뒤', run: snooze }, { label: '완료', primary: true, run: done }] }
      : !petAlerts ? null
      : msg && !(getShare('chat') && link?.onPeer) ? { key: `msg${msg.n}`, pet: 'chat', b: msg.who, s: msg.text, onOpen: () => (setMsg(null), setChatUnread(0), openHub('chat')) }
      : flash ? { key: `flash${flash.n}`, pet: flash.icon === 'fail' ? 'fail' : flash.icon === 'ok' ? 'done' : 'typing', b: flashParts[0], s: flashParts[1], cls: flash.icon === 'fail' ? 'bad' : flash.icon === 'ok' ? 'ok' : undefined, fail: flash.icon === 'fail', onOpen: flashTerm ? () => (setFlash(null), openHub('term')) : undefined }
      : ime ? { key: `ime${ime.n}`, pet: 'idle', b: ime.source === 'ko' ? '한' : 'A', s: '입력 언어' }
      : linkView?.xfer ? { key: 'xfer', pet: linkView.xfer.done ? 'done' : 'typing', b: linkView.xfer.name, s: `${linkView.xfer.dir === 'in' ? `${linkView.peer}에서 받는 중` : `${linkView.peer}으로 보내는 중`} · ${pct}%`, cls: linkView.xfer.done ? 'ok' : undefined }
      : asciiLabel ? { key: 'ascii', pet: 'idle', b: 'LP 재생 중', s: asciiLabel, acts: [{ label: '정지', run: stopPlaying }] }
      : linkView?.swap ? { key: `swap${linkView.swap.n}`, pet: 'idle', b: linkView.swap.onPeer ? `→ ${linkView.peer}` : '← Windows', s: 'Hera Link' }
      : news ? { key: `news${news.n}`, pet: 'event', b: `${news.who}님이 ${groupOf(news.group)?.name ?? ''} ${news.what}`, s: news.detail }
      : shelfPing ? { key: `shelf${shelfPing.n}`, pet: 'shelf', b: '선반', s: `파일 ${shelfPing.count}개를 담아 뒀어요`, onOpen: () => (setShelfPing(null), openHub('shelf')) }
      : peek && next ? { key: 'peek', pet: 'event', b: next.title, s: `${next.kind === 'event' ? '일정' : '할 일'} · ${fmtWhen(next.at)}`, onOpen: () => openHub(next.kind === 'event' ? 'calendar' : 'todo') }
      : null
  const renderOpen = (k: string): ReactNode =>
    k === 'hub' ? (
      <HubHome next={next} events={events.filter((e) => e.start.slice(0, 10) === new Date().toISOString().slice(0, 10)).length} todos={{ left: openTodos, total: todos.length }} unread={chatUnread}
        weather={weather ? { city, text: weather.text, temp: weather.temp } : null} onGo={go} link={linkLook(linkB)} onPalette={() => (setHub(false), isTauri ? void hubAction('palette') : setPalette(true))} />
    ) : (
      <ViewShell k={k as ViewKind} onBack={() => (setSnipEdit(false), setHubView(null))} onDetach={() => (k === 'lp' ? (setHub(false), openFloat('lp')) : void detach(k as ViewKind))}
        extra={k === 'todo' ? <span className="chp">{todos.length - openTodos} / {todos.length}</span> : k === 'notes' ? <button className="ib" aria-label="새 메모" onClick={() => addNote()}><Ico k="plus" /></button> : k === 'link' ? <ConnectHead b={linkB} /> : null}>
        {viewBody(k as ViewKind)}
        {toastMsg && <div key={toastMsg.n} className="vtoast on" role="status">{toastMsg.text}</div>}
      </ViewShell>
    )
  const floatQ = new URLSearchParams(location.search).get('f') as FloatKind | null
  // 시안: LP 플레이어가 실제 창 대신 이 페이지에서 재생
  const mockPlay = (r: FxRec) =>
    r.kind === 'fx' ? setFx((f) => ({ kind: r.arg as FxKind, n: (f?.n ?? 0) + 1 })) : setAscii({ open: true, from: null, saver: false, scene: r.arg === 'auto' ? pickScene(clock) : (r.arg as SceneId), lp: `${r.title} · 아스키` })
  const mockStop = (r: FxRec) => (r.kind === 'fx' ? setFx(null) : setAscii((a) => ({ ...a, open: false })))

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
              <button onClick={() => (mockSettings ? setMockSettings(null) : openSettingsWin())}>설정 창</button>
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
              onSettings={() => openSettingsWin('chat')}
              onCalendar={() => openHub('calendar')}
              onNews={fireNews}
              onAlarm={() => pushAlert({ title: '배포', body: '금 14:00 시작 · 민수님이 추가한 일정', key: 'event:t1', group: 'tg-dev' })}
            />
            <V3Demo onPanel={(v) => (v === 'snippets' && setSnipEdit(true), openHub(v))} onPalette={() => setPalette(true)} />
          </aside>
          <Taskbar />
          <Ocr open={v3.ocr} onClose={() => setV3({ ocr: false })} onToast={(msg) => showAlert({ title: msg, body: '' })} />
        </>
      )}

      {show('island') && (
        <div onPointerDownCapture={() => isTauri && hub && void islandFocus(true)}>
          <Island
            place={place}
            size={capSize}
            pet={customOf(petKey, customs) ? petKey : petKey.startsWith('custom:') ? 'cat' : petKey}
            custom={customOf(petKey, customs)}
            ambient={{ unread: chatUnread, running: !!termRun }}
            alert={islandAlert}
            open={hub ? hubView ?? 'hub' : null}
            render={renderOpen}
            viewSize={(k) => (k === 'hub' ? [432, null] : FIXED_H.has(k as ViewKind) ? VIEW_SIZE[k as ViewKind] : [VIEW_SIZE[k as ViewKind][0], null])}
            onTap={() => openHub()}
            magnet={magnet}
            gulp={gulp}
            onDropFiles={(paths) => (setDragNear(false), dropFiles(paths, true))}
            forceDrop={dragNear}
            dropTo={chatOpen || (hub && hubView === 'chat') ? { label: '채팅에 보내기', onFiles: (paths) => void (isTauri && chatGroup ? chatSendPaths(chatGroup, paths).catch((e) => showAlert({ title: '보내지 못했어요', body: String(e) })) : undefined) }
              : filesTo ? { label: `${filesTo}으로 보내기`, onFiles: sendToPeer } : null}
          />
        </div>
      )}
      {show('island') && (
        <GhostLayer ghost={ghost} onDone={(g) => void ghostDone(g)}
          render={(k) => <WinChrome k={k} moving>{viewBody(k, true)}</WinChrome>} />
      )}
      {only === 'island' && <McpIsland />} {/* AI 연결(MCP) 확인 카드·칩 — Mcp.tsx */}
      {only === 'float' && floatQ && (floatQ === 'lp' ? <FloatShell f={floatQ}>{floatBody(floatQ)}</FloatShell> : <FloatWin f={floatQ}>{floatBody(floatQ)}</FloatWin>)}
      {!only && mockFloats.map((f, i) => {
        const r = mockRects[f]
        return (
          <div key={f} className="mock-float" style={r ? { left: r.left, top: r.top, width: r.width, height: r.height } : { left: 340 + i * 36, top: 90 + i * 30 }}>
            {f === 'lp' ? <FloatShell f={f} mock onClose={() => setMockFloats((fs) => fs.filter((x) => x !== f))}>{floatBody(f)}</FloatShell>
              : <FloatWin f={f} mock onClose={() => setMockFloats((fs) => fs.filter((x) => x !== f))} onAbsorb={() => void absorb(f as ViewKind, (document.querySelector(`.mock-float .win[data-kind=${f}]`) as HTMLElement).getBoundingClientRect())}>{floatBody(f)}</FloatWin>}
          </div>
        )
      })}
      {(only === 'settings' || (!only && mockSettings)) && (
        <SettingsWin
          sec={only === 'settings' ? new URLSearchParams(location.search).get('sec') : mockSettings}
          key={only === 'settings' ? 'w' : mockSettings ?? ''}
          prefs={prefs}
          setPref={setPref}
          fx={{ on: fxOn, setOn: setFxOn, city, setCity: (c) => (setCity(c), setWeatherOverride(null)), weather, now: () => playFx(pickFx(clock, weather)) }}
          idleMin={idleMin}
          setIdleMin={setIdleMin}
          link={linkB}
          onClose={isTauri ? undefined : () => setMockSettings(null)}
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
          onOpenTodo={() => (isTauri ? void islandOpen('todo') : openHub('todo'))}
          star={[...(star.app ?? []), ...(star.fx ?? [])]}
          onClose={(restore) => (isTauri ? (void closePalette(restore), setPalN((n) => n + 1)) : setPalette(false))}
          clips={clips}
          onCopy={copyClip}
          cmds={[...FX_RECORDS.filter((r) => star.fx?.includes(r.id)).map((r) => ({ key: r.id, title: `★ ${r.title}`, sub: r.kind === 'fx' ? 'LP · 화면 효과' : 'LP · 아스키 장면', run: () => (isTauri ? void (r.kind === 'fx' ? openFx(r.arg) : openAscii(null, r.arg === 'auto' ? undefined : r.arg)) : mockPlay(r)) })), ...(filesPeer && getShare('fx') ? AMBIENT.map(([label, a]) => ({ key: `amb-${label}`, title: `${filesPeer}에 ${label} 켜기`, sub: 'Hera Link · 상대 PC 화면', run: () => void linkAmbient(a).catch((e) => showAlert({ title: '보내지 못했어요', body: String(e) })) })).concat([{ key: 'amb-off', title: `${filesPeer} 화면 효과 끄기`, sub: 'Hera Link', run: () => void (linkAmbient({ kind: 'ascii', action: 'stop' }), linkAmbient({ kind: 'fx', action: 'stop' })) }]) : [])]}
        />
      )}
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

/** 효과 창: LP 플레이어에서 판을 내리면 'fx-close' → 바로 닫기 (Rust 가 3초 안전망으로 파괴) */
function FxCloser() {
  useEffect(() => onEvent('fx-close', () => void closeSelf()), [])
  return null
}


/** 아일랜드 안 '메모' (a4): 빠른 메모 → '보드에 붙이기' · 메모 카드(누르면 보드) · 메모장으로 열기 · '보드 열기' */
function NotesView({ notes, onAttach, onBoard, onNotepad }: { notes: Note[]; onAttach: (text: string) => void; onBoard: () => void; onNotepad: (id: string) => void }) {
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const list = notes.filter((n) => !q || n.text.toLowerCase().includes(q.toLowerCase()))
  const attach = () => (onAttach(text.trim()), setText(''))
  return (
    <>
      <div className="quick">
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="빠른 메모… (Ctrl+Enter = 보드에 붙이기)" rows={2} aria-label="빠른 메모"
          onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && (e.preventDefault(), attach())} />
      </div>
      {notes.length > 4 && <div className="field"><Ico k="search" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="메모 검색" /></div>}
      <div className="memos">
        {list.slice(0, 6).map((n) => {
          const [t, ...rest] = (n.text || '(빈 메모)').split('\n')
          return (
            <div key={n.id} className="memo-wrap">
              <button className="memo" style={{ '--c': NOTE_COLORS[n.color ?? 0] } as CSSProperties} onClick={onBoard}>
                <b>{t}</b><p>{rest.join('\n')}</p><small>메모 보드</small>
              </button>
              <button className="memo-np" data-notepad={n.id} aria-label={`${t} 메모장으로 열기`} onClick={() => onNotepad(n.id)}><Ico k="notes" /></button>
            </div>
          )
        })}
      </div>
      {list.length === 0 && <div className="empty">아직 메모가 없어요 — 위에 쓰고 붙여 보세요</div>}
      <div className="foot">
        <small>메모 {notes.length}개</small>
        <button className="btn ghost" data-board onClick={onBoard}>보드 열기</button>
        <button className="btn" data-attach onClick={attach}><Ico k="plus" />보드에 붙이기</button>
      </div>
    </>
  )
}
