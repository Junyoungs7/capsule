// (a4) Regression suite for the bugs found on the installed a3 — HEADLESS only (headless.mjs; never launches Hera, never real input).
//   node .omc/verify/a4-cdp.mjs
// 1 할 일 기간 고르기: 페이지 안 달력(네이티브 팝업 없음) · 고르는 동안 허브가 안 접힘(달력이 히트 rect 안) · start~due 저장
// 2 달력 음력 없음 · 3 채팅(그룹 없음)이 예전 패널 창을 띄우지 않음 · 5 선반 말풍선(토큰) · 놓은 뒤 펫이 평소로 · 6 최근 복사가 아일랜드에 보임
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('a4')
const h = await start()
let isl
const skin = () => isl.eval(`(() => { const r = document.querySelector('.isl .skin').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round) })()`)
const hubOpen = () => isl.eval(`document.querySelector('.isl').dataset.open === 'true'`)
const openView = async (k) => {
  if (!(await hubOpen())) await isl.clickSel('.isl .petbox')
  await until(hubOpen)
  if (await isl.eval(`!!document.querySelector('.isl .view')`)) await isl.clickSel('.isl .view [data-back]')
  await until(async () => (await isl.eval(`!!document.querySelector('.hub .app')`)) && (await skin())[2] === 432)
  await sleep(250)
  await isl.clickSel(`.hub .app[data-go=${k}]`)
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=${k}]')`))
  await sleep(650)
}
const close = async () => (await isl.key('Escape'), await until(async () => !(await hubOpen())), await sleep(450))
const inside = (r, s) => r[0] >= s[0] && r[1] >= s[1] && r[0] + r[2] <= s[0] + s[2] + 0.5 && r[1] + r[3] <= s[1] + s[3] + 0.5

