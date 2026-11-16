/* 할 일 날짜·시간 (a4): 느슨한 입력 해석 · 기본값 · 위/아래 화살표 한 칸.
   순수 함수만 — 헤드리스·Node(--experimental-strip-types) 시험이 바로 부른다. */

export type When = { start: Date; end: Date; allDay: boolean }
const MIN = 60_000
const pad = (n: number) => String(n).padStart(2, '0')
const day0 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes())

/** 다음 5분 (14:02 → 14:05, 14:05:00 → 14:05) */
export const round5 = (d: Date) => new Date(Math.ceil(d.getTime() / (5 * MIN)) * 5 * MIN)

/** 기본값: 시작 = 지금(다음 5분), 끝 = 시작 + 1시간 */
export const defaults = (now = new Date()): When => {
  const start = round5(now)
  return { start, end: new Date(start.getTime() + 60 * MIN), allDay: false }
}

/** 보이는 모양: '11/20 14:30' (종일 = '11/20') */
export const fmtWhen = (d: Date, allDay = false) => `${d.getMonth() + 1}/${d.getDate()}${allDay ? '' : ` ${pad(d.getHours())}:${pad(d.getMinutes())}`}`
export const weekday = (d: Date) => '일월화수목금토'[d.getDay()]

const WD = '일월화수목금토'
/** 느슨한 입력 → 날짜 (못 읽으면 null). 날짜만 쓰면 base 의 시각, 시각만 쓰면 base 의 날짜.
 *  '11/20' · '11-20 14:30' · '2026-11-20' · '11월 20일' · '20일' · '1430' · '930' · '14:30' · '3시' · '3시 반' · '오전 9시' · '오후 2시 10분'
 *  '오늘' · '내일' · '모레' · '글피' · '금요일' · '다음주 월요일' · '내일 9시' · '모레 3시'. 시 앞에 오전/오후가 없고 1~7시면 오후로 본다 (일하는 시간). */
export function parseWhen(input: string, base: Date, now = new Date()): Date | null {
  let s = input.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!s) return null
  const grab = (re: RegExp) => {
    const m = s.match(re)
    if (m) s = s.replace(m[0], ' ')
    return m
  }
  const today = day0(now)
  const ymd = (y: number, mo: number, d: number) => {
    const r = new Date(y, mo - 1, d)
    return mo >= 1 && mo <= 12 && r.getMonth() === mo - 1 && r.getDate() === d ? r : null
  }
  // 연도 없이 쓴 날짜가 두 달보다 지났으면 내년
  const guessYear = (mo: number, d: number) => {
    const r = ymd(now.getFullYear(), mo, d)
    return r && today.getTime() - r.getTime() > 60 * 86_400_000 ? ymd(now.getFullYear() + 1, mo, d) : r
  }
  let date: Date | null = null
  let m: RegExpMatchArray | null
  if ((m = grab(/(오늘|내일|모레|글피)/))) date = addDays(today, { 오늘: 0, 내일: 1, 모레: 2, 글피: 3 }[m[1]]!)
  else if ((m = grab(/(다음\s?주\s?)?([월화수목금토일])요일/))) {
    const want = WD.indexOf(m[2])
    date = m[1]
      ? addDays(today, 7 - ((today.getDay() + 6) % 7) + ((want + 6) % 7)) // 다음 주(월요일 시작)의 그 요일
      : addDays(today, (want - today.getDay() + 7) % 7) // 오늘 포함 다가오는 그 요일
  } else if ((m = grab(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) date = ymd(+m[1], +m[2], +m[3])
  else if ((m = grab(/(\d{1,2})\s?월\s?(\d{1,2})\s?일/))) date = guessYear(+m[1], +m[2])
  else if ((m = grab(/(?<![\d:])(\d{1,2})[/.-](\d{1,2})(?![\d:])/))) date = guessYear(+m[1], +m[2])
  else if ((m = grab(/(?<!\d)(\d{1,2})\s?일/))) date = guessYear(today.getMonth() + 1, +m[1])
  if (m && !date) return null // 없는 날 (2/30 등)
  // 시각: 오전/오후 · 'HH:MM' · 'N시 (M분|반)' · '1430'/'930'
  const ap = grab(/(오전|오후|am|pm)/)
  const pm = !!ap && /오후|pm/.test(ap[1]), am = !!ap && /오전|am/.test(ap[1])
  const hm = (h: number, mi: number, korean: boolean): [number, number] | null => {
    if (h > 23 || mi > 59) return null
    if (pm && h < 12) h += 12
    else if (am && h === 12) h = 0
    else if (!ap && korean && h >= 1 && h <= 7) h += 12 // '3시' = 오후 3시
    return [h, mi]
  }
  let time: [number, number] | null = null
  let t: RegExpMatchArray | null
  if ((t = grab(/(\d{1,2}):(\d{2})/))) time = hm(+t[1], +t[2], false)
  else if ((t = grab(/(\d{1,2})\s?시\s?(?:(\d{1,2})\s?분|(반))?/))) time = hm(+t[1], t[3] ? 30 : +(t[2] ?? 0), true)
  else if ((t = grab(/(?<!\d)(\d{3,4})(?!\d)/))) time = hm(Math.floor(+t[1] / 100), +t[1] % 100, false)
  if ((t && !time) || s.replace(/[\s,.·]+/g, '')) return null // 읽을 수 없는 시각 · 모르는 글자
  if (!date && !time && !ap) return null
  const d = date ?? day0(base)
  const [h, mi] = time ?? [base.getHours(), base.getMinutes()]
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi)
}

