// B5 release-build measurements. node .omc/verify/b5-perf.mjs [idle|cycles|soak|frames]...
// idle   : clean start (no CDP), 3 min idle (panel closed, dock folded) → private WS + 1 min CPU
// cycles : CDP on. baseline → panel open → 20 open/close → settle
// soak   : CDP on, 10 min: alarm fire+done, store writes/deletes, panel open/close every 30s; WS every 30s
// frames : CDP on, rAF intervals in the release webviews (dock open+magnify, island morphs)
// Backs up/restores hera.json. Kills Hera at the end.
import { execSync, spawn } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { page, storeSet } from './cdp.mjs'

const exe = 'src-tauri/target/release/hera.exe'
const file = `${process.env.APPDATA}/dev.hera.dock/hera.json`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const iso = (dt) => new Date(Date.now() + dt).toISOString()
let app
const start = async (cdp) => {
  app = spawn(exe, [], { env: { ...process.env, ...(cdp && { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333' }) }, stdio: 'ignore' })
  await sleep(6000)
}
const stop = async () => (execSync(`taskkill /F /PID ${app.pid}`, { stdio: 'ignore' }), await sleep(1500))
const mem = () => {
  const out = execSync(`powershell -NoProfile -File .omc/verify/mem.ps1 -procId ${app.pid}`).toString()
  return Number(/privateWS=([\d.]+) MB/.exec(out.split('\n').find((l) => l.startsWith('TOTAL')))[1])
}
// CPU seconds (hera.exe, whole tree incl. webview2 children)
const ps = (c) => execSync(`powershell -NoProfile -Command "${c}"`).toString()
const tree = () => {
  const all = JSON.parse(ps('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'))
  const t = [app.pid]
  for (let added = true; added; ) {
    added = false
    for (const p of all) if (t.includes(p.ParentProcessId) && !t.includes(p.ProcessId)) t.push(p.ProcessId), (added = true)
  }
  return t
}
const cpu = (ids) => ps(`(Get-Process -Id ${ids.join(',')} | Measure-Object CPU -Sum).Sum`).trim() * 1
const heraCpu = () => cpu([app.pid])
const panel = async (dock, open) => {
  await dock.evaluate(`window.__TAURI_INTERNALS__.invoke('toggle_panel', { tab: 'todo' })`)
  await sleep(open ? 1500 : 1200) // close = JS closing animation → destroy
}
const panelUp = async (dock) => dock.evaluate(`window.__TAURI_INTERNALS__.invoke('panel_open')`)

const runs = {
  async idle() {
    await start(false)
    for (let s = 0; s < 3; s++) await sleep(60_000), console.log(`idle ${s + 1}min: ${mem()} MB`)
    const ids = tree()
    const [c0, h0] = [cpu(ids), heraCpu()]
    await sleep(60_000)
    const [c1, h1] = [cpu(ids), heraCpu()]
    console.log(`IDLE 3min privateWS=${mem()} MB; CPU 60s: tree ${((c1 - c0) / 60 * 100).toFixed(2)}% of 1 core, hera.exe ${((h1 - h0) / 60 * 100).toFixed(2)}% (logical cores: ${navigator.hardwareConcurrency})`)
    await stop()
  },
  async cycles() {
    await start(true)
    const dock = await page('dock')
    await sleep(54_000)
    const base = mem()
    await panel(dock, true)
    await sleep(15_000)
    const open = mem()
    await panel(dock, false)
    for (let i = 0; i < 20; i++) await panel(dock, true), await panel(dock, false)
    const after0 = mem()
    await sleep(60_000)
    console.log(`CYCLES baseline=${base} MB panelOpen=${open} MB after20=${after0} MB after20+60s=${mem()} MB panelStillOpen=${await panelUp(dock)}`)
    dock.close()
    await stop()
  },
  async soak() {
    await start(true)
    const [dock, isl] = [await page('dock'), await page('island')]
    const t0 = Date.now()
    const samples = []
    let n = 0
    while (Date.now() - t0 < 600_000) {
      n++
      await dock.evaluate(storeSet(`todo:soak${n}`, { id: `soak${n}`, title: `soak ${n}`, due: iso(-500), done: false, source: 'local' }))
      for (let i = 0; i < 10; i++) await dock.evaluate(storeSet(`todo:w${i}`, { id: `w${i}`, title: `write ${n}.${i}`, done: false, source: 'local' }))
      await sleep(2500)
      const shown = await isl.evaluate(`document.querySelector('.island').dataset.mode === 'alert'`)
      await isl.evaluate(`document.querySelector('.island .actions .primary')?.click()`)
      await panel(dock, true), await panel(dock, false)
      if (n % 5 === 0) for (let i = 1; i <= n; i++) await dock.evaluate(`(async () => { const I = window.__TAURI_INTERNALS__; const rid = await I.invoke('plugin:store|get_store', { path: 'hera.json' }); await I.invoke('plugin:store|delete', { rid, key: 'todo:soak${i}' }) })()`)
      await sleep(Math.max(0, n * 30_000 - (Date.now() - t0)))
      samples.push(mem())
      console.log(`soak ${(Date.now() - t0) / 1000 | 0}s alarmShown=${shown} WS=${samples.at(-1)} MB`)
    }
    const growth = (samples.at(-1) / samples[0] - 1) * 100
    console.log(`SOAK samples=${samples.join(',')} first=${samples[0]} last=${samples.at(-1)} max=${Math.max(...samples)} growth=${growth.toFixed(1)}%`)
    dock.close(), isl.close()
    await stop()
  },
  async frames() {
    await start(true)
    const [dock, isl] = [await page('dock'), await page('island')]
    // rAF interval logger (same as the plan §7 console snippet) + long tasks, for `ms` after `kick`
    const measure = async (p, kick, ms) => {
      const res = p.evaluate(`new Promise((done) => {
        const d = [], long = []; let last = performance.now(); const end = last + ${ms}
        new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration))).observe({ type: 'longtask' })
        requestAnimationFrame(function f(t) { d.push(t - last); last = t; t < end ? requestAnimationFrame(f) : done({ n: d.length, ok: d.filter((x) => x <= 17.5).length, max: Math.max(...d), long }) })
      })`)
      await sleep(50)
      await kick()
      const r = await res
      return `${r.n} frames, ${((r.ok / r.n) * 100).toFixed(1)}% ≤17.5ms, max ${r.max.toFixed(1)}ms, long tasks ${r.long.length}`
    }
    const mouse = (x, y) => dock.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    console.log('FRAME dock open+magnify:', await measure(dock, async () => {
      await mouse(480, 172)
      for (let i = 0; i <= 30; i++) await mouse(300 + i * 12, 130), await sleep(20)
    }, 1500))
    console.log('FRAME dock fold:', await measure(dock, () => mouse(480, 5), 1200))
    for (let k = 0; k < 3; k++) {
      console.log(`FRAME island idle→alert #${k + 1}:`, await measure(isl, () => dock.evaluate(storeSet(`todo:fr${k}`, { id: `fr${k}`, title: 'frame', due: iso(-500), done: false, source: 'local' })), 3000))
      console.log(`FRAME island alert→idle #${k + 1}:`, await measure(isl, () => isl.evaluate(`document.querySelector('.island .actions .primary').click()`), 1000))
    }
    dock.close(), isl.close()
    await stop()
  },
}

copyFileSync(file, file + '.bak')
try {
  for (const r of process.argv.slice(2)) await runs[r]()
} finally {
  try { execSync('taskkill /IM hera.exe /F', { stdio: 'ignore' }) } catch {}
  copyFileSync(file + '.bak', file)
}
