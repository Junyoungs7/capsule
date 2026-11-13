// Stage C release-build checks. node .omc/verify/c-perf.mjs [idle-tt|idle-hidden|palette|turntable]...
// idle-tt     : turntable shown (stopped), palette closed, no CDP — 3 min idle → private WS + 60s CPU
// idle-hidden : same with the turntable hidden (window destroyed)
// palette     : CDP. invoke('palette') (= the hotkey handler) → shown frame, ×20 open/close; WS before/after/+60s
// turntable   : CDP. drawer-open frames, drag charmap LP → platter (drop + spin-up frames), spin on while alive,
//               taskkill → spin off latency, platter activate, hit rects / window fit
// Backs up/restores hera.json (records/turntable flags are edited in the file before each start). Kills Hera at the end.
import { execSync, spawn } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { page, PORT } from './cdp.mjs'

const exe = 'src-tauri/target/release/hera.exe'
const file = `${process.env.APPDATA}/dev.hera.dock/hera.json`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CHARMAP = String.raw`C:\Windows\System32\charmap.exe`
let app
const start = async (cdp, patch) => {
  const s = JSON.parse(readFileSync(file + '.bak', 'utf8'))
  writeFileSync(file, JSON.stringify({ ...s, ...patch }))
  app = spawn(exe, [], { env: { ...process.env, ...(cdp && { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` }) }, stdio: 'ignore' })
  await sleep(6000)
}
const stop = async () => (execSync(`taskkill /F /PID ${app.pid}`, { stdio: 'ignore' }), await sleep(1500))
const memAll = () => execSync(`powershell -NoProfile -File .omc/verify/mem.ps1 -procId ${app.pid}`).toString()
const mem = () => Number(/TOTAL.*privateWS=([\d.]+) MB/.exec(memAll())[1])
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
const pctl = (a, q) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(a.length * q) - 1)]
const charmapRunning = () => execSync('tasklist /FI "IMAGENAME eq charmap.exe" /NH').toString().includes('charmap.exe')

async function idle(tt) {
  await start(false, { 'turntable.open': tt })
  for (let s = 0; s < 3; s++) await sleep(60_000), console.log(`idle ${s + 1}min: ${mem()} MB`)
  const ids = tree()
  const [c0, h0] = [cpu(ids), cpu([app.pid])]
  await sleep(60_000)
  const [c1, h1] = [cpu(ids), cpu([app.pid])]
  console.log(memAll())
  console.log(`IDLE turntable=${tt ? 'shown' : 'hidden'} 3min privateWS=${mem()} MB; CPU 60s: tree ${(((c1 - c0) / 60) * 100).toFixed(2)}% of 1 core, hera.exe ${(((h1 - h0) / 60) * 100).toFixed(2)}%`)
  await stop()
}

// rAF intervals + long tasks in page p for ms after kick (same as b5-perf / plan §7)
const frames = async (p, kick, ms) => {
  const res = p.evaluate(`new Promise((done) => {
    const d = [], long = []; let last = performance.now(); const end = last + ${ms}
    new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration))).observe({ type: 'longtask' })
    requestAnimationFrame(function f(t) { d.push(t - last); last = t; t < end ? requestAnimationFrame(f) : done({ n: d.length, ok: d.filter((x) => x <= 17).length, max: Math.max(...d), long }) })
  })`)
  await sleep(50)
  await kick()
  const r = await res
  return `${r.n} frames, ${((r.ok / r.n) * 100).toFixed(1)}% ≤17ms, max ${r.max.toFixed(1)}ms, long tasks ${r.long.length}`
}

const runs = {
  'idle-tt': () => idle(true),
  'idle-hidden': () => idle(false),

  // palette window is created hidden at startup; invoke('palette') = the Ctrl+Alt+K handler (show + focus + 'palette-open').
  // latency = dock invoke → first rAF in the palette page after it received 'palette-open' (window shown, frame produced).
  async palette() {
    await start(true, { 'turntable.open': false })
    const [dock, pal] = [await page('dock'), await page('palette')]
    await sleep(54_000)
    const base = mem()
    const lat = []
    for (let i = 0; i < 20; i++) {
      await pal.evaluate(`window.__lat = new Promise((res) => { const I = window.__TAURI_INTERNALS__
        const h = I.transformCallback(() => requestAnimationFrame(() => res(performance.timeOrigin + performance.now())), true)
        I.invoke('plugin:event|listen', { event: 'palette-open', target: { kind: 'Any' }, handler: h }) }); 1`)
      const t0 = await dock.evaluate(`(() => { const t = performance.timeOrigin + performance.now(); window.__TAURI_INTERNALS__.invoke('palette'); return t })()`)
      lat.push((await pal.evaluate('window.__lat')) - t0)
      if (i === 0) {
        await sleep(1500) // start apps load on first open
        console.log('palette open: visible =', await dock.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'palette' })`).catch((e) => String(e)),
          '| focused =', await pal.evaluate(`document.activeElement?.getAttribute('aria-label')`), '| items =', await pal.evaluate(`document.querySelectorAll('.palette-list li').length`))
        await pal.evaluate(`(() => { const i = document.querySelector('.palette-input input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'xq'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
        await pal.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await sleep(500)
        console.log('after Esc: query cleared =', await pal.evaluate(`document.querySelector('.palette-input input').value === ''`), '| hidden =', !(await dock.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'palette' })`).catch(() => true)))
        continue
      }
      await sleep(300)
      await dock.evaluate(`window.__TAURI_INTERNALS__.invoke('close_palette', { restore: false })`)
      await sleep(500)
    }
    const after0 = mem()
    await sleep(60_000)
    console.log(`PALETTE latency invoke→shown frame ms: ${lat.map((x) => x.toFixed(1)).join(',')}`)
    console.log(`PALETTE p50=${pctl(lat, 0.5).toFixed(1)} p95=${pctl(lat, 0.95).toFixed(1)} max=${Math.max(...lat).toFixed(1)} | WS baseline=${base} after20=${after0} +60s=${mem()} MB`)
    dock.close(), pal.close()
    await stop()
  },

  async turntable() {
    if (charmapRunning()) throw new Error('charmap.exe already running (user instance) — not touching it')
    await start(true, {
      'turntable.open': true,
      'record:cmap': { id: 'cmap', title: '문자표', target: CHARMAP, kind: 'single', cover: '#F59E0B', glyph: 'text' },
    })
    const tt = await page('turntable')
    const q = (sel) => tt.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
    const mouse = (type, [x, y]) => tt.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
    console.log('window', await tt.evaluate(`[innerWidth, innerHeight]`))

    const front = await q('.tt-front')
    console.log('FRAME drawer open:', await frames(tt, async () => (await mouse('mousePressed', front), await mouse('mouseReleased', front)), 800))
    await sleep(300)
    console.log('drawer fits window (clip bottom ≤ innerHeight):', await tt.evaluate(`document.querySelector('.tt-drawer-clip').getBoundingClientRect().bottom + ' ≤ ' + innerHeight`))

    const from = await q('[aria-label^="문자표 LP"] .sleeve-cover')
    const to = await q('.disc')
    const drag = async () => {
      await mouse('mousePressed', from)
      for (let i = 1; i <= 24; i++) await mouse('mouseMoved', [from[0] + ((to[0] - from[0]) * i) / 24, from[1] + ((to[1] - from[1]) * i) / 24]), await sleep(16)
      await mouse('mouseReleased', to)
    }
    console.log('FRAME drag+drop+spin-up:', await frames(tt, drag, 3000))
    console.log('playing after drop:', await tt.evaluate(`document.querySelector('.turntable').dataset.playing`))
    let alive = false
    for (let k = 0; k < 40 && !alive; k++) await sleep(250), (alive = charmapRunning())
    await sleep(3000) // running set (2s tick) picks it up
    console.log('charmap running:', alive, '| still playing after 3s:', await tt.evaluate(`document.querySelector('.turntable').dataset.playing`))
    console.log('activate(charmap):', await tt.evaluate(`window.__TAURI_INTERNALS__.invoke('activate', { keys: [${JSON.stringify(CHARMAP.toLowerCase())}] }).then(() => 'ok', (e) => 'err ' + e)`))
    console.log('activate(nothing):', await tt.evaluate(`window.__TAURI_INTERNALS__.invoke('activate', { keys: ['c:\\\\nope.exe'] }).then(() => 'ok', (e) => 'err ' + e)`))

    execSync('taskkill /IM charmap.exe /F', { stdio: 'ignore' })
    const t0 = Date.now()
    let off = -1
    while (Date.now() - t0 < 6000) {
      if ((await tt.evaluate(`document.querySelector('.turntable').dataset.playing`)) === 'false') { off = Date.now() - t0; break }
      await sleep(50)
    }
    console.log(`SPIN stop after app exit: ${off} ms (≤2500 required)`)
    await sleep(2500)
    console.log('spin animation paused:', await tt.evaluate(`document.querySelector('.disc').getAnimations().map((a) => a.playState).join(',')`))
    tt.close()
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
