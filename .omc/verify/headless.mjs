// Headless UI harness (a3). NEVER launches Hera and NEVER touches the real mouse/keyboard/cursor or focus:
//   Vite dev server (own port) + headless Chrome (--headless=new, throwaway profile) + a mocked Tauri IPC shared by all "windows".
//   Input = CDP Input.dispatchMouseEvent / dispatchKeyEvent inside the headless page only.
//   Rust behaviour is emulated just enough for the UI paths (store, events, island_tall geometry + hit-rect shift, float windows);
//   the Rust logic itself is covered by `cargo test`.
// usage: import { start } from './headless.mjs'; const h = await start(); const isl = await h.open('island'); …; await h.close()
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dbg = (m) => process.env.HERA_DEBUG && console.log('[h]', m)
export const WA = { w: 1920, h: 1032 } // 가짜 작업 영역 (작업 표시줄 48)
export const ISL = { w: 680, h: 680 }
// Rust float.rs FEATURES (화면 + 머리줄 40) · default_pos
const FEAT = { notes: [380, 440], todo: [380, 460], calendar: [480, 460], chat: [400, 520], term: [640, 340], clips: [380, 440], shelf: [360, 380], snippets: [380, 440], team: [400, 480], link: [380, 400], ocr: [360, 340], lp: [340, 488] }

const MOCK = `(() => {
  const q = new URLSearchParams(location.search)
  const label = q.get('surface') === 'float' ? 'float-' + q.get('f') : (q.get('surface') || 'main')
  let seq = 0
  const cbs = new Map(), pending = new Map()
  window.__heraCalls = []
  window.__heraGeo = window.__heraGeo || { x: 0, y: 0 }
  Object.defineProperty(window, 'screenX', { get: () => window.__heraGeo.x, configurable: true })
  Object.defineProperty(window, 'screenY', { get: () => window.__heraGeo.y, configurable: true })
  window.__heraResolve = (id, ok, v) => { const p = pending.get(id); pending.delete(id); p && (ok ? p[0](v) : p[1](v)) }
  window.__heraEvent = (cb, ev) => cbs.get(cb)?.(ev)
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s) }
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label }, currentWebview: { label, windowLabel: label } },
    transformCallback(cb, once) { const id = ++seq; cbs.set(id, once ? (x) => (cbs.delete(id), cb(x)) : cb); return id },
    unregisterCallback(id) { cbs.delete(id) },
    convertFileSrc(p) { return p },
    invoke(cmd, args = {}, opts) {
      const id = ++seq
      window.__heraCalls.push(cmd)
      const raw = args instanceof Uint8Array ? b64(args) : null
      return new Promise((res, rej) => { pending.set(id, [res, rej]); window.__heraIPC(JSON.stringify({ id, cmd, args: raw ? null : args, raw, headers: opts?.headers ?? null })) })
    },
  }
})()`

async function cdpSocket(url) {
  const ws = new WebSocket(url)
  await new Promise((ok, err) => ((ws.onopen = ok), (ws.onerror = err)))
  let n = 0
  const wait = new Map(), on = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && wait.has(d.id)) return wait.get(d.id)(d), wait.delete(d.id)
    on.get(d.method)?.forEach((f) => f(d.params))
  }
  // 창이 닫히면(떠 있는 창 파괴) 기다리던 명령은 빈 결과로 끝낸다
  ws.onclose = () => (wait.forEach((f) => f({})), wait.clear())
  const send = (method, params = {}) => new Promise((ok) => (ws.readyState === 1 ? (wait.set(++n, ok), ws.send(JSON.stringify({ id: n, method, params }))) : ok({})))
  const listen = (method, f) => on.set(method, [...(on.get(method) ?? []), f])
  return { ws, send, listen }
}

