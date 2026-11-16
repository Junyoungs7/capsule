// Record 는 TS 내장 타입과 겹쳐서 LpRecord 로 부른다.
export type Glyph = 'calc' | 'notepad' | 'code' | 'chrome' | 'set' | 'text' | 'ascii'

export type LpRecord = {
  id: string
  title: string
  target: string // exe / lnk / shell:AppsFolder\AUMID / url
  kind: 'single' | 'set' | 'ascii'
  targets?: string[] // kind:'set' → 묶인 레코드 id
  scene?: 'xmas' | 'city' | 'autumn' | 'calm' | 'auto' // kind:'ascii' → 아스키 장면 (auto = 계절·시간대)
  cover: string // 커버 컬러
  glyph: Glyph
  exe?: string // .lnk 의 대상 exe (추가 시 해석) — 실행 점·Now Playing 매칭용
}

export type Source = 'local' | 'google' | 'ms'

// snooze = '10분 뒤 다시' 로 미룬 알림 시각 (있으면 due/start 대신 이 시각에 알림, Rust watch 루프가 판정)
// start = 기간 시작(없으면 하루짜리 = due 날), due = 끝(마감·알림 시각)
export type Todo = { id: string; title: string; start?: string; due?: string; done: boolean; source: Source; externalId?: string; snooze?: string }

// group = Hera Team 공유 그룹 id (없으면 내 일정), by = 마지막으로 추가·수정한 그룹원 이름
export type CalendarEvent = { id: string; title: string; start: string; end: string; source: Source; externalId?: string; snooze?: string; group?: string; by?: string }

export type Notification = { id: string; title: string; body: string; key?: string; group?: string } // key = store 키 (todo:<id> / event:<id>), group = 팀 일정 알림의 그룹 id

// C4 파일 선반: 키 shelf:<id>, at = 넣은 시각(정렬용)
export type ShelfFile = { id: string; path: string; at: number }

export type RunningSession = { recordId: string; title: string; startedAt: number }

// v2: 앱 묶음(독 폴더) — 키 group:<id>, 독에는 레코드 뒤에 모두 표시
export type AppGroup = { id: string; title: string; recordIds: string[] }

// v2: 클립보드 기록 — 메모리에만(저장 안 함), 최근 20개
export type Clip = { id: string; text: string; at: number }
