import { useEffect, useState, type SetStateAction } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { load as loadStore, type Store } from '@tauri-apps/plugin-store'
import type { Clip } from './types'

// 단일 모듈: Tauri 가 있으면 invoke/스토어/이벤트, 없으면(시안) mock + localStorage.
export const isTauri = '__TAURI_INTERNALS__' in window

/* ── 저장: Tauri = tauri-plugin-store `hera.json` 항목당 키(record:<id>, todo:<id>, event:<id>, dock.pinned).
   B0-6: 스토어는 앱 단위 리소스(같은 rid)이고 쓰기마다 app.emit('store://change') → 다른 창의 onChange 로 전달된다.
   그래서 커스텀 data-changed 이벤트 없음. 시안 = localStorage(배열 통째). */
let st: Promise<Store> | undefined
const store = () => (st ??= loadStore('hera.json'))

function local<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem('hera.' + key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function saveLocal(key: string, value: unknown) {
  try {
    localStorage.setItem('hera.' + key, JSON.stringify(value))
  } catch {
    /* 저장소 꽉 참/차단 — 시안에서는 무시 */
  }
}

/** 단일 키 읽기/쓰기 (훅 밖 — 여러 창이 함께 보는 작은 상태: notes.shown 등) */
export const storeGet = <T,>(key: string) => store().then((s) => s.get<T>(key))
export const storeSet = (key: string, value: unknown) => void store().then((s) => s.set(key, value))

export function onStore(cb: (key: string, value: unknown) => void) {
  const off = store().then((s) => s.onChange(cb))
  return () => void off.then((f) => f())
}

const apply = <T,>(f: SetStateAction<T>, prev: T) => (typeof f === 'function' ? (f as (p: T) => T)(prev) : f)

/** 컬렉션(항목당 키 `<prefix>:<id>`). setter 는 이전/다음 배열을 비교해 바뀐 키만 쓰고 지운다. */
export function useItems<T extends { id: string }>(prefix: string, seed: T[]) {
  const [items, setItems] = useState<T[]>(() => (isTauri ? [] : local(prefix, seed)))
  useEffect(() => {
    if (!isTauri) return
    const p = prefix + ':'
    store()
      .then((s) => s.entries<T>())
      .then((es) => setItems(es.filter(([k]) => k.startsWith(p)).map(([, v]) => v)))
    return onStore((k, v) => {
      if (!k.startsWith(p)) return
      const id = k.slice(p.length)
      setItems((all) => (v === undefined ? all.filter((x) => x.id !== id) : all.some((x) => x.id === id) ? all.map((x) => (x.id === id ? (v as T) : x)) : [...all, v as T]))
    })
  }, [])
  const update = (f: SetStateAction<T[]>) =>
    setItems((prev) => {
      const next = apply(f, prev)
      if (!isTauri) saveLocal(prefix, next)
      else
        void store().then((s) => {
          for (const x of next) if (prev.find((o) => o.id === x.id) !== x) void s.set(`${prefix}:${x.id}`, x)
          for (const o of prev) if (!next.some((x) => x.id === o.id)) void s.delete(`${prefix}:${o.id}`)
        })
      return next
    })
  return [items, update] as const
}

/** 단일 키 값 (dock.pinned 등) */
export function useValue<T>(key: string, fallback: T) {
  const [v, setV] = useState<T>(() => (isTauri ? fallback : local(key, fallback)))
  useEffect(() => {
    if (!isTauri) return
    store()
      .then((s) => s.get<T>(key))
      .then((x) => x !== undefined && setV(x))
    return onStore((k, x) => k === key && setV((x ?? fallback) as T))
  }, [])
  const update = (f: SetStateAction<T>) =>
    setV((prev) => {
      const next = apply(f, prev)
      if (isTauri) void store().then((s) => s.set(key, next))
      else saveLocal(key, next)
      return next
    })
  return [v, update] as const
}

/* ── 실행·아이콘 ── */
export async function launch(target: string) {
  if (isTauri) return invoke<void>('launch', { target })
  console.info('[hera] launch', target)
}

const isUrl = (t: string) => /^[a-z][a-z0-9+.-]+:/i.test(t) && !/^shell:/i.test(t)
const iconCache = new Map<string, Promise<{ src: string; kind: 'app' | 'fav' } | null>>()

/** 레코드 아이콘: 앱 = Rust 추출 PNG(asset protocol), http(s) URL = favicon. 실패/시안 = null(커버 컬러 이니셜·글리프). */
export function iconFor(target: string) {
  if (!isTauri || !target) return null
  let p = iconCache.get(target)
  if (!p) {
    p = isUrl(target)
      ? Promise.resolve(/^https?:/i.test(target) ? { src: new URL(target).origin + '/favicon.ico', kind: 'fav' as const } : null)
      : invoke<string>('icon', { target }).then((path) => ({ src: convertFileSrc(path), kind: 'app' as const }), () => null)
    iconCache.set(target, p)
  }
  return p
}

/** 대상 → 기본 제목 (URL = 호스트, 경로 = 파일 이름) */
export function titleOf(target: string) {
  if (/^https?:/i.test(target)) return new URL(target).hostname.replace(/^www\./, '')
  return target.split(/[\\/]/).pop()!.replace(/\.(exe|lnk)$/i, '')
}

export const startApps = () => invoke<[string, string][]>('start_apps')

/* ── B3: 포그라운드 앱(Now Playing) · 실행 집합 ── */
export type Fg = { hwnd: number; pid: number; exePath: string; title: string; aumid: string }
export const watchState = () => invoke<[Fg | null, string[]]>('watch_state')

/* ── B4 알림: watch 루프(2s)가 due 판정 → island 창에 'alarm'. 리스너를 건 뒤 alarms_ready 로 발화 시작. ── */
export type Alarm = { key: string; title: string; at: number }
export function onAlarm(cb: (a: Alarm) => void) {
  const off = listen<Alarm>('alarm', (e) => cb(e.payload))
  void off.then(() => invoke('alarms_ready'))
  return () => void off.then((f) => f())
}

export const lnkTarget = (path: string) => invoke<string>('lnk_target', { path })

/* ── Stage C ── */
// 턴테이블 창: 보이기(+ 레코드 올리기) / 숨기기 = 창 파괴
export const setTurntable = (show: boolean, play?: string) => invoke('turntable', { show, play })
// 플래터 클릭 → 레코드 앱 창 전면 (keys = 실행 집합 키)
export const activate = (keys: string[]) => invoke('activate', { keys })
// 팔레트 창 숨기기(창은 숨김 상주, 파괴 안 함). restore = 이전 앱으로 포커스 반환
export const closePalette = (restore: boolean) => invoke('close_palette', { restore })
// 배터리 [잔량 %, 충전 중] — 배터리 없으면 null
export const power = () => invoke<[number, boolean] | null>('power')

/* ── 창 간 알림 (실행 오류 → Island alert) ── */
export type AlertMsg = { title: string; body: string }
export const sendAlert = (a: AlertMsg) => emit('hera-alert', a)

/* ── 클릭 통과 히트 rect ──
   B0-3: watch 루프가 커서 히트테스트에 쓸 모양 rect (클라이언트 기준 물리 px). 시안에서는 no-op.
   마지막 rect(CSS px)를 기억해 두고 배율(DPI)이 바뀌면 새 devicePixelRatio 로 다시 보낸다. */
const lastRects = new Map<string, DOMRect[]>()
const sendRects = (rects: DOMRect[]) => {
  const k = devicePixelRatio
  void invoke('report_hit_rects', { rects: rects.map((r) => [r.x * k, r.y * k, r.width * k, r.height * k]) })
}
function watchDpr() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      sendRects([...lastRects.values()].flat())
      watchDpr()
    },
    { once: true },
  )
}
if (isTauri) watchDpr()

