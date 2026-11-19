// 시각 확인용 스크린샷 (헤드리스) — node .omc/verify/shots.mjs <outdir> [surface ...]  (panel · toast · pad · pet · settings)
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { start, sleep } from './headless.mjs'
const [out, ...want] = process.argv.slice(2)
const h = await start()
const GEO = { panel: { w: 368, h: 640 }, toast: { w: 364, h: 72 }, pad: { w: 420, h: 260 }, pet: { w: 64, h: 56 }, settings: { w: 720, h: 600 }, notes: { w: 728, h: 520 } }
try {
  h.store.set('shelf:a', { id: 'a', path: 'C:\Users\me\Desktop\서버정보_20250721.xlsx', at: Date.now() - 90_000_000, from: 'pc' })
  h.store.set('shelf:b', { id: 'b', path: 'C:\Users\me\Downloads\Hera\스크린샷 2026-11-18.png', at: Date.now() - 600_000, from: 'mac' })
  h.store.set('note:1', { id: '1', text: '회의실 B 3시 → 4시로 변경', color: 0, x: 16, y: 16, w: 210, h: 140, at: Date.now() - 100000 })
  h.handlers.toast_next = () => ({ kind: 'recv', title: '맥에서 파일을 받았어요', sub: 'IMG_2041.png · 선반과 다운로드\Hera에 있어요' })
  for (const s of want.length ? want : ['panel', 'toast']) {
    const p = await h.open(s, { geo: { x: 0, y: 0, ...GEO[s.split('&')[0]] } })
    await sleep(1200)
    const r = await p.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(out, `${s.split('&')[0]}.png`), Buffer.from(r.result.data, 'base64'))
    console.log('shot', s, p.errors.join(' | '))
  }
} finally {
  await h.close()
}
