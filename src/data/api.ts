// 단일 모듈: Tauri 가 있으면 invoke/store(B 단계), 없으면 mock + localStorage.
const isTauri = '__TAURI_INTERNALS__' in window

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

// B0-3: watch 루프가 커서 히트테스트에 쓸 모양 rect. 시안에서는 no-op.
export function reportHitRects(_surface: string, _rects: DOMRect[]) {}
