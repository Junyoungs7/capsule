// Island-only (a2: 화면은 아일랜드 안, 떠 있는 창은 떼어낼 때만) on an ISOLATED-identifier build over CDP — the user's installed Hera / store are untouched:
//   npx tauri build --debug --no-bundle --config '{"identifier":"dev.hera.islandtest"}'
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'; start src-tauri\target\debug\hera.exe; node .omc/verify/island-cdp.mjs
// Never toggles '상단 공간 확보' (AppBar). OS window dragging (WM_MOVING) can't be driven over CDP → absorb is triggered by its event; the
// distance rule is unit-tested (float::absorb_distance_from_notch).
import { page, PORT, storeSet } from './cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pages = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((x) => x.type === 'page').map((x) => new URL(x.url).search)
const has = async (q) => (await pages()).some((s) => s.includes(q))
const inv = (cmd, args = {}) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
const emit = (event, payload) => `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: ${JSON.stringify(event)}, payload: ${JSON.stringify(payload)} })`
const get = (key) => `(async () => { const I = window.__TAURI_INTERNALS__; const rid = await I.invoke('plugin:store|get_store', { path: 'hera.json' }); const r = await I.invoke('plugin:store|get', { rid, key: ${JSON.stringify(key)} }); return Array.isArray(r) ? r[0] : r })()`
let fails = 0
const ok = (name, cond, extra = '') => (console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`), cond || fails++)
const until = async (f, ms = 5000) => {
  for (let t = 0; t < ms; t += 120) {
    if (await f()) return true
    await sleep(120)
  }
  return false
}
const frames = (p) => p.evaluate(`(() => { const f = (window.__heraFrames || []).slice(2); const s = f.slice().sort((a, b) => a - b); return { n: f.length, p95: +(s[Math.floor(f.length * 0.95)] ?? 0).toFixed(1), ok: +(f.filter((x) => x <= 17.5).length / Math.max(1, f.length)).toFixed(3) } })()`)

ok('no dock window', !(await has('surface=dock')))
const island = await page('island')
await until(() => island.evaluate(`document.querySelector('.island').dataset.mode === 'idle' && !document.querySelector('.hub')`), 8000)
await sleep(1200)

// 1. idle = 120×6 notch, window = monitor width top band
const notch = await island.evaluate(`(() => { const r = document.querySelector('.island-shape').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: r.top, cx: Math.round(r.left + r.width / 2), vw: innerWidth, sw: screen.width, sx: screenX, vh: innerHeight, mode: document.querySelector('.island').dataset.mode } })()`)
ok('idle notch is 120×6', notch.w === 120 && notch.h === 6 && notch.mode === 'idle', JSON.stringify(notch))
ok('island window = small top-centre band while idle', notch.vw <= 690 && notch.vh <= 600 && Math.abs(notch.cx - notch.vw / 2) <= 1 && Math.abs(notch.sx + notch.cx - notch.sw / 2) <= 1, JSON.stringify(notch))

// 2. tap → hub A
await island.evaluate(`document.querySelector('.island').click()`)
ok('hub opens on tap', await until(() => island.evaluate(`document.querySelector('.hub')?.dataset.show === 'true'`)))
const hub = await island.evaluate(`({ n: document.querySelectorAll('.hub-icon').length, labels: [...document.querySelectorAll('.hub-label')].map((x) => x.textContent) })`)
ok('13 labelled icons', hub.n === 13 && hub.labels.join(',') === '메모,할 일,달력,채팅,터미널,최근 복사,선반,OCR,스니펫,LP,Team,Link,설정', hub.labels.join(','))

// 3. icon → view IN PLACE (no extra window)
const before = (await pages()).length
await island.evaluate(`document.querySelector('.hub-icon[data-k=calendar]').click()`)
ok('달력 opens inside the Island', await until(() => island.evaluate(`document.querySelector('.hub')?.dataset.view === 'calendar' && !!document.querySelector('.hub [class*=mc-]')`)))
ok('no new webview for an in-Island view', (await pages()).length === before)
const vw = await island.evaluate(`document.querySelector('.hub').offsetWidth`)
ok('달력 view ≤ 480 wide', vw <= 480, `(${vw})`)
await island.evaluate(`document.querySelector('.hub-back').click()`)
ok('‹ back to the grid', await until(() => island.evaluate(`document.querySelector('.hub')?.dataset.view === 'home'`)))
await island.evaluate(`document.querySelector('.hub-icon[data-k=todo]').click()`)
ok('할 일 view in place', await until(() => island.evaluate(`!!document.querySelector('.hub[data-view=todo] .add')`)))

// 4. DETACH (button = automatic path) → hidden window prepared, shown at the ghost rect, ghost removed
await island.evaluate(`window.__heraFrames = []`)
await island.evaluate(`document.querySelector('.hub-detach').click()`)
ok('ghost appears (island goes full-screen only now)', await until(() => island.evaluate(`!!document.querySelector('.ghost') && innerHeight > 600`), 2000))
ok('detached window created', await until(() => has('f=todo'), 4000))
ok('ghost swapped for the real window', await until(() => island.evaluate(`!document.querySelector('.ghost')`), 5000))
ok('island back to the top band', await until(() => island.evaluate(`innerHeight <= 600`), 3000))
const fd = await frames(island)
ok('detach frames ≥95% ≤17ms', fd.ok >= 0.95, JSON.stringify(fd))
const todo = await page('float&f=todo')
ok('detached window visible + painted', await until(() => todo.evaluate(`document.visibilityState === 'visible' && !!document.querySelector('.float .add')`), 4000))
// 떼어낸 화면을 허브에서 누르면 = 그 창 앞으로 (아일랜드 안에 두 번 열지 않음)
await island.evaluate(`document.querySelector('.island').click()`)
await until(() => island.evaluate(`document.querySelector('.hub')?.dataset.show === 'true'`))
await island.evaluate(`document.querySelector('.hub-icon[data-k=todo]').click()`)
ok('detached view focuses its window instead', await until(() => island.evaluate(`!document.querySelector('.hub') || document.querySelector('.hub').dataset.show === 'false'`)) && (await pages()).filter((s) => s.includes('f=todo')).length === 1)

// 5. ABSORB (event from the WM_EXITSIZEMOVE hook) → ghost at the window rect → window destroyed → genie into notch → next tap shows the view
await island.evaluate(`window.__heraFrames = []`)
const wr = await todo.evaluate(`[screenX - 0, screenY, outerWidth, outerHeight]`)
await island.evaluate(emit('absorb-near', { f: 'todo', d: 40 }))
ok('magnet glow near the notch', await until(() => island.evaluate(`document.querySelector('.island').dataset.magnet === 'hot'`), 2000))
const [ix, iy] = await island.evaluate(`[screenX, screenY]`) // Rust 가 보내는 rect = 아일랜드 창 기준 CSS px
await island.evaluate(emit('absorb', { f: 'todo', rect: [wr[0] - ix, wr[1] - iy, wr[2], wr[3]] }))
ok('window destroyed on absorb', await until(async () => !(await has('f=todo')), 4000))
ok('genie finished, ghost gone', await until(() => island.evaluate(`!document.querySelector('.ghost')`), 4000))
const fa = await frames(island)
ok('absorb frames ≥95% ≤17ms', fa.ok >= 0.95, JSON.stringify(fa))
await sleep(500)
await island.evaluate(`document.querySelector('.island').click()`)
ok('tap right after = the absorbed view', await until(() => island.evaluate(`document.querySelector('.hub')?.dataset.view === 'todo'`), 3000))
await island.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await island.evaluate(`dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
ok('Esc collapses to the notch', await until(() => island.evaluate(`!document.querySelector('.hub') || document.querySelector('.hub').dataset.show === 'false'`)))

