// Island-only (독 없음) checks on an ISOLATED-identifier build over CDP — the user's installed Hera / store are untouched:
//   npx tauri build --debug --no-bundle --config '{"identifier":"dev.hera.islandtest"}'
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'; start src-tauri\target\debug\hera.exe; node .omc/verify/island-cdp.mjs
// Never toggles '상단 공간 확보' (AppBar) — that would move the user's maximised windows. Does not type into other apps.
import { page, PORT, storeSet } from './cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pages = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((x) => x.type === 'page').map((x) => new URL(x.url).search)
const has = async (q) => (await pages()).some((s) => s.includes(q))
const inv = (cmd, args = {}) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
const get = (key) => `(async () => { const I = window.__TAURI_INTERNALS__; const rid = await I.invoke('plugin:store|get_store', { path: 'hera.json' }); const r = await I.invoke('plugin:store|get', { rid, key: ${JSON.stringify(key)} }); return Array.isArray(r) ? r[0] : r })()`
let fails = 0
const ok = (name, cond, extra = '') => (console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`), cond || fails++)
const until = async (f, ms = 5000) => {
  for (let t = 0; t < ms; t += 150) {
    if (await f()) return true
    await sleep(150)
  }
  return false
}

ok('no dock window', !(await has('surface=dock')))
const island = await page('island')

// 1. idle = 120×6 notch at the very top centre
const notch = await island.evaluate(`(() => { const r = document.querySelector('.island-shape').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: r.top, cx: Math.round(r.left + r.width / 2), vw: innerWidth, sy: screenY, mode: document.querySelector('.island').dataset.mode } })()`)
ok('idle notch is 120×6', notch.w === 120 && notch.h === 6 && notch.mode === 'idle', JSON.stringify(notch))
ok('notch at the top centre of the window', notch.top === 0 && Math.abs(notch.cx - notch.vw / 2) <= 1)

// 2. tap → hub (layout A) with 13 labelled icons + today strip + Ctrl K row
await island.evaluate(`document.querySelector('.island').click()`)
ok('hub opens on tap', await until(() => island.evaluate(`document.querySelector('.hub')?.dataset.show === 'true'`)))
const hub = await island.evaluate(`({ n: document.querySelectorAll('.hub-icon').length, labels: [...document.querySelectorAll('.hub-label')].map((x) => x.textContent), today: !!document.querySelector('.hub-today'), k: document.querySelector('.hub-k')?.textContent, pill: document.querySelector('.hubpill')?.getAttribute('aria-hidden') })`)
ok('13 labelled icons', hub.n === 13 && hub.labels.join(',') === '메모,할 일,달력,채팅,터미널,최근 복사,선반,OCR,스니펫,LP,Team,Link,설정', hub.labels.join(','))
ok('today strip + palette row', hub.today && /Ctrl/.test(hub.k ?? ''))
ok('notch grew into the pill while hub open', hub.pill === 'false')

// 3. icon → floating window (created on demand), hub collapses
await island.evaluate(`document.querySelector('.hub-icon[data-k=calendar]').click()`)
ok('calendar float window created', await until(() => has('surface=float&f=calendar')))
ok('hub collapsed after the pick', await until(() => island.evaluate(`!document.querySelector('.hub') || document.querySelector('.hub').dataset.show === 'false'`)))
const cal = await page('float&f=calendar')
ok('calendar float shows the month calendar', await until(() => cal.evaluate(`!!document.querySelector('.float .mc, .float [class*=mc-]')`), 4000))
ok('float has pin + close', await cal.evaluate(`document.querySelectorAll('.float-btn').length === 2`))
await cal.evaluate(`document.querySelector('.float-btn').click()`) // 항상 위
ok('pin remembered', await until(async () => (await island.evaluate(get('float.calendar.pin'))) === true))
await cal.evaluate(inv('float_pin', { on: false }))
await cal.evaluate(`dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
cal.close()
ok('Esc closes (window destroyed)', await until(async () => !(await has('surface=float&f=calendar'))))

// 4. remembered position: saved rect → reopened there
await island.evaluate(storeSet('float.todo', [140, 160, 420, 500]))
await island.evaluate(inv('float_open', { f: 'todo' }))
ok('todo float created', await until(() => has('surface=float&f=todo')))
const todo = await page('float&f=todo')
await sleep(400)
const pos = await todo.evaluate(`({ x: screenX, y: screenY, w: outerWidth, h: outerHeight, dpr: devicePixelRatio })`)
// 저장 = outer_position, 복원 = set_position(outer) — screenX 는 보이지 않는 크기 조절 테두리(최대 8px)만큼 다를 수 있다
ok('opened at the remembered rect', Math.abs(pos.x * pos.dpr - 140) <= 10 && Math.abs(pos.y * pos.dpr - 160) <= 10 && pos.w * pos.dpr >= 400, JSON.stringify(pos))
ok('todo float lists todos form', await todo.evaluate(`!!document.querySelector('.float .add')`))
await island.evaluate(inv('float_open', { f: 'todo' })) // 두 번째 열기 = 앞으로 (새 창 아님)
ok('second open focuses (still one window)', (await pages()).filter((s) => s.includes('f=todo')).length === 1)
void todo.evaluate(inv('float_close')) // 자기 창 파괴 → 응답 없음
todo.close()
ok('✕ destroys the window', await until(async () => !(await has('f=todo'))))

// 5. clips / shelf floats render
for (const f of ['clips', 'shelf']) {
  await island.evaluate(inv('float_open', { f }))
  ok(`${f} float created`, await until(() => has(`f=${f}`)))
  const p = await page(`float&f=${f}`)
  ok(`${f} float body`, await until(() => p.evaluate(`!!document.querySelector('.float-body')`)))
  void p.evaluate(inv('float_close'))
  p.close()
}

// 6. non-float hub actions
const shown = await island.evaluate(get('notes.shown'))
await island.evaluate(inv('hub_action', { kind: 'notes' }))
ok('메모 toggles notes.shown', await until(async () => (await island.evaluate(get('notes.shown'))) === !(shown ?? true)))
await island.evaluate(inv('hub_action', { kind: 'notes' }))
await island.evaluate(inv('hub_action', { kind: 'snippets' }))
const pal = await page('palette')
ok('스니펫 opens the palette with ";"', await until(() => pal.evaluate(`document.querySelector('.palette-input input')?.value === ';'`), 3000))
await island.evaluate(inv('close_palette', { restore: false }))
pal.close()
await island.evaluate(inv('hub_action', { kind: 'link' }))
ok('Link opens the panel at its section', await until(() => has('surface=panel')))
const panel = await page('panel')
ok('panel on settings tab', await until(() => panel.evaluate(`document.querySelector('[role=tab][aria-selected=true]')?.textContent === '설정'`), 3000))
await island.evaluate(inv('toggle_panel', { tab: 'todo' })) // 열려 있으면 닫기 (패널이 애니메이션 후 스스로 파괴)
panel.close()
ok('panel closed', await until(async () => !(await has('surface=panel')), 9000))

// 7. removed natives are gone
for (const c of ['windows_list', 'win_click', 'taskbar_lift', 'thumbs', 'dock_tall', 'shell_key', 'lp_drag']) {
  const r = await island.evaluate(`${inv(c)}.then(() => 'ok', (e) => String(e))`)
  ok(`command ${c} removed`, /not found|unknown|Command/i.test(r), r)
}

island.close()
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
process.exit(fails ? 1 : 0)
