// Record 는 TS 내장 타입과 겹쳐서 LpRecord 로 부른다.
export type Glyph = 'calc' | 'notepad' | 'code' | 'chrome' | 'set' | 'text'

export type LpRecord = {
  id: string
  title: string
  target: string // exe / lnk / shell:AppsFolder\AUMID / url
  kind: 'single' | 'set'
  targets?: string[] // kind:'set' → 묶인 레코드 id
  cover: string // 커버 컬러
  glyph: Glyph
  exe?: string // .lnk 의 대상 exe (추가 시 해석) — 실행 점·Now Playing 매칭용
}

export type Source = 'local' | 'google' | 'ms'

// snooze = '10분 뒤 다시' 로 미룬 알림 시각 (있으면 due/start 대신 이 시각에 알림, Rust watch 루프가 판정)
export type Todo = { id: string; title: string; due?: string; done: boolean; source: Source; externalId?: string; snooze?: string }

export type CalendarEvent = { id: string; title: string; start: string; end: string; source: Source; externalId?: string; snooze?: string }

export type Notification = { id: string; title: string; body: string; key?: string } // key = store 키 (todo:<id> / event:<id>)

// C4 파일 선반: 키 shelf:<id>, at = 넣은 시각(정렬용)
export type ShelfFile = { id: string; path: string; at: number }

export type RunningSession = { recordId: string; title: string; startedAt: number }
