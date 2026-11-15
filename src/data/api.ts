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
      for (const r of lastRects.values()) sendRects(r)
      watchDpr()
    },
    { once: true },
  )
}
if (isTauri) watchDpr()

export function reportHitRects(surface: string, rects: DOMRect[]) {
  if (!isTauri) return
  lastRects.set(surface, rects)
  sendRects(rects)
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
// 앱 묶음 팝오버: 독 창을 위로 키우기/되돌리기
export const dockTall = (tall: boolean) => invoke('dock_tall', { tall })
// 아스키 전체화면 창 (from = 위젯의 화면 rect, 논리 px) / 효과 창 (수동 '지금 보기')
export const openAscii = (from: [number, number, number, number]) => invoke('ascii', { from })
export const openFx = (kind: string) => invoke('fx', { kind })
// 호출한 창 파괴 (패널·아스키·효과 공용 — Rust close_panel 은 호출 창을 닫는다)
export const closeSelf = () => invoke('close_panel')

/* ── 작업 표시줄 대체: 실행 중 앱 창 (Rust shell.rs 가 창 이벤트로 'windows' emit) ── */
export type Win = { hwnd: number; key: string; keys: string[]; title: string; exe: string; aumid: string; min: boolean; flash: boolean }
export const windowsList = () => invoke<Win[]>('windows_list')
// 클릭: 최소화면 복원 / 맨 앞이면 최소화 / 아니면 앞으로
export const winClick = (hwnd: number) => invoke('win_click', { hwnd })
export const winClose = (hwnd: number) => invoke('win_close', { hwnd })
// 시작 · 숨은 트레이 · 빠른 설정 · 알림 센터
export const shellKey = (kind: 'start' | 'tray' | 'quick' | 'notify') => (isTauri ? invoke('shell_key', { kind }) : Promise.resolve(console.info('[hera] key', kind)))
// 창 목록 팝오버 DWM 썸네일: [hwnd, [x, y, w, h] 독 창 기준 CSS px] → 물리 px 로 보냄. 빈 배열 = 해제
export const thumbs = (list: [number, DOMRect][]) =>
  isTauri ? invoke<number>('thumbs', { list: list.map(([h, r]) => [h, [r.x, r.y, r.width, r.height].map((v) => v * devicePixelRatio)]) }) : Promise.resolve(0)
