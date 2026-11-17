// (a7) 사용자 시험(a6 설치본)에서 나온 요청 — HEADLESS only (headless.mjs; never launches Hera, never real input).
//   node .omc/verify/a7-cdp.mjs
// 1 화면 덮개: 효과·아스키 두 종류 · 모니터마다 창 · 한 곳에서 닫으면 모두 · 무작위(직전 반복 없음 = cargo 시험)
// 2 메모 Enter = 저장 · Shift+Enter = 줄 바꿈 · 한글 조합 중 Enter 무시  3 빠른 메모 색 줄 + 기억  4 보드 FAB · 왼쪽 위 '+' 없음
// 5 할 일 날짜 칩 = 토큰 칩  6 달력: 캘린더 고르기 하나 · 잘리지 않게 열림 · 히트 rect 안 · 날짜 숫자 가운데
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('a7')
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
const rectOf = (p, sel) => p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })()`)
const inside = (r, s) => !!r && !!s && r[0] >= s[0] - 0.5 && r[1] >= s[1] - 0.5 && r[0] + r[2] <= s[0] + s[2] + 0.5 && r[1] + r[3] <= s[1] + s[3] + 0.5
const set = (k, v) => isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: ${JSON.stringify(k)}, value: ${JSON.stringify(v)} })`)
// 키 (헤드리스 페이지 안에서만): Shift+Enter · 한글 조합 중 Enter (isComposing · keyCode 229)
const shiftEnter = (p) => p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 8, windowsVirtualKeyCode: 13, text: '\r' }).then(() => p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 8, windowsVirtualKeyCode: 13 }))
const imeEnter = (p, sel) => p.eval(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })) })()`)

try {
  isl = await h.open('island')
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(400)

  /* 1. 화면 덮개 */
  const ROOT = fileURLToPath(new URL('../../src-tauri/', import.meta.url))
  let cargo = ''
  try { cargo = execFileSync('cargo', ['test', '--lib', '--quiet', 'tests::cover_'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { cargo = String(e.stdout ?? e) }
  ok('cover pick: random over all 10 scenes (4 ASCII + 6 effects), never the same twice in a row (cargo cover_picks_both_kinds_without_repeat)', /2 passed/.test(cargo), cargo.trim().split('\n').slice(-1)[0])
  ok('cover placement: one window per monitor at its physical rect (two monitors · mixed DPI · negative origin — cargo cover_one_window_per_monitor)', /2 passed/.test(cargo))
  const a0 = await h.open('ascii&saver=1&scene=snow', { label: 'ascii', geo: { x: 0, y: 0, w: 1920, h: 1080 } })
  const a1 = await h.open('ascii&saver=1&scene=snow', { label: 'ascii-1', geo: { x: -1920, y: 0, w: 1280, h: 720 } })
  ok('effect scene renders as an opaque cover (fx canvas on dark bg)', await until(() => a0.eval(`(() => { const f = document.querySelector('.ascii-full[data-cover=fx]'); return !!f && !!f.querySelector('canvas.fx') && getComputedStyle(f).backgroundColor !== 'rgba(0, 0, 0, 0)' })()`)))
  ok('…and keeps playing (no 25 s fade-out timer on a cover)', await a0.eval(`document.querySelector('canvas.fx').dataset.show === 'true'`))
  ok('second monitor window shows the cover too', await until(() => a1.eval(`!!document.querySelector('.ascii-full[data-show=true]')`)))
  const nc = h.calls.length
  await sleep(1200)
  await a1.click(400, 300) // 두 번째 모니터에서 입력
  ok('dismiss on one monitor closes the covers on every monitor', await until(() => { const c = h.calls.slice(nc).filter((x) => x[1] === 'close_self').map((x) => x[0]); return c.includes('ascii') && c.includes('ascii-1') }, 6000), JSON.stringify(h.calls.slice(nc).map((x) => x[0] + ':' + x[1])))
  const a2 = await h.open('ascii&saver=1&scene=city', { label: 'ascii', geo: { x: 0, y: 0, w: 1280, h: 720 } })
  ok('ASCII scene renders as a cover (3D text canvas)', await until(() => a2.eval(`!!document.querySelector('.ascii-full[data-cover=ascii] canvas.ascii3d')`)))
  ok('cover pages have no errors', !a0.errors.length && !a1.errors.length && !a2.errors.length, [...a0.errors, ...a1.errors, ...a2.errors].slice(0, 2).join(' | '))
  await h.closePage('ascii')

  /* 7. 작업 표시줄 시계를 누르면 Hera 도 눌리던 버그 */
  let tb = ''
  try { tb = execFileSync('cargo', ['test', '--lib', '--quiet', 'taskbar_clock'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { tb = String(e.stdout ?? e) }
  ok('taskbar clock / tray presses are never capsule presses, capsule never takes the taskbar band, a click is not a file drag (cargo taskbar_clock_is_never_a_capsule_press: 48px bar at 100/125/150%, secondary monitor)', /1 passed/.test(tb), tb.trim().split(/\r?\n/).slice(-1)[0])
  const capC = await isl.eval(`(() => { const r = document.querySelector('.isl .skin').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  await isl.mouse('mouseMoved', capC[0], capC[1])
  await until(() => isl.eval(`document.querySelector('.isl').dataset.hover === 'true'`))
  await sleep(200)
  const hr = (h.hits.get('island') ?? [])[0], ih = await isl.eval('innerHeight')
  ok('hovered capsule hit rect stays inside the window (not down into the taskbar)', !!hr && hr[1] + hr[3] <= ih + 0.5, JSON.stringify([hr, ih]))
  await isl.mouse('mouseMoved', 10, 10)
  await sleep(500)

  /* 2·3. 빠른 메모: Enter · Shift+Enter · 한글 조합 · 색 줄 */
  await set('note:m1', { id: 'm1', text: '배너 QA', color: 0, x: 16, y: 16, w: 210, h: 140 })
  await set('note:m2', { id: 'm2', text: '와이파이', color: 1, x: 248, y: 16, w: 210, h: 140 })
  await openView('notes')
  const Q = '.view[data-k=notes] .quick textarea'
  ok('quick memo has a colour row with the board palette (6)', await isl.eval(`document.querySelectorAll('.view[data-k=notes] .qcolors button').length === 6`))
  const checked = () => isl.eval(`document.querySelector('.view[data-k=notes] .qcolors [aria-checked=true]')?.getAttribute('aria-label')`)
  ok('default colour = the next one after the last note (not always yellow)', (await checked()) === '하늘', await checked())
  await isl.clickSel('.view[data-k=notes] .qcolors [aria-label="민트"]')
  ok('picking a colour is remembered (store note.color)', await until(() => h.store.get('note.color') === 3))
  await isl.clickSel(Q)
  await isl.type('첫 줄')
  await shiftEnter(isl)
  await isl.type('둘째 줄')
  ok('Shift+Enter inserts a newline (nothing saved yet)', (await isl.eval(`document.querySelector('${Q}').value`)) === '첫 줄\n둘째 줄' && ![...h.store.values()].some((v) => v?.text?.startsWith?.('첫 줄')))
  await imeEnter(isl, Q)
  await sleep(300)
  ok('Enter while composing Korean (isComposing / keyCode 229) does not save', ![...h.store.values()].some((v) => v?.text?.startsWith?.('첫 줄')) && (await isl.eval(`document.querySelector('${Q}').value`)) === '첫 줄\n둘째 줄')
  await isl.key('Enter')
  const saved = async (text) => { for (let t = 0; t < 4000; t += 100) { const v = [...h.store].find(([k, v]) => k.startsWith('note:') && v?.text === text); if (v) return v[1]; await sleep(100) } return null }
  const qn = await saved('첫 줄\n둘째 줄')
  ok('Enter saves the quick memo at once (multi-line kept)', !!qn, JSON.stringify(qn))
  ok('…in the chosen colour', qn?.color === 3, String(qn?.color))
  await until(() => h.pages.has('float-notes'), 8000)
  await h.closePage('float-notes') // 보드가 떠 있으면 허브 '메모' 는 그 창을 앞으로 가져온다
  await openView('notes')
  ok('the chosen colour is still selected next time', (await checked()) === '민트', await checked())
  await close()

  /* 4. 메모 보드: FAB · 왼쪽 위 '+' 없음 · 제자리 편집 Enter */
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('float_open', { f: 'notes' })`)
  await until(() => h.pages.has('float-notes'), 8000)
  const bd = h.pages.get('float-notes')
  await until(() => bd.eval(`document.querySelectorAll('.board .note').length >= 3`))
  await bd.eval(`document.activeElement?.blur()`)
  await sleep(300)
  ok('no add button at the top-left of a note', await bd.eval(`!document.querySelector('.note-bar [aria-label="새 메모"]')`))
  const fab = await rectOf(bd, '.board-add.fab')
  const vw = await bd.eval(`[innerWidth, innerHeight]`)
  const fabCss = await bd.eval(`(() => { const c = getComputedStyle(document.querySelector('.board-add.fab')); return [c.borderRadius, c.backgroundColor, c.position] })()`)
  ok('board has a round floating action button at the bottom-right', !!fab && Math.abs(fab[2] - fab[3]) < 1 && vw[0] - (fab[0] + fab[2]) <= 24 && vw[1] - (fab[1] + fab[3]) <= 24 && (fabCss[0] === '50%' || parseFloat(fabCss[0]) >= fab[2] / 2), JSON.stringify([fab, vw, fabCss]))
  ok('…in the token accent', fabCss[1] === 'rgb(10, 132, 255)', fabCss[1])
  const n0 = await bd.eval(`document.querySelectorAll('.board .note').length`)
  await bd.clickSel('.board-add.fab')
  ok('FAB adds a note', await until(() => bd.eval(`document.querySelectorAll('.board .note').length === ${n0 + 1}`)))
  await bd.eval(`document.activeElement?.blur()`)
  const nn = await bd.eval(`document.querySelectorAll('.board .note').length`)
  const brd = await rectOf(bd, '.board')
  await bd.click(brd[0] + 600, brd[1] + 420, 2)
  ok('double-clicking empty board space still adds a note', await until(() => bd.eval(`document.querySelectorAll('.board .note').length === ${nn + 1}`)))
  await bd.eval(`document.activeElement?.blur()`)
  await sleep(200)
  await bd.clickSel('.note[data-id=m2] .note-body')
  await until(() => bd.eval(`!!document.querySelector('.note[data-id=m2] textarea')`))
  await bd.eval(`(() => { const t = document.querySelector('.note[data-id=m2] textarea'); t.setSelectionRange(t.value.length, t.value.length) })()`)
  await shiftEnter(bd)
  await bd.type('HERA-5G')
  ok('board edit: Shift+Enter = newline', await until(() => h.store.get('note:m2')?.text === '와이파이\nHERA-5G'), JSON.stringify(h.store.get('note:m2')?.text))
  await imeEnter(bd, '.note[data-id=m2] textarea')
  await sleep(200)
  ok('board edit: Enter while composing keeps editing', await bd.eval(`!!document.querySelector('.note[data-id=m2] textarea')`))
  await bd.key('Enter')
  ok('board edit: Enter commits (leaves edit mode, text saved)', await until(() => bd.eval(`!document.querySelector('.note[data-id=m2] textarea')`)) && h.store.get('note:m2')?.text === '와이파이\nHERA-5G')
  ok('board page has no errors', bd.errors.length === 0, bd.errors.slice(0, 2).join(' | '))
  await h.closePage('float-notes')

  /* 5. 할 일 날짜 칩 */
  await openView('todo')
  await isl.clickSel('.view[data-k=todo] .add input')
  await sleep(200)
  const chips = await isl.eval(`[...document.querySelectorAll('.view[data-k=todo] .when-chips .dr-chip')].map((b) => { const c = getComputedStyle(b), r = b.getBoundingClientRect(); return { t: b.textContent.trim(), bg: c.backgroundColor, pl: parseFloat(c.paddingLeft), h: Math.round(r.height), w: Math.round(r.width), rad: c.borderRadius, on: b.getAttribute('aria-pressed'), ico: !!b.querySelector('svg') } })`)
  ok('5 chips: 오늘 · 내일 · 이번 주말 · 종일 · 달력', chips.map((c) => c.t).join('|') === '오늘|내일|이번 주말|종일|달력', chips.map((c) => c.t).join('|'))
  ok('every chip is a filled token chip (no bare text): background + padding', chips.every((c) => c.bg !== 'rgba(0, 0, 0, 0)' && c.pl >= 8), JSON.stringify(chips.map((c) => [c.t, c.bg, c.pl])))
  ok('same size: 26px high, pill radius', chips.every((c) => c.h === 26 && c.rad === '13px'), JSON.stringify(chips.map((c) => [c.h, c.rad])))
  ok('달력 chip has the calendar icon', chips.find((c) => c.t === '달력')?.ico === true)
  ok('종일 is a toggle chip (aria-pressed)', chips.find((c) => c.t === '종일')?.on !== null)
  await isl.eval(`[...document.querySelectorAll('.view[data-k=todo] .when-pick .dr-chip')].find((b) => b.textContent === '내일').click()`)
  await sleep(60)
  ok('selected date chip = accent pill wider than tall (not a dot), stretchy pill flies to it', await until(() => isl.eval(`(() => { const b = [...document.querySelectorAll('.view[data-k=todo] .when-pick .dr-chip')].find((x) => x.textContent === '내일'); const r = b.getBoundingClientRect(); return b.getAttribute('aria-pressed') === 'true' && r.width > r.height * 1.4 })()`)))
  ok('…the date chips sit in a motion-pack segment (.when-pick)', await isl.eval(`document.querySelector('.view[data-k=todo] .when-pick').matches('${'.seg, .pettabs, .navlist, .tabs2, .filters, .sizes, .when-pick'}')`))
  await isl.key('Escape').catch(() => {})
  await close().catch(() => {})

  /* 6. 달력 */
  await openView('calendar')
  const V = '.view[data-k=calendar]'
  ok('exactly one 캘린더 dropdown', await isl.eval(`[...document.querySelectorAll('${V} .gp-cap')].filter((b) => /캘린더/.test(b.textContent)).length === 1`))
  ok('…and it is in the month header', await isl.eval(`!!document.querySelector('${V} .mc-head .gp-cap[aria-haspopup=true]')`))
  ok('dropdown pill uses tokens (filled, padded)', await isl.eval(`(() => { const c = getComputedStyle(document.querySelector('${V} .mc-head .gp-cap')); return c.backgroundColor !== 'rgba(0, 0, 0, 0)' && parseFloat(c.paddingLeft) >= 6 })()`))
  await isl.clickSel(`${V} .mc-head .gp-cap`)
  await until(() => isl.eval(`!!document.querySelector('${V} .gp-pop')`))
  await sleep(700)
  const pop = await rectOf(isl, `${V} .gp-pop`), body = await rectOf(isl, `${V} .vbody`), hit = (h.hits.get('island') ?? [])[0]
  ok('filter popover opens fully inside the view (never clipped)', inside(pop, body), JSON.stringify([pop, body]))
  ok('…and inside the Island hit rect (cannot collapse the hub)', inside(pop, hit), JSON.stringify([pop, hit]))
  ok('…on top: its centre hits the popover itself', await isl.eval(`(() => { const p = document.querySelector('${V} .gp-pop'), r = p.getBoundingClientRect(); return p.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) })()`))
  ok('…token popover (opaque glass, not transparent)', await isl.eval(`(() => { const c = getComputedStyle(document.querySelector('${V} .gp-pop')); const a = c.backgroundColor.match(/[\\d.]+/g); return a && (a[3] === undefined || +a[3] > 0.8) })()`))
  await isl.clickSel(`${V} .gp-item`)
  ok('picking still works (still open, hub not collapsed)', (await hubOpen()) && (await isl.eval(`!!document.querySelector('${V} .gp-pop')`)))
  await isl.clickSel(`${V} .mc-head .gp-cap`)
  await until(() => isl.eval(`!document.querySelector('${V} .gp-pop')`))
  await isl.clickSel(`${V} .mc-add .gp-cap`)
  await until(() => isl.eval(`!!document.querySelector('${V} .gp-pop')`))
  await sleep(700)
  const pop2 = await rectOf(isl, `${V} .gp-pop`), body2 = await rectOf(isl, `${V} .vbody`)
  ok('"내 일정" dropdown: same token popover, opens where there is room, unclipped', inside(pop2, body2) && inside(pop2, (h.hits.get('island') ?? [])[0]), JSON.stringify([pop2, body2]))
  await isl.key('Escape')
  await sleep(200)
  const cen = await isl.eval(`[...document.querySelectorAll('${V} .mc-sheet:not(.out) .mc-day')].filter((d) => !d.querySelector('small')).slice(0, 42).map((d) => { const c = d.getBoundingClientRect(), b = d.querySelector('b').getBoundingClientRect(); return (b.top + b.height / 2) - (c.top + c.height / 2) })`)
  ok('day numbers are vertically centred in their cells (±1.5px)', cen.length > 20 && cen.every((d) => Math.abs(d) <= 1.5), JSON.stringify(cen.slice(0, 7).map((x) => +x.toFixed(1))))
  ok('today ring and selected fill cover the whole cell', await isl.eval(`(() => { const d = document.querySelector('${V} .mc-day[data-today=true]'); const c = getComputedStyle(d); return /inset/.test(c.boxShadow) && getComputedStyle(document.querySelector('${V} .mc-day[aria-selected=true]')).backgroundColor === 'rgb(10, 132, 255)' })()`))
  ok('no page errors', isl.errors.length === 0, isl.errors.slice(0, 2).join(' | '))
} catch (e) {
  ok('suite ran to the end', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