// 6. terminal drop-down (Ctrl+` → 'island-open')
await island.evaluate(emit('island-open', 'term'))
ok('Ctrl+` opens the terminal drop-down inside the Island', await until(() => island.evaluate(`document.querySelector('.hub')?.dataset.view === 'term'`)))
ok('xterm lazy-loaded inside the Island', await until(() => island.evaluate(`!!document.querySelector('.hub .xterm')`), 8000))
await sleep(900) // 크기 스프링이 끝날 때까지
const tsz = await island.evaluate(`[document.querySelector('.hub').offsetWidth, document.querySelector('.hub-vbody').offsetHeight]`)
ok('drop-down ≈ 640×300', Math.abs(tsz[0] - 640) <= 2 && Math.abs(tsz[1] - 300) <= 2, JSON.stringify(tsz))
await island.evaluate(`dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
ok('Esc folds it back (shell keeps running)', await until(() => island.evaluate(`!document.querySelector('.hub') || document.querySelector('.hub').dataset.show === 'false'`)) && (await island.evaluate(inv('term_state'))).alive)
await island.evaluate(inv('term_kill'))

// 7. other actions
const shown = await island.evaluate(get('notes.shown'))
await island.evaluate(inv('hub_action', { kind: 'notes' }))
ok('메모 toggles notes.shown', await until(async () => (await island.evaluate(get('notes.shown'))) === !(shown ?? true)))
await island.evaluate(inv('hub_action', { kind: 'notes' }))
await island.evaluate(inv('float_open', { f: 'lp' }))
ok('LP stays a desktop widget (float)', await until(() => has('f=lp')))
const lp = await page('float&f=lp')
void lp.evaluate(inv('float_close'))
lp.close()
await island.evaluate(storeSet('float.todo', [140, 160, 420, 500]))

// 8. removed natives are gone
for (const c of ['windows_list', 'win_click', 'taskbar_lift', 'thumbs', 'dock_tall', 'shell_key', 'lp_drag']) {
  const r = await island.evaluate(`${inv(c)}.then(() => 'ok', (e) => String(e))`)
  ok(`command ${c} removed`, /not found|unknown|Command/i.test(r), r)
}

island.close()
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
process.exit(fails ? 1 : 0)
