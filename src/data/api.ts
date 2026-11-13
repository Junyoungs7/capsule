import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

// 단일 모듈: Tauri 가 있으면 invoke/이벤트, 없으면 mock + localStorage.
export const isTauri = '__TAURI_INTERNALS__' in window

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem('hera.' + key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem('hera.' + key, JSON.stringify(value))
  } catch {
    /* 저장소 꽉 참/차단 — 시안에서는 무시 */
  }
}

export function launch(target: string) {
  if (isTauri) {
    // B2: return invoke('launch', { target })
  }
  console.info('[hera] launch', target)
}

// B0-3: watch 루프가 커서 히트테스트에 쓸 모양 rect (클라이언트 기준 물리 px). 시안에서는 no-op.
export function reportHitRects(_surface: string, rects: DOMRect[]) {
  if (!isTauri) return
  const k = devicePixelRatio
  invoke('report_hit_rects', { rects: rects.map((r) => [r.x * k, r.y * k, r.width * k, r.height * k]) })
}

// 패널 창: 없으면 지연 생성, 있으면 'panel-close' → 닫힘 애니메이션 → closePanelWindow() 로 파괴
export const togglePanel = (tab: string) => invoke('toggle_panel', { tab })
export const closePanelWindow = () => invoke('close_panel')

// B0-1 ② 배경화면 페이크용 원본 바이트. 단색/없음 → null (틴트 폴백)
export const wallpaper = () =>
  Promise.all([
    invoke<ArrayBuffer>('wallpaper').then((b) => new Blob([b]), () => null),
    invoke<[string, string]>('wallpaper_style'), // [WallpaperStyle, 여백 색 "r g b"]
  ])

export function onEvent(name: string, cb: () => void) {
  const off = listen(name, cb)
  return () => void off.then((f) => f())
}
