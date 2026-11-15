// v3 native wiring on an ISOLATED-identifier release build (see link-cdp.mjs header). Does not paste/type into other apps.
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'; start src-tauri\target\release\hera.exe; node .omc/verify/v3-cdp.mjs
import { page, PORT, storeSet } from './cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pages = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((x) => x.type === 'page').map((x) => new URL(x.url).searchParams.get('surface'))
const inv = (cmd, args = {}) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
const ok = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`)
const until = async (f, ms = 5000) => {
  for (let t = 0; t < ms; t += 150) {
    if (await f()) return true
    await sleep(150)
  }
  return false
}

const dock = await page('dock')
const island = await page('island')

// 1. dock: open it and check the row fits the window (useFit folds running apps into +N)
await dock.evaluate(`document.querySelector('.dock').dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))`)
await sleep(900)
const fit = await dock.evaluate(`(() => { const row = document.querySelector('.dock-row'); return { row: row.offsetWidth, win: innerWidth, run: document.querySelectorAll('.run-app').length, fold: document.querySelectorAll('[class*=more], .dock-more, .run-more').length } })()`)
ok('dock row fits the window (useFit)', fit.row <= fit.win, `(row ${fit.row} ≤ window ${fit.win}, run slots ${fit.run})`)
const wins = await dock.evaluate(inv('windows_list'))
ok('running apps folded when many', wins.length < 7 || fit.run <= 6, `(${wins.length} app windows → ${fit.run} slots)`)
ok('dock 최근 복사 command reachable', Array.isArray(await dock.evaluate(inv('clips'))))

// 2. notes window: a desktop note + notes.shown → window per monitor; collapse → destroyed
await dock.evaluate(storeSet('note:v3cdp', { id: 'v3cdp', text: 'CDP 메모', color: 2, x: 300, y: 200, w: 220, h: 140, pinned: false }))
await dock.evaluate(storeSet('notes.shown', true))
ok('notes window created', await until(async () => (await pages()).some((x) => x?.startsWith('notes'))))
const notes = await page('notes0')
ok('note card rendered in the notes window', await until(() => notes.evaluate(`!!document.querySelector('.note')`), 4000))
notes.close()
await dock.evaluate(storeSet('notes.shown', false))
ok('notes window destroyed after collapse', await until(async () => !(await pages()).some((x) => x?.startsWith('notes')), 4000))
await dock.evaluate(`(async () => { const I = window.__TAURI_INTERNALS__; const rid = await I.invoke('plugin:store|get_store', { path: 'hera.json' }); await I.invoke('plugin:store|delete', { rid, key: 'note:v3cdp' }); await I.invoke('plugin:store|set', { rid, key: 'notes.shown', value: true }) })()`)

// 3. OCR: capture-first window + region recognition
let ocrErr = ''
await dock.evaluate(inv('ocr_start')).catch((e) => (ocrErr = String(e)))
if (ocrErr) console.log(`SKIP OCR window: capture failed (${ocrErr.slice(0, 120)}) — expected while the session is locked`)
else {
ok('OCR window opened', await until(async () => (await pages()).includes('ocr')))
const ocr = await page('ocr')
let res
try {
  res = await ocr.evaluate(inv('ocr_region', { x: 0, y: 0, w: 600, h: 200 }))
} catch (e) {
  res = String(e)
}
ok('ocr_region answers (text, lang)', Array.isArray(res), `(${JSON.stringify(res).slice(0, 80)})`)
await ocr.evaluate(`window.__TAURI_INTERNALS__.invoke('close_panel')`).catch(() => {})
ocr.close()
ok('OCR window closed', await until(async () => !(await pages()).includes('ocr')))
}

// 4. ASCII LP: scene relay + Island '아스키 재생 중' follows the real window
await dock.evaluate(inv('ascii', { from: null, scene: 'city' }))
ok('ascii window opened with ?scene=city', await until(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).some((p) => p.url.includes('surface=ascii') && p.url.includes('scene=city'))))
ok('Island shows 아스키 재생 중', await until(() => island.evaluate(`document.querySelector('.island')?.dataset.mode === 'ascii'`)))
await island.evaluate(inv('ascii_stop'))
ok('ascii_stop closes the window', await until(async () => !(await pages()).includes('ascii'), 5000))
ok('Island leaves ascii mode', await until(() => island.evaluate(`document.querySelector('.island')?.dataset.mode !== 'ascii'`)))

// 5. LP drag relay → Island cue platter
await dock.evaluate(inv('lp_drag', { phase: 'drag', x: 0, y: 0, recordId: '' }))
ok('lp-drag shows the cue platter on the Island', await until(() => island.evaluate(`document.querySelector('.island')?.dataset.mode === 'cue'`)))
await dock.evaluate(inv('lp_drag', { phase: 'off', x: 0, y: 0, recordId: '' }))
ok('lp-drag off clears it', await until(() => island.evaluate(`document.querySelector('.island')?.dataset.mode !== 'cue'`)))

// 6. Hera Team: create a group, invite code + string (isolated store)
const g = await dock.evaluate(inv('team_create', { name: 'CDP팀', color: '#14b8a6' }))
const st = await dock.evaluate(inv('team_state'))
ok('team group created', st.groups.some((x) => x.id === g.id && x.members.length === 1), `(me ${st.name})`)
const [code, invite] = await dock.evaluate(inv('team_invite', { group: g.id }))
ok('invite code + string', /^\d{6}$/.test(code) && invite.startsWith('hera-team:'), `(${code})`)

dock.close()
island.close()
