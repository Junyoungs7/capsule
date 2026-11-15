// v2 checks on the release app over CDP (works while the session is locked).
// Start Hera with $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333', then: node .omc/verify/v2-cdp.mjs
// HERA_CLIP=1 also round-trips the clipboard (overwrites it — the ps1 wrapper saves/restores text).
import { page, PORT } from './cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pages = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((x) => x.type === 'page').map((x) => new URL(x.url).searchParams.get('surface'))
const inv = (cmd, args) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
const ok = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`)

const dock = await page('dock')

// 1. dock grows upward for the group popover and comes back
const h0 = await dock.evaluate('innerHeight')
await dock.evaluate(inv('dock_tall', { tall: true }))
await sleep(400)
const h1 = await dock.evaluate('innerHeight')
await dock.evaluate(inv('dock_tall', { tall: false }))
await sleep(400)
const h2 = await dock.evaluate('innerHeight')
ok('dock_tall', h1 > h0 + 300 && h2 === h0, `${h0} -> ${h1} -> ${h2}`)

// 2. ascii window: created on demand, closes (animation) and is destroyed
await dock.evaluate(inv('ascii', { from: [600, 900, 88, 52] }))
await sleep(1500)
ok('ascii open', (await pages()).includes('ascii'))
const asc = await page('ascii')
const scene = await asc.evaluate(`document.querySelector('.ascii-full footer b')?.textContent`)
await asc.evaluate(`document.querySelector('.ascii-full').click()`)
asc.close()
await sleep(2500)
ok('ascii destroyed after close', !(await pages()).includes('ascii'), `(scene: ${scene})`)

// 3. fx window: created on demand, below dock/island, destroyed after ~25s
await dock.evaluate(inv('fx', { kind: 'snow' }))
await sleep(1500)
ok('fx open', (await pages()).includes('fx'))
const fx = await page('fx')
ok('fx canvas', await fx.evaluate(`!!document.querySelector('canvas.fx')`))
fx.close()
await dock.evaluate(inv('fx', { kind: 'nope' })) // unknown kind is ignored
console.log('   waiting for fx to finish (~27s)…')
await sleep(28000)
ok('fx destroyed after event', !(await pages()).includes('fx'))

// 4. clipboard history (optional)
if (process.env.HERA_CLIP === '1') {
  const pal = await page('palette')
  const t = 'hera-v2-clip-' + Date.now()
  await pal.evaluate(inv('set_clip', { text: t }))
  await sleep(500)
  const list = await pal.evaluate(inv('clips', {}))
  ok('clipboard listener', list[0]?.text === t, `(${list.length} items)`)
  pal.close()
}
dock.close()