export function reportHitRects(surface: string, rects: DOMRect[]) {
  if (!isTauri) return
  lastRects.set(surface, rects)
  sendRects([...lastRects.values()].flat()) // 한 창 안의 여러 표면(예: island + mcp 확인 카드) rect 합집합
}

// 패널 창: 없으면 지연 생성, 있으면 'panel-close' → 닫힘 애니메이션 → closePanelWindow() 로 파괴.
// 열림/닫힘은 Rust 가 'panel-state'(bool) 로 알린다.
export const togglePanel = (tab: string) => invoke('toggle_panel', { tab })
export const closePanelWindow = () => invoke('close_panel')
export const panelOpen = () => invoke<boolean>('panel_open')

// B0-1 ② 배경화면 페이크용 원본 바이트. 단색/없음 → null (틴트 폴백)
export const wallpaper = () =>
  Promise.all([
    invoke<ArrayBuffer>('wallpaper').then((b) => new Blob([b]), () => null),
    invoke<[string, string]>('wallpaper_style'), // [WallpaperStyle, 여백 색 "r g b"]
  ])

export function onEvent<T = unknown>(name: string, cb: (payload: T) => void) {
  const off = listen<T>(name, (e) => cb(e.payload))
  return () => void off.then((f) => f())
}

/** 선반 파일을 밖으로 끌어내기 (네이티브 OLE 드래그 시작) */
export const dragOut = (path: string) => invoke('drag_out', { path })