export async function start({ port = 5199, cdp = 9555, reducedMotion = false } = {}) {
  if (!CHROME) throw new Error('no Chrome/Edge for headless tests')
  // 지금 소스를 한 번 빌드해 정적 서버로 (개발 서버의 요청마다 변환은 바쁜 PC 에서 수십 초씩 걸려 시험이 흔들렸다)
  const profile = mkdtempSync(join(tmpdir(), 'hera-headless-'))
  const out = join(profile, 'dist')
  const VITE = join(ROOT, 'node_modules/vite/bin/vite.js')
  execFileSync(process.execPath, [VITE, 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, stdio: 'inherit' })
  const vite = spawn(process.execPath, [VITE, 'preview', '--outDir', out, '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: process.env.HERA_DEBUG ? 'inherit' : 'ignore' })
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdp}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' })
  const until = async (f, ms) => {
    for (let t = 0; t < ms; t += 100) {
      try { if (await f()) return } catch { /* not up yet */ }
      await sleep(100)
    }
    throw new Error('harness start timeout')
  }
  const kill = () => [chrome, vite].forEach((c) => { try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } })
  try {
    await until(() => fetch(`http://localhost:${port}/`).then((r) => r.ok), 30000)
    await until(() => fetch(`http://127.0.0.1:${cdp}/json/version`).then((r) => r.ok), 20000)
  } catch (e) {
    kill()
    throw e
  }

  const browser = await cdpSocket((await (await fetch(`http://127.0.0.1:${cdp}/json/version`)).json()).webSocketDebuggerUrl)

  /* ── 가짜 Rust (공유 상태) ── */
  const store = new Map()
  const pages = new Map() // label → page
  const calls = [] // [label, cmd, args]
  const hits = new Map() // label → [[x,y,w,h]] (클라이언트 기준, Rust watch::HITS 처럼)
  const pets = new Map()
  let cursor = { x: 0, y: 0 } // 가짜 화면 커서 (float 머리줄 끌기용)
  const handlers = {} // 시험이 덮어쓰는 커맨드

  const islandOrigin = () => pages.get('island')?.geo ?? { x: WA.w - ISL.w, y: WA.h - ISL.h, w: ISL.w, h: ISL.h }
  async function emitTo(label, event, payload) {
    const p = pages.get(label)
    if (!p) return
    for (const l of p.listeners.filter((x) => x.event === event)) await p.eval(`__heraEvent(${l.cb}, ${JSON.stringify({ event, id: l.id, payload })})`).catch(() => {})
  }
  async function emit(event, payload) { for (const l of [...pages.keys()]) await emitTo(l, event, payload) }
  async function setGeo(p, g) {
    p.geo = g
    await p.send('Emulation.setDeviceMetricsOverride', { width: g.w, height: g.h, deviceScaleFactor: 1, mobile: false })
    await p.eval(`window.__heraGeo = ${JSON.stringify({ x: g.x, y: g.y })}`)
  }
  async function floatPage(f, show) {
    const label = `float-${f}`
    if (pages.has(label)) return pages.get(label)
    const [w, hh] = FEAT[f]
    const left = store.get('island.place') === 'bl'
    const g = { x: left ? 464 : WA.w - 464 - w, y: WA.h - 72 - hh, w, h: hh }
    const p = await open(`float&f=${f}`, { label, geo: g })
    p.shown = show
    return p
  }
  const rect = (p) => [p.geo.x, p.geo.y, p.geo.w, p.geo.h]

  async function handle(p, { cmd, args, raw }) {
    calls.push([p.label, cmd, args])
    if (handlers[cmd]) return handlers[cmd](p, args, raw)
    const a = args ?? {}
    switch (cmd) {
      case 'plugin:store|load': case 'plugin:store|get_store': return 1
      case 'plugin:store|get': return [store.get(a.key) ?? null, store.has(a.key)]
      case 'plugin:store|has': return store.has(a.key)
      case 'plugin:store|set':
        store.set(a.key, a.value)
        await emit('store://change', { path: 'hera.json', resourceId: 1, key: a.key, value: a.value, exists: true })
        return null
      case 'plugin:store|delete': {
        const had = store.delete(a.key)
        await emit('store://change', { path: 'hera.json', resourceId: 1, key: a.key, value: null, exists: false })
        return had
      }
      case 'plugin:store|entries': return [...store.entries()]
      case 'plugin:store|keys': return [...store.keys()]
      case 'plugin:store|values': return [...store.values()]
      case 'plugin:store|length': return store.size
      case 'plugin:event|listen': { const id = ++p.lseq; p.listeners.push({ event: a.event, cb: a.handler, id }); return id }
      case 'plugin:event|unlisten': p.listeners = p.listeners.filter((l) => l.id !== a.eventId); return null
      case 'plugin:event|emit': await emit(a.event, a.payload); return null
      case 'plugin:event|emit_to': await emitTo(a.target?.label ?? a.target, a.event, a.payload); return null
      case 'report_hit_rects': hits.set(p.label, a.rects); return null
      case 'island_tall': {
        const isl = pages.get('island'), old = { ...isl.geo }
        const g = a.on ? { x: 0, y: 1, w: WA.w, h: WA.h - 1 } : { x: WA.w - ISL.w, y: WA.h - ISL.h, w: ISL.w, h: ISL.h }
        if (store.get('island.place') === 'bl' && !a.on) g.x = 0
        if (old.x === g.x && old.y === g.y && old.w === g.w) return null
        // Rust island::place → watch::shift_rects (창 원점이 바뀌어도 히트 rect 는 화면 같은 자리)
        hits.set('island', (hits.get('island') ?? []).map((r) => [r[0] + old.x - g.x, r[1] + old.y - g.y, r[2], r[3]]))
        await setGeo(isl, g)
        return null
      }
      case 'float_prepare': { const fp = await floatPage(a.f, false); if (fp.ready) await emitTo('island', 'float-ready', a.f); return rect(fp) }
      case 'float_ready': p.ready = true; await emitTo('island', 'float-ready', p.label.slice(6)); return null
      case 'float_show': {
        const fp = pages.get(`float-${a.f}`)
        const o = islandOrigin()
        if (fp) (fp.shown = true), await setGeo(fp, { x: Math.round(o.x + a.rect[0]), y: Math.round(o.y + a.rect[1]), w: Math.round(a.rect[2]), h: Math.round(a.rect[3]) })
        await emit('float-opened', a.f)
        await emitTo('island', 'float-shown', a.f)
        return null
      }
      case 'float_open': { const fp = await floatPage(a.f, true); fp.shown = true; await emit('float-opened', a.f); return null }
      case 'float_absorbed': await closePage(`float-${a.f}`); return null
      case 'float_close': await closePage(p.label); return null
      case 'float_drag': {
        // Rust float_drag: 커서 = 가짜 화면 커서. 캡슐 = 아일랜드 첫 히트 rect
        const f = p.label.slice(6)
        if (a.phase === 'start') return (p.grab = { x: cursor.x - p.geo.x, y: cursor.y - p.geo.y }), null
        if (a.phase === 'move' && p.grab) await setGeo(p, { ...p.geo, x: cursor.x - p.grab.x, y: cursor.y - p.grab.y })
        const o = islandOrigin(), c = (hits.get('island') ?? [])[0]
        const css = [p.geo.x - o.x, p.geo.y - o.y, p.geo.w, p.geo.h]
        if (a.phase === 'absorb') return void (await emitTo('island', 'absorb', { f, rect: css }))
        if (!c) return null
        const [cx, cy] = [o.x + c[0], o.y + c[1]]
        const d = Math.hypot(Math.max(cx - cursor.x, cursor.x - (cx + c[2]), 0), Math.max(cy - cursor.y, cursor.y - (cy + c[3]), 0))
        if (a.phase === 'end') {
          const was = p.near
          p.near = false
          await emitTo('island', 'absorb-near', { f, d: 9999 })
          if (was && d < 48) await emitTo('island', 'absorb', { f, rect: css })
          return null
        }
        if (d < 160 || p.near) await emitTo('island', 'absorb-near', { f, d })
        p.near = d < 160
        return null
      }
      case 'watch_state': return [null, []]
      case 'link_status': return [{ state: 'off', peer: '', onPeer: false }, null]
      case 'team_state': return { name: '나', pk: 'me', groups: [], online: [] }
      case 'term_state': return { alive: true, running: false, cwd: 'C:\\Users\\me', cmd: '' }
      case 'term_start': return 'C:\\Users\\me'
      case 'clips': return []
      case 'start_apps': return []
      case 'panel_open': return false
      case 'mcp_log': return []
      case 'mcp_info': return ''
      case 'power': return null
      case 'pet_list': return [...pets.values()]
      case 'pet_delete': pets.delete(a.id); return null
      case 'pet_save': {
        // 몸통 = [u32 LE json 길이][json][이미지…] — 형식만 읽는다 (검사는 Rust pets.rs + cargo test)
        const b = Buffer.from(raw, 'base64'), n = b.readUInt32LE(0), j = JSON.parse(b.subarray(4, 4 + n).toString())
        const id = j.id ?? Math.random().toString(36).slice(2, 10)
        let at = 4 + n
        const files = {}
        for (const [st, len] of j.files) {
          const img = b.subarray(at, at + len)
          at += len
          const png = img.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          files[st] = { path: `data:image/${png ? 'png' : 'gif'};base64,${img.toString('base64')}#`, w: png ? img.readUInt32BE(16) : img.readUInt16LE(6), h: png ? img.readUInt32BE(20) : img.readUInt16LE(8), v: Date.now() }
        }
        pets.set(id, { id, name: j.name, style: j.style, sheet: j.sheet, files })
        return id
      }
      default: return null
    }
  }

  async function open(surface, { label = surface, geo, reduced = reducedMotion, init = '' } = {}) {
    // 창마다 따로 (새 창) — 탭이면 뒤쪽 탭이 숨김 상태가 되어 rAF 가 멈춘다 (실제 앱은 창마다 보인다)
    dbg(`open ${surface}`)
    const { result } = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: true })
    dbg('target')
    const t = { id: result.targetId }
    const s = await cdpSocket(`ws://127.0.0.1:${cdp}/devtools/page/${t.id}`)
    const p = { label, id: t.id, listeners: [], lseq: 0, send: s.send, on: s.listen, geo: null, ws: s.ws }
    p.eval = async (expression) => {
      const r = await s.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
      return r.result?.result?.value
    }
    p.errors = []
    s.listen('Runtime.exceptionThrown', (e) => p.errors.push(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text))
    s.listen('Runtime.bindingCalled', async (e) => {
      if (e.name !== '__heraIPC') return
      const m = JSON.parse(e.payload)
      let ok = true, v
      try { v = await handle(p, m) } catch (err) { ok = false; v = String(err) }
      await p.eval(`__heraResolve(${m.id}, ${ok}, ${JSON.stringify(v ?? null)})`).catch(() => {})
    })
    dbg('ws')
    await s.send('Runtime.enable')
    await s.send('Page.enable')
    await s.send('Runtime.addBinding', { name: '__heraIPC' })
    const g0 = geo ?? (surface === 'island' ? { x: store.get('island.place') === 'bl' ? 0 : WA.w - ISL.w, y: WA.h - ISL.h, w: ISL.w, h: ISL.h } : { x: 0, y: 0, w: 800, h: 600 })
    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__heraGeo = ${JSON.stringify({ x: g0.x, y: g0.y })};${init};\n${MOCK}` })
    await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }, { name: 'prefers-color-scheme', value: 'dark' }] })
    await s.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await setGeo(p, g0).catch(() => {})
    pages.set(label, p)
    const loaded = new Promise((r) => s.listen('Page.loadEventFired', r))
    await s.send('Page.navigate', { url: `http://localhost:${port}/?surface=${surface}` })
    dbg('navigated')
    if (process.env.HERA_DEBUG) setTimeout(() => s.send('Runtime.evaluate', { expression: 'document.readyState + " " + document.title + " " + performance.getEntriesByType("resource").length', returnByValue: true }).then((r) => dbg('state ' + JSON.stringify(r.result?.result?.value ?? r))), 5000)
    await loaded
    dbg('loaded')
    await setGeo(p, g0)
    // 입력 (헤드리스 페이지 안에서만)
    p.mouse = async (type, x, y, extra = {}) => s.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !extra.buttons ? 'none' : 'left', buttons: extra.buttons ?? (type === 'mousePressed' ? 1 : 0), clickCount: extra.clickCount ?? 1, pointerType: 'mouse' })
    p.click = async (x, y, n = 1) => { await p.mouse('mouseMoved', x, y); for (let i = 1; i <= n; i++) { await p.mouse('mousePressed', x, y, { clickCount: i }); await p.mouse('mouseReleased', x, y, { clickCount: i }) } }
    p.clickSel = async (sel) => {
      // 보이고 멈춘 뒤에 누른다 (펼쳐지는 중인 요소를 누르면 사람과 다르게 엉뚱한 곳이 눌린다)
      const at = () => p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.offsetWidth) return null; e.scrollIntoView?.({ block: 'nearest' }); const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2] })()`)
      let r = null
      for (let t = 0, prev = null; t < 3000; t += 80) {
        r = await at()
        if (r && prev && r[0] === prev[0] && r[1] === prev[1]) break
        prev = r
        r = null
        await sleep(80)
      }
      if (!r) throw new Error(`no element ${sel}`)
      await p.click(r[0], r[1])
      return r
    }
    p.key = async (key, { ctrl = false, code } = {}) => {
      const base = { key, code: code ?? key, modifiers: ctrl ? 2 : 0, windowsVirtualKeyCode: key === 'Escape' ? 27 : key === 'Enter' ? 13 : key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 }
      await s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key === 'Enter' ? String.fromCharCode(13) : key.length === 1 && !ctrl ? key : undefined })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    }
    p.type = (text) => s.send('Input.insertText', { text })
    return p
  }
  async function closePage(label) {
    const p = pages.get(label)
    if (!p) return
    pages.delete(label)
    try { p.ws.close() } catch { /* already gone */ }
    await browser.send('Target.closeTarget', { targetId: p.id }).catch(() => {})
    if (label.startsWith('float-')) await emit('float-closed', label.slice(6))
  }
  async function close() {
    for (const l of [...pages.keys()]) await closePage(l).catch(() => {})
    try { browser.ws.close() } catch { /* gone */ }
    // 우리가 띄운 프로세스만 (PID 트리) — 사용자의 Chrome·앱은 건드리지 않는다
    kill()
    await sleep(300)
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* 임시 폴더 — 다음에 OS 가 치운다 */ }
  }
  return { store, pages, calls, hits, pets, handlers, open, close, closePage, emit, emitTo, setCursor: (x, y) => (cursor = { x, y }) }
}

/* 작은 시험 도구 */
export function suite(name) {
  let fails = 0
  const ok = (what, cond, extra = '') => (console.log(`${cond ? 'PASS' : 'FAIL'} ${what} ${extra}`), cond || fails++)
  const until = async (f, ms = 4000) => {
    for (let t = 0; t < ms; t += 50) {
      try { if (await f()) return true } catch { /* retry */ }
      await sleep(50)
    }
    return false
  }
  const done = () => (console.log(fails ? `\n${name}: ${fails} FAILED` : `\n${name}: ALL PASS`), fails)
  return { ok, until, done }
}