try {
  h.handlers.clips = () => [{ id: 'c1', text: '배너 노출 기간 확인', at: Date.now() - 120000 }]
  isl = await h.open('island')
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(400)

  /* 1. 할 일 기간 */
  await openView('todo')
  ok('no native date/time/select popups anywhere in the Island', await isl.eval(`!document.querySelector('.isl input[type=date], .isl input[type=datetime-local], .isl input[type=time], .isl select')`))
  const h0 = (await skin())[3]
  await isl.clickSel('.view[data-k=todo] .when-cap')
  ok('기간 opens an in-page calendar (prototype tokens)', await until(() => isl.eval(`!!document.querySelector('.view[data-k=todo] .dr .dr-grid')`)))
  await sleep(600)
  const s1 = await skin()
  ok('the view grows to fit the calendar (no scroll)', s1[3] > h0 && (await isl.eval(`(() => { const b = document.querySelector('.view[data-k=todo] .vbody'); return b.scrollHeight - b.clientHeight <= 1 })()`)), JSON.stringify([h0, s1]))
  const dr = await isl.eval(`(() => { const r = document.querySelector('.dr').getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })()`)
  const hit = (h.hits.get('island') ?? [])[0]
  ok('root cause guard: the whole picker is inside the Island hit rect (a click on it is never "outside")', !!hit && inside(dr, hit), JSON.stringify({ dr, hit }))
  const d = new Date(), k1 = d.toLocaleDateString('sv'), d3 = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 2), k3 = d3.toLocaleDateString('sv')
  if (d3.getMonth() !== d.getMonth()) await isl.clickSel('.dr-head button[aria-label="다음 달"]'), await isl.clickSel('.dr-head button[aria-label="이전 달"]')
  await isl.clickSel(`.dr-d[data-k="${k1}"]`)
  ok('clicking a date keeps the hub open and the view the same width', (await hubOpen()) && (await skin())[2] === 380 && (await isl.eval(`!!document.querySelector('.view[data-k=todo] .dr')`)))
  if (d3.getMonth() !== d.getMonth()) await isl.clickSel('.dr-head button[aria-label="다음 달"]')
  await isl.clickSel(`.dr-d[data-k="${k3}"]`)
  await isl.eval(`[...document.querySelectorAll('.dr-chip')].find((b) => b.textContent === '18:00').click()`)
  ok('range = start … end with a time', await until(() => isl.eval(`/–/.test(document.querySelector('.when-cap').textContent) && /18:00/.test(document.querySelector('.when-cap').textContent)`)))
  await isl.eval(`[...document.querySelectorAll('.dr-chip')].find((b) => b.textContent === '확인').click()`)
  await isl.clickSel('.view[data-k=todo] .add input')
  await isl.type('배너 QA 기간')
  await isl.key('Enter')
  const todo = await (async () => { for (let t = 0; t < 3000; t += 100) { const v = [...h.store].find(([k, v]) => k.startsWith('todo:') && v?.title === '배너 QA 기간'); if (v) return v[1]; await sleep(100) } return null })()
  ok('saved as a range: start (00:00 of day 1) ~ due (day 3 18:00)', !!todo && new Date(todo.start).toLocaleDateString('sv') === k1 && new Date(todo.due).toLocaleDateString('sv') === k3 && new Date(todo.due).getHours() === 18, JSON.stringify(todo))
  ok('list shows the range', await until(() => isl.eval(`[...document.querySelectorAll('.view[data-k=todo] .list li')].some((li) => /배너 QA 기간/.test(li.textContent) && /–/.test(li.textContent))`)))
  ok('still open after picking + adding (never collapsed)', await hubOpen())

  /* 2. 달력: 음력 없음 */
  await openView('calendar')
  ok('calendar shows no lunar dates', await isl.eval(`!document.querySelector('.view[data-k=calendar] .mc-lunar') && !/음력|음 \\d/.test(document.querySelector('.view[data-k=calendar]').textContent)`))
  ok('a multi-day todo marks every day of its range', await isl.eval(`(() => { const days = [...document.querySelectorAll('.view[data-k=calendar] .mc-day')].filter((b) => b.querySelector('.mc-dots .todo')); return days.length >= 3 })()`))

  /* 3. 채팅 (그룹 없음): 예전 패널 창이 아니라 아일랜드 안 Team */
  await openView('chat')
  const n3 = h.calls.length
  await isl.clickSel('.view[data-k=chat] [data-team]')
  ok('채팅 → Team stays inside the Island', await until(() => isl.eval(`!!document.querySelector('.view[data-k=team]')`)))
  ok('…and never opens the legacy panel window', !h.calls.slice(n3).some((c) => ['toggle_panel', 'hub_action', 'float_open'].includes(c[1])), JSON.stringify(h.calls.slice(n3).map((c) => c[1])))
  await close()

  /* 6. 최근 복사 */
  await openView('clips')
  ok('최근 복사 shows the clipboard history in the Island', await until(() => isl.eval(`/배너 노출 기간 확인/.test(document.querySelector('.view[data-k=clips]').textContent)`)))
  await h.emit('clips', [{ id: 'c2', text: 'SELECT banner_id FROM banner', at: Date.now() }, { id: 'c1', text: '배너 노출 기간 확인', at: Date.now() - 120000 }])
  ok('…and updates live when you copy something', await until(() => isl.eval(`/SELECT banner_id/.test(document.querySelector('.view[data-k=clips]').textContent)`)))
  await isl.eval(`[...document.querySelectorAll('.view[data-k=clips] .float-list button')].find((b) => /SELECT/.test(b.textContent)).click()`)
  ok('…tap copies it back (set_clip)', await until(() => h.calls.some((c) => c[1] === 'set_clip' && c[2]?.text === 'SELECT banner_id FROM banner')))
  await close()

  /* 5. 선반: 놓으면 펫이 상자를 잠깐 → 평소로 · 말풍선 */
  await h.emitTo('island', 'shelf-add', 'C:\\Users\\me\\Documents\\기획서_v3.pdf')
  ok('drop → pet holds a box + "선반" pill', await until(() => isl.eval(`document.querySelector('.isl .pet').dataset.s === 'shelf' && /선반/.test(document.querySelector('.isl .ptext').textContent)`)))
  ok('…then returns to its normal pose (not stuck in the shelf pose)', await until(() => isl.eval(`document.querySelector('.isl .pet').dataset.s !== 'shelf'`), 9000))
  ok('…the file is still on the shelf', [...h.store].some(([k, v]) => k.startsWith('shelf:') && /기획서_v3/.test(v?.path ?? '')))
  await openView('shelf')
  ok('shelf rows have no native title tooltip', await isl.eval(`![...document.querySelectorAll('.view[data-k=shelf] .shelf-list [title]')].length`))
  const row = await isl.eval(`(() => { const r = document.querySelector('.view[data-k=shelf] .shelf-list li button').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  await isl.mouse('mouseMoved', row[0], row[1])
  ok('hover → styled tooltip (tokens) with the path', await until(() => isl.eval(`(() => { const t = document.querySelector('.view[data-k=shelf] .tip'); const c = getComputedStyle(t); return c.opacity === '1' && /기획서_v3/.test(t.textContent) && c.borderRadius === '10px' })()`), 2500))
  ok('no page errors', isl.errors.length === 0, isl.errors.slice(0, 2).join(' | '))
} catch (e) {
  ok('suite ran to the end', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
