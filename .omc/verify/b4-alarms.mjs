// B4 programmatic check against the release build (works in a locked session).
// ISOLATED build only (identifier dev.hera.islandtest — see island-cdp.mjs). node .omc/verify/b4-alarms.mjs   — backs up and restores %APPDATA%\dev.hera.islandtest\hera.json
import { execSync, spawn } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { page, storeSet } from './cdp.mjs'

const exe = 'src-tauri/target/release/hera.exe'
const file = `${process.env.APPDATA}/dev.hera.islandtest/hera.json`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (c, m) => console.log(`${c ? 'PASS' : 'FAIL'} ${m}`) || (process.exitCode ||= c ? 0 : 1)
const iso = (dt) => new Date(Date.now() + dt).toISOString()
let app
const start = async () => {
  app = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333' }, stdio: 'ignore' })
  await sleep(6000)
  return [await page('island'), await page('palette')]
}
const stop = async () => (await sleep(300), execSync(`taskkill /F /PID ${app.pid}`, { stdio: 'ignore' }), await sleep(1500)) // hard kill after the 100ms save debounce
// tray '종료' flush (save before exit) needs a tray click → manual step in b4b5-manual.ps1
const mode = (isl) => isl.evaluate(`document.querySelector('.island').dataset.mode`)
const title = (isl) => isl.evaluate(`document.querySelector('.island-layer.alert b').textContent`)
const store = () => JSON.parse(readFileSync(file, 'utf8'))

copyFileSync(file, file + '.bak')
try {
  // missed while closed: written to the file before start
  const s0 = store()
  s0['todo:missed'] = { id: 'missed', title: '놓친 할 일', due: iso(-3_600_000), done: false, source: 'local' }
  writeFileSync(file, JSON.stringify(s0))
  let [isl, dock] = await start()
  await sleep(2500)
  ok((await mode(isl)) === 'alert' && (await title(isl)) === '놓친 할 일', 'missed-while-closed alarm shown once on start')
  await isl.evaluate(`document.querySelector('.island .actions .primary').click()`)
  await sleep(300)
  ok((await mode(isl)) !== 'alert', '완료 closes the alert')
  await sleep(500)
  ok(store()['todo:missed']?.done === true, '완료 marks the todo done (store flushed)')

  // added peek from another window (palette page writes, island reacts)
  await dock.evaluate(storeSet('todo:peek', { id: 'peek', title: '미리보기', due: iso(3_600_000), done: false, source: 'local' }))
  await sleep(400)
  ok((await mode(isl)) === 'preview', `island peeks when a todo is added elsewhere`)
  await sleep(3800)

  // due now → fires within one 2s tick
  const t0 = Date.now()
  await dock.evaluate(storeSet('todo:due', { id: 'due', title: '지금 할 일', due: iso(1500), done: false, source: 'local' }))
  while ((await mode(isl)) !== 'alert' && Date.now() - t0 < 6000) await sleep(100)
  ok((await title(isl)) === '지금 할 일', `due alarm fired after ${Date.now() - t0}ms (due +1.5s, 2s tick)`)
  await isl.evaluate(`document.querySelector('.island .actions button').click()`) // 10분 뒤 다시
  await sleep(600)
  const sn = store()['todo:due']
  ok(sn?.snooze && Math.abs(new Date(sn.snooze) - Date.now() - 600_000) < 5000 && !sn.done, '다시 알림 sets snooze = now+10m')

  // event alarm + last write persisted
  await dock.evaluate(storeSet('event:ev', { id: 'ev', title: '일정', start: iso(-1000), end: iso(3_600_000), source: 'local' }))
  await sleep(2500)
  ok((await title(isl)) === '일정', 'event start alarm')
  await dock.evaluate(storeSet('todo:last', { id: 'last', title: '마지막 쓰기', done: false, source: 'local' }))
  isl.close(), dock.close()
  await stop()
  ok(!!store()['todo:last'], 'last write on disk (100ms debounce)')
  ok(['todo:missed@', 'event:ev@'].every((k) => store()['alarm.fired']?.some((f) => f.startsWith(k))), `fired set persisted, snoozed key pruned: ${JSON.stringify(store()['alarm.fired'])}`)

  // restart: nothing re-fires (fired set), snoozed todo stays quiet
  ;[isl, dock] = await start()
  await sleep(4500)
  ok((await mode(isl)) !== 'alert', 'restart does not re-fire')
  isl.close(), dock.close()
  await stop()
} finally {
  try { execSync('taskkill /IM hera.exe /F', { stdio: 'ignore' }) } catch {}
  copyFileSync(file + '.bak', file)
}
