// 떼어내기·흡수 장면 캡처 (아일랜드 웹뷰를 CDP 로 시간차 스크린샷) → <out>/detach-*.png, absorb-*.png
//   SEQ_OUT=<dir> node .omc/verify/seq-cdp.mjs     (ISOLATED build, see island-cdp.mjs)
import { page, PORT } from './cdp.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const out = process.env.SEQ_OUT ?? '.' // (cdp.mjs 의 CLI 판정이 *cdp.mjs 인자를 가로채므로 환경 변수로)
mkdirSync(out, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const has = async (q) => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).some((x) => x.type === 'page' && x.url.includes(q))
const emit = (event, payload) => `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: ${JSON.stringify(event)}, payload: ${JSON.stringify(payload)} })`
const island = await page('island')
const shot = async (name) => {
  const r = await island.send('Page.captureScreenshot', { format: 'png', clip: { x: 360, y: 0, width: 1200, height: 760, scale: 0.75 } })
  writeFileSync(`${out}/${name}.png`, Buffer.from(r.result.data, 'base64'))
}
await island.evaluate(`document.querySelector('.hub')?.dataset.show === 'true' || document.querySelector('.island').click()`)
await sleep(700)
await island.evaluate(`document.querySelector('.hub-icon[data-k=calendar]')?.click()`)
await sleep(800)
await shot('detach-0-in-island')
const t0 = Date.now()
await island.evaluate(`document.querySelector('.hub-detach').click()`)
for (const ms of [60, 160, 280, 420, 600, 800]) {
  await sleep(Math.max(0, ms - (Date.now() - t0)))
  await shot(`detach-${ms}ms`)
}
while (!(await has('f=calendar'))) await sleep(100)
await sleep(800)
const cal = await page('float&f=calendar')
const wr = await cal.evaluate(`[screenX, screenY, outerWidth, outerHeight]`)
const r = await cal.send('Page.captureScreenshot', { format: 'png' })
writeFileSync(`${out}/detach-window.png`, Buffer.from(r.result.data, 'base64'))
await island.evaluate(emit('absorb-near', { f: 'calendar', d: 40 }))
await sleep(250)
await shot('absorb-0-magnet')
const t1 = Date.now()
const [ix, iy] = await island.evaluate(`[screenX, screenY]`)
await island.evaluate(emit('absorb', { f: 'calendar', rect: [wr[0] - ix, wr[1] - iy, wr[2], wr[3]] }))
for (const ms of [40, 160, 300, 450, 620, 900]) {
  await sleep(Math.max(0, ms - (Date.now() - t1)))
  await shot(`absorb-${ms}ms`)
}
console.log('saved to', out)
process.exit(0)