/* ── v2 ── */
// 클립보드 기록 (Rust 메모리에만, 변화는 팔레트 창에 'clips') / 고른 항목을 다시 클립보드에
export const clipList = () => invoke<Clip[]>('clips')
export const setClip = (text: string) => invoke('set_clip', { text })
// 아스키 전체화면 창 (from = 위젯의 화면 rect, 논리 px) / 효과 창 (수동 '지금 보기')
export const openAscii = (from: [number, number, number, number] | null, scene?: string) => invoke('ascii', { from, scene })
export const openFx = (kind: string) => invoke('fx', { kind })
// 호출한 창 파괴 (패널·아스키·효과 공용 — Rust close_panel 은 호출 창을 닫는다)
export const closeSelf = () => invoke('close_panel')

/* ── Island-only: 허브 · 떠 있는 기능 창 · 상단 공간 확보 ── */
export type FloatKind = 'todo' | 'calendar' | 'chat' | 'term' | 'clips' | 'shelf' | 'snippets' | 'team' | 'link' | 'ocr' | 'lp'
export const floatOpen = (f: FloatKind) => invoke('float_open', { f })
// 떼어내기: 유령 자리(아일랜드 CSS rect)에 만들어 첫 페인트 뒤 보이기 / 흡수: 유령을 그린 뒤 창 파괴 / 떠 있는 창: 첫 페인트 끝
export const floatShow = (f: FloatKind, r: DOMRect) => invoke('float_show', { f, rect: [r.x, r.y, r.width, r.height] })
export const floatAbsorbed = (f: FloatKind) => invoke('float_absorbed', { f })
export const floatReady = () => invoke('float_ready')
// 아일랜드 창: 애니메이션 동안 화면 높이로 · 글자 입력용 포커스 · 스니펫 붙여넣기(직전 앱으로)
export const islandTall = (on: boolean) => invoke('island_tall', { on })
export const islandFocus = (on: boolean) => invoke('island_focus', { on })
export const islandPaste = (text: string) => invoke('island_paste', { text })
export const floatClose = () => invoke('float_close')
export const floatPin = (on: boolean) => invoke('float_pin', { on })
// 떠 있는 창이 아닌 허브 아이콘: 메모(펼침 토글) · OCR · 스니펫(팔레트 ';') · Team/Link/설정(패널 섹션) · 팔레트
export const hubAction = (kind: 'notes' | 'ocr' | 'snippets' | 'team' | 'link' | 'settings' | 'palette') => invoke('hub_action', { kind })
export const appbarSet = (on: boolean) => invoke('appbar_set', { on })
export const fxStop = () => invoke('fx_stop')

/* ── Hera Link (윈도우 = 서버). 엔진 상태 'link-status', 화면 전환 'link-switch', 파일 채널 'link-files', 받은 파일 'link-received'(아일랜드) ── */
export type LinkCfg = {
  me: string; peer: string; side: 'left' | 'right' | 'top' | 'bottom'; port: number; tls: boolean; doubleTap: boolean; filePort: number
  keymap: string; keyRows: [string, string][]; ime: string; autoSaverMin: number; locator: boolean
}
export type LinkStatus = { state: 'off' | 'starting' | 'waiting' | 'connected' | 'blocked' | 'error'; detail: string; peer: string; onPeer: boolean; fingerprint: string }
export type LinkFilesEv =
  | { kind: 'peer'; state: 'pairing' | 'ready' | 'closed'; name: string; code: string }
  | { kind: 'paired'; pk: string; name: string; fp: string }
  | { kind: 'xfer'; dir: 'in' | 'out'; id: number; name: string; bytes: number; size: number }
  | { kind: 'received'; id: number; path: string }
  | { kind: 'sent'; id: number; ok: boolean; error: string }
  | { kind: 'clip'; text: string }
