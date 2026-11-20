import { useEffect, useState, type SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { load as loadStore, type Store } from '@tauri-apps/plugin-store'

// 단일 모듈: Tauri 가 있으면 invoke/스토어/이벤트, 없으면(시안) localStorage.
export const isTauri = '__TAURI_INTERNALS__' in window

/* ── 저장: Tauri = tauri-plugin-store `hera.json` 항목당 키 (note:<id>, shelf:<id>, link.cfg …). 키 목록은 docs/spec.md.
   쓰기마다 'store://change' 가 모든 창에 간다 → 다른 창의 onChange 로 따라온다. 시안 = localStorage. */
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

/** 단일 키 값 */
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

export function onEvent<T = unknown>(name: string, cb: (payload: T) => void) {
  const off = listen<T>(name, (e) => cb(e.payload))
  return () => void off.then((f) => f())
}

/* ── 클릭 통과 히트 rect: watch 루프가 커서 히트테스트에 쓸 모양 rect (클라이언트 기준 물리 px). 배율이 바뀌면 다시 보낸다. ── */
let lastRects: DOMRect[] = []
const sendRects = () => {
  const k = devicePixelRatio
  void invoke('report_hit_rects', { rects: lastRects.map((r) => [r.x * k, r.y * k, r.width * k, r.height * k]) })
}
function watchDpr() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => (sendRects(), watchDpr()), { once: true })
}
if (isTauri) watchDpr()
export function reportHitRects(rects: DOMRect[]) {
  if (!isTauri) return
  lastRects = rects
  sendRects()
}

/* ── 창 ── */
// 설정 창 (처음 열 때 생성, 닫으면 파괴). sec = general|link|deco|about, 연결 탭은 'link:devices'
export const openSettings = (sec = 'general') => invoke('settings_open', { sec })
export const autostart = (on?: boolean) => invoke<boolean>('autostart', { on })
export const closeSelf = () => invoke('close_self')
export const openFx = (kind: string) => invoke('fx', { kind })
/** 아스키 화면 지금 (모든 모니터, 입력이 있으면 닫힘) */
export const openCover = (scene: string) => invoke('cover', { scene })
/** 덮개: 모든 모니터의 덮개 창에 닫기 */
export const coverCloseAll = () => emit('ascii-close')

/* ── 선반 · 메모 ── */
export type ShelfFile = { id: string; path: string; at: number; from?: 'pc' | 'mac'; sent?: boolean }
export const shelfAdd = (paths: string[]) => invoke('shelf_add', { paths })
export const openPath = (path: string) => invoke('open_path', { path })
export const shelfFolder = () => invoke('shelf_folder')
export const boardOpen = () => invoke('board_open')
/** 메모장으로 열기 (Rust: %APPDATA%\Hera\notes\<id>.txt 에 쓰고 notepad.exe, 고치면 메모에 다시 읽어 넣음) */
export const noteNotepad = (id: string) => invoke<string>('note_notepad', { id })

/* ── Hera Link (윈도우 = 서버). 엔진 상태 'link-status', 화면 전환 'link-switch', 파일 채널 'link-files' ── */
export type LinkCfg = {
  me: string; peer: string; side: 'left' | 'right' | 'top' | 'bottom'; port: number; tls: boolean; doubleTap: boolean; filePort: number
  keymap: string; keyRows: [string, string][]; ime: string
}
export type LinkStatus = { state: 'off' | 'starting' | 'waiting' | 'connected' | 'blocked' | 'error'; detail: string; peer: string; onPeer: boolean; fingerprint: string }
export type LinkFilesEv =
  | { kind: 'peer'; state: 'pairing' | 'ready' | 'closed'; name: string; code: string }
  | { kind: 'paired'; pk: string; name: string; fp: string }
  | { kind: 'xfer'; dir: 'in' | 'out'; id: number; name: string; bytes: number; size: number }
  | { kind: 'received'; id: number; path: string }
  | { kind: 'sent'; id: number; ok: boolean; error: string }
export const linkStatus = () => invoke<[LinkStatus, string | null]>('link_status')
export const linkApply = () => invoke('link_apply')
export const linkImport = () => invoke<LinkCfg>('link_import')
export const linkTrust = (fp: string) => invoke('link_trust', { fp })
export const linkPair = (ok: boolean) => invoke('link_pair', { ok })
export const linkUnpair = () => invoke('link_unpair')
/** edge·pos = 가장자리 포탈로 보냄 (맥이 그 자리에 물결) */
export const linkSend = (path: string, edge?: string, pos?: number) => invoke('link_send', { path, edge: edge ?? null, pos: pos ?? null })
export type LinkMon = { id: string; mac: boolean; rect: [number, number, number, number]; at: [number, number, number, number] }
export type LinkSeg = { side: 'left' | 'right' | 'up' | 'down'; win: [number, number]; mac: [number, number]; edge: [number, number, number, number] }
export const linkPlan = () => invoke<[LinkMon[], { segs: LinkSeg[]; limits: string[] }]>('link_plan')