/** 'M/D HH:MM' 에서 커서 자리 → 칸 (0 월 · 1 일 · 2 시 · 3 분) */
export function segmentAt(text: string, caret: number) {
  const slash = text.indexOf('/'), sp = text.indexOf(' '), colon = text.indexOf(':')
  if (caret <= slash) return 0
  if (sp < 0 || caret <= sp) return 1
  if (caret <= colon) return 2
  return 3
}

/** 한 칸 올리고 내리기 (분은 5분씩) */
export function stepWhen(d: Date, seg: number, dir: 1 | -1) {
  const r = new Date(d)
  if (seg === 0) r.setMonth(r.getMonth() + dir)
  else if (seg === 1) r.setDate(r.getDate() + dir)
  else if (seg === 2) r.setHours(r.getHours() + dir)
  else r.setMinutes(Math.round(r.getMinutes() / 5) * 5 + dir * 5)
  return r
}

/** 시작을 바꾸면 끝도 같은 길이만큼 따라간다 */
export const moveStart = (w: When, start: Date): When => ({ ...w, start, end: new Date(start.getTime() + Math.max(0, w.end.getTime() - w.start.getTime())) })
/** 끝이 시작보다 앞이면 시작 + 1시간 */
export const setEnd = (w: When, end: Date): When => ({ ...w, end: end < w.start ? new Date(w.start.getTime() + 60 * MIN) : end })

/** 바로 고르기: 오늘 · 내일 · 이번 주말 (시각은 그대로, 주말 = 토~일 종일) */
export function chip(w: When, k: 'today' | 'tomorrow' | 'weekend', now = new Date()): When {
  if (k === 'weekend') {
    const dow = now.getDay()
    const sat = addDays(day0(now), dow === 0 ? -1 : 6 - dow) // 일요일이면 어제(토)부터
    return { start: sat, end: new Date(addDays(sat, 1).getTime() + (23 * 60 + 59) * MIN), allDay: true }
  }
  const d = addDays(day0(now), k === 'today' ? 0 : 1)
  return moveStart({ ...w, allDay: false }, new Date(d.getFullYear(), d.getMonth(), d.getDate(), w.start.getHours(), w.start.getMinutes()))
}

/** 저장 값: start · due(끝 = 알림). 종일 = 첫날 00:00 ~ 끝날 23:59 */
export function toTodo(w: When) {
  if (!w.allDay) return { start: w.start.toISOString(), due: w.end.toISOString() }
  const e = day0(w.end)
  return { start: day0(w.start).toISOString(), due: new Date(e.getFullYear(), e.getMonth(), e.getDate(), 23, 59).toISOString() }
}
