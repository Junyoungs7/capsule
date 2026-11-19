// 시각 확인: 받침 + 포탈 (헤드리스) — node .omc/verify/shot-drag.mjs <out.png>
import { writeFileSync } from 'node:fs'
import { start, sleep } from './headless.mjs'
const h = await start()
try {
  h.store.set('link.peerName', 'MacBook')
  const d = await h.open('drag', { geo: { x: 0, y: 0, w: 1280, h: 720 } })
  await sleep(800)
  await h.emitTo('drag', 'drag-start', { scale: 1 })
  await h.emitTo('drag', 'pad-show', { x: 560, y: 520, mac: true, to: [1280, 360] })
  await h.emitTo('drag', 'portal', { k: 1, side: 'right', x: 1280, y: 360 })
  await sleep(900)
  const r = await d.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(process.argv[2], Buffer.from(r.result.data, 'base64'))
} finally {
  await h.close()
}
