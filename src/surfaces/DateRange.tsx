import { useState } from 'react'
import type { Todo } from '../data/types'
import { dayKey } from '../data/holidays'

/* 할 일 기간 고르기 (a4): 페이지 안에 펼쳐지는 작은 달력 — 네이티브 날짜 팝업을 쓰지 않는다.
   네이티브 datetime 팝업은 웹뷰 밖의 별도 창이라, 그 안을 누르면 아일랜드 히트 rect 밖 클릭으로 잡혀(island-outside) 허브가 접혔다.
   첫 클릭 = 시작, 두 번째 = 끝 (앞이면 바꿈). 시각 = 종일 · 09 · 12 · 18 시. 저장: start = 시작일 00:00, due = 끝 (종일이면 23:59). */

export type Range = { start: string; end: string; time: string | null } // YYYY-MM-DD, YYYY-MM-DD, 'HH:MM' | null(종일)
const DOW = ['일', '월', '화', '수', '목', '금', '토']
const TIMES = ['09:00', '12:00', '18:00']
const md = (k: string) => `${+k.slice(5, 7)}/${+k.slice(8, 10)}`

export const rangeLabel = (r: Range | null) => (!r ? '기한 없음' : `${md(r.start)}${r.end !== r.start ? ` – ${md(r.end)}` : ''}${r.time ? ` · ${r.time}` : ''}`)

/** 기간 → 할 일 필드 (start · due) */
export function toTodo(r: Range | null): Pick<Todo, 'start' | 'due'> {
  if (!r) return { start: undefined, due: undefined }
  return { start: new Date(`${r.start}T00:00`).toISOString(), due: new Date(`${r.end}T${r.time ?? '23:59'}`).toISOString() }
}

/** 목록 표시: 하루면 '오늘 18:00', 여러 날이면 '11/16 – 11/18 18:00' */
export function todoWhen(t: Pick<Todo, 'start' | 'due'>, fmt: (iso?: string) => string) {
  if (!t.due) return fmt(undefined)
  if (!t.start || dayKey(new Date(t.start)) === dayKey(new Date(t.due))) return fmt(t.due)
  const d = new Date(t.due)
  return `${md(dayKey(new Date(t.start)))} – ${md(dayKey(d))} ${d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}`
}

/** 할 일이 걸친 날들 (달력 점·목록) */
export function todoDays(t: Pick<Todo, 'start' | 'due'>): string[] {
  if (!t.due) return []
  const e = new Date(t.due)
  const out: string[] = []
  for (let d = new Date(t.start ?? t.due); dayKey(d) <= dayKey(e) && out.length < 62; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) out.push(dayKey(d))
  return out.length ? out : [dayKey(e)]
}

export function DateRange({ value, onChange, onDone }: { value: Range | null; onChange: (r: Range | null) => void; onDone: () => void }) {
  const [month, setMonth] = useState(() => {
    const d = value ? new Date(`${value.start}T00:00`) : new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [picking, setPicking] = useState<'start' | 'end'>('start')
  const today = dayKey(new Date())
  const first = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay())
  const days = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i))
  const pick = (k: string) => {
    if (picking === 'start' || !value) return onChange({ start: k, end: k, time: value?.time ?? null }), setPicking('end')
    onChange(k < value.start ? { ...value, start: k, end: value.start } : { ...value, end: k })
    setPicking('start')
  }
  return (
    <div className="dr" role="dialog" aria-label="기간 고르기">
      <div className="dr-head">
        <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="이전 달">‹</button>
        <b>{month.getFullYear()}년 {month.getMonth() + 1}월</b>
        <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="다음 달">›</button>
      </div>
      <div className="dr-grid">
        {DOW.map((d, i) => <span key={d} className="dr-dow" data-w={i}>{d}</span>)}
        {days.map((d) => {
          const k = dayKey(d)
          const inR = !!value && k >= value.start && k <= value.end
          return (
            <button type="button" key={k} className="dr-d" data-k={k} data-out={d.getMonth() !== month.getMonth()} data-today={k === today} data-w={d.getDay()}
              data-in={inR} data-edge={!!value && (k === value.start || k === value.end)} onClick={() => pick(k)}>
              {d.getDate()}
            </button>
          )
        })}
      </div>
      <div className="dr-foot">
        <span className="dr-hint">{picking === 'end' ? '끝 날짜를 고르세요 (같은 날 = 하루)' : rangeLabel(value)}</span>
        {[null, ...TIMES].map((t) => (
          <button type="button" key={t ?? 'all'} className="dr-chip" aria-pressed={!!value && value.time === t} disabled={!value} onClick={() => value && onChange({ ...value, time: t })}>{t ?? '종일'}</button>
        ))}
      </div>
      <div className="dr-foot">
        <button type="button" className="dr-chip" onClick={() => (onChange(null), setPicking('start'))}>기한 없음</button>
        <span className="dr-hint" />
        <button type="button" className="dr-chip dr-ok" onClick={onDone}>확인</button>
      </div>
    </div>
  )
}
