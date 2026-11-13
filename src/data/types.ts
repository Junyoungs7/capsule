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
}

export type Source = 'local' | 'google' | 'ms'

export type Todo = { id: string; title: string; due?: string; done: boolean; source: Source; externalId?: string }

export type CalendarEvent = { id: string; title: string; start: string; end: string; source: Source; externalId?: string }

export type Notification = { id: string; title: string; body: string; todoId?: string }

export type RunningSession = { recordId: string; title: string; startedAt: number }
