// (a4) 할 일 날짜·시간 해석 · 기본값 · 한 칸 올리기 — 순수 함수 시험 (앱·브라우저 없음)
//   node --experimental-strip-types .omc/verify/when-test.mjs
import { chip, defaults, fmtWhen, moveStart, parseWhen, round5, segmentAt, setEnd, stepWhen, toTodo } from '../../src/data/when.ts'

let fails = 0
const ok = (what, cond, extra = '') => (console.log(`${cond ? 'PASS' : 'FAIL'} ${what} ${extra}`), cond || fails++)
const now = new Date(2026, 10, 16, 14, 2, 30) // 2026-11-16 월 14:02:30
const base = new Date(2026, 10, 16, 14, 5) // 지금 칸 값
const f = (d) => (d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : 'null')

const cases = [
  ['11/20', '2026-11-20 14:05'],
  ['11-20 14:30', '2026-11-20 14:30'],
  ['11.20 9:05', '2026-11-20 09:05'],
  ['2027-01-03', '2027-1-3 14:05'],
  ['1430', '2026-11-16 14:30'],
  ['930', '2026-11-16 09:30'],
  ['14:30', '2026-11-16 14:30'],
  ['내일', '2026-11-17 14:05'],
  ['모레 3시', '2026-11-18 15:00'], // 1~7시 = 오후
  ['내일 오전 9시', '2026-11-17 09:00'],
  ['오후 2시 10분', '2026-11-16 14:10'],
  ['오후 3시', '2026-11-16 15:00'],
  ['오전 11시 반', '2026-11-16 11:30'],
  ['3시 반', '2026-11-16 15:30'],
  ['9시', '2026-11-16 09:00'],
  ['12월 24일', '2026-12-24 14:05'],
  ['20일', '2026-11-20 14:05'],
  ['금요일', '2026-11-20 14:05'],
  ['다음주 월요일 10시', '2026-11-23 10:00'],
  ['월요일', '2026-11-16 14:05'], // 오늘이 월요일 = 오늘
  ['1/5', '2027-1-5 14:05'], // 두 달보다 지난 날 = 내년
  ['오늘 18:00', '2026-11-16 18:00'],
]
for (const [inp, want] of cases) ok(`parse "${inp}"`, f(parseWhen(inp, base, now)) === want, `→ ${f(parseWhen(inp, base, now))} (want ${want})`)
for (const bad of ['', 'abc', '13/45', '2/30', '25:00', '내일 뭐']) ok(`reject "${bad}"`, parseWhen(bad, base, now) === null)

// 기본값: 지금 → 다음 5분, 끝 = +1시간
const d = defaults(now)
ok('default start = now rounded up to 5 min (14:02:30 → 14:05)', f(d.start) === '2026-11-16 14:05')
ok('default end = start + 1h', f(d.end) === '2026-11-16 15:05' && !d.allDay)
ok('round5 keeps an exact 5-minute mark', f(round5(new Date(2026, 10, 16, 14, 5))) === '2026-11-16 14:05')
// 시작을 옮기면 끝이 같은 길이로 따라감
const w2 = moveStart({ start: d.start, end: new Date(d.start.getTime() + 90 * 60000), allDay: false }, new Date(2026, 10, 20, 9, 0))
ok('changing start shifts end with the same duration', f(w2.end) === '2026-11-20 10:30')
ok('end before start → start + 1h', f(setEnd(d, new Date(2026, 10, 1)).end) === '2026-11-16 15:05')
// 바로 고르기
ok('chip 내일 keeps the time and duration', f(chip(d, 'tomorrow', now).start) === '2026-11-17 14:05' && f(chip(d, 'tomorrow', now).end) === '2026-11-17 15:05')
const we = chip(d, 'weekend', now)
ok('chip 이번 주말 = Sat–Sun all day', f(we.start) === '2026-11-21 00:00' && f(we.end) === '2026-11-22 23:59' && we.allDay)
const td = toTodo(we)
ok('all-day saves 00:00 ~ 23:59', f(new Date(td.start)) === '2026-11-21 00:00' && f(new Date(td.due)) === '2026-11-22 23:59')
// 위/아래 화살표: 커서가 있는 칸
const txt = fmtWhen(new Date(2026, 10, 20, 14, 30))
ok('format = "11/20 14:30"', txt === '11/20 14:30', txt)
ok('caret → segment (month · day · hour · minute)', [0, 3, 7, 10].map((c) => segmentAt(txt, c)).join() === '0,1,2,3')
ok('↑ on minute = +5 min', f(stepWhen(new Date(2026, 10, 20, 14, 30), 3, 1)) === '2026-11-20 14:35')
ok('↓ on day = -1 day', f(stepWhen(new Date(2026, 10, 20, 14, 30), 1, -1)) === '2026-11-19 14:30')
ok('↑ on hour = +1 h', f(stepWhen(new Date(2026, 10, 20, 23, 30), 2, 1)) === '2026-11-21 00:30')

console.log(fails ? `\nwhen: ${fails} FAILED` : '\nwhen: ALL PASS')
process.exit(fails ? 1 : 0)