export const linkStatus = () => invoke<[LinkStatus, string | null]>('link_status')
export const linkApply = () => invoke('link_apply')
export const linkImport = () => invoke<LinkCfg>('link_import')
export const linkTrust = (fp: string) => invoke('link_trust', { fp })
export const linkPair = (ok: boolean) => invoke('link_pair', { ok })
export const linkUnpair = () => invoke('link_unpair')
export const linkSend = (path: string) => invoke('link_send', { path })

/* ── Hera Link 3b: 모니터 배치 · 상대 PC 분위기 ── */
export type LinkMon = { id: string; mac: boolean; rect: [number, number, number, number]; at: [number, number, number, number] }
export type LinkSeg = { side: 'left' | 'right' | 'up' | 'down'; win: [number, number]; mac: [number, number]; edge: [number, number, number, number] }
export const linkPlan = () => invoke<[LinkMon[], { segs: LinkSeg[]; limits: string[] }]>('link_plan')
export type Ambient = { kind: 'ascii' | 'saver' | 'fx'; fx?: 'snow' | 'rain' | 'leaves' | 'sunset' | 'dawn' | 'moon'; action: 'start' | 'stop' }
export const linkAmbient = (a: Ambient) => invoke('link_ambient', { kind: a.kind, fx: a.fx ?? null, action: a.action })

/* ── v3 실제 앱 연결 ── */
export const asciiStop = () => invoke('ascii_stop')
export const ocrStart = () => invoke('ocr_start')
export const ocrRegion = (r: { x: number; y: number; w: number; h: number }) => invoke<[string, string]>('ocr_region', r)
export const ocrSave = (text: string) => invoke<string>('ocr_save', { text })
export const snippetPaste = (text: string) => invoke('snippet_paste', { text })
// Hera Team
export type TeamGroupRaw = { id: string; name: string; color: string; members: { pk: string; name: string }[]; rev: number; alarms: boolean; news: boolean }
export const teamState = () => invoke<{ name: string; pk: string; groups: TeamGroupRaw[]; online?: string[] }>('team_state')
// 팀 채팅: 파일 경로로 보내기(채팅 창 네이티브 드롭) · '+' 로 고른 파일 바이트 · 파일을 클립보드에 · 선반에
export const chatSendPaths = (group: string, paths: string[]) => invoke<string[]>('chat_send_paths', { group, paths })
export const chatAttach = async (group: string, f: File) =>
  invoke<string>('chat_attach', new Uint8Array(await f.arrayBuffer()), { headers: { 'x-group': group, 'x-name': encodeURIComponent(f.name) } })
export const clipFiles = (paths: string[]) => invoke('clip_files', { paths })
export const shelfAdd = (path: string) => invoke('shelf_add', { path })
export const fileSrc = (path: string) => convertFileSrc(path)
/** store 의 `<prefix><키>` → 값 (항목이 {id} 객체가 아닌 것: chatin:<fid> = 경로). 실제 앱만, 시안 = 빈 객체 */
export function usePrefix<T>(prefix: string): Record<string, T> {
  const [m, setM] = useState<Record<string, T>>({})
  useEffect(() => {
    if (!isTauri) return
    void store().then((s) => s.entries<T>()).then((es) => setM(Object.fromEntries(es.filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]))))
    return onStore((k, v) => k.startsWith(prefix) && setM((x) => { const n = { ...x }; if (v === undefined) delete n[k.slice(prefix.length)]; else n[k.slice(prefix.length)] = v as T; return n }))
  }, [])
  return m
}
export const teamCreate = (name: string, color: string) => invoke<TeamGroupRaw>('team_create', { name, color })
export const teamInvite = (group: string) => invoke<[string, string]>('team_invite', { group })
export const teamJoin = (input: string) => invoke('team_join', { input })
export const teamFlags = (group: string, alarms: boolean, news: boolean) => invoke('team_flags', { group, alarms, news })
export const teamName = (name: string) => invoke('team_name', { name })
