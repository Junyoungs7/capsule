// Taskbar-replacement checks on the release app over CDP (works while locked; touches only a Notepad it starts itself).
// Start Hera with $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333', then: node .omc/verify/taskbar-cdp.mjs
import { spawn } from 'node:child_process'
import { page } from './cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const inv = (cmd, args = {}) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
const ok = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`)
const notepad = (ws) => ws.filter((w) => /notepad/i.test(w.key))

const dock = await page('dock')
// 'windows' 이벤트를 페이지에서 기록 (폴링 아님 — Rust 가 바뀔 때만 보낸다)
await dock.evaluate(`(window.__ev = 0, window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'windows', target: { kind: 'Any' }, handler: window.__TAURI_INTERNALS__.transformCallback(() => window.__ev++) }))`)
const before = await dock.evaluate(inv('windows_list'))
ok('windows_list', Array.isArray(before), `(${before.length} app windows)`)
ok('dock width follows work area', (await dock.evaluate('innerWidth')) > 960, `(innerWidth ${await dock.evaluate('innerWidth')})`)
const lift = await dock.evaluate(inv('taskbar_lift'))
ok('taskbar_lift (auto-hide coexist)', Number.isInteger(lift) && lift >= 0, `(${lift}px now)`)
const known = new Set(notepad(before).map((w) => w.hwnd))

spawn('notepad.exe', { detached: true, stdio: 'ignore' }).unref()
let mine
for (let i = 0; i < 20 && !mine; i++) {
  await sleep(500)
  mine = notepad(await dock.evaluate(inv('windows_list'))).find((w) => !known.has(w.hwnd))
}
ok('new window appears via events', !!mine, mine ? `(${mine.title} · key ${mine.key})` : '')
ok("'windows' event emitted", (await dock.evaluate('window.__ev')) > 0, `(${await dock.evaluate('window.__ev')} events)`)
if (mine) {
  ok('running app slot rendered', (await dock.evaluate(`document.querySelectorAll('.run-app').length`)) > 0)
  const n = await dock.evaluate(inv('thumbs', { list: [[mine.hwnd, [0, 0, 160, 100]]] }))
  ok('DWM thumbnail registered', n === 1, `(${n})`)
  await dock.evaluate(inv('thumbs', { list: [] }))
  await dock.evaluate(inv('win_close', { hwnd: mine.hwnd }))
  let gone = false
  for (let i = 0; i < 10 && !gone; i++) {
    await sleep(300)
    gone = !(await dock.evaluate(inv('windows_list'))).some((w) => w.hwnd === mine.hwnd)
  }
  ok('closed window disappears via events', gone)
}
dock.close()
