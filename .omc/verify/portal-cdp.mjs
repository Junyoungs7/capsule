// Portal suite — HEADLESS only (headless.mjs, mocked IPC). Rust drag.rs sends 'portal' {k, side, x, y} as a file drag nears a Mac-linked edge
// segment (k = 0 at 220 px → 1 within 50 px, cargo test portal_grows_with_proximity). Here: proximity → scale, side → orientation,
// k ≥ 0.9 → "놓으면 … 으로" hint, edge drop ('portal-drop' from edge.rs) → suck-in · flash · shockwave → link_send(path, edge, pos),
// and the canvas draws only while dragging/animating.   node .omc/verify/portal-cdp.mjs
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('portal')
const h = await start()
const called = (cmd, n0, f = () => true) => h.calls.slice(n0).some((c) => c[1] === cmd && f(c[2] ?? {}))
try {
  h.store.set('link.peerName', 'MacBook')
  const d = await h.open('drag', { geo: { x: 0, y: 0, w: 1920, h: 1079 } })
  await until(() => d.eval(`!!document.querySelector('canvas.portal')`), 8000)
  const k = () => d.eval(`Number(document.querySelector('canvas.portal').dataset.k ?? 0)`)
  const lit = () => d.eval(`(() => { const c = document.querySelector('canvas.portal'), g = c.getContext('2d'), w = c.width, hh = c.height; const px = g.getImageData(w - 40, hh / 2 - 20, 40, 40).data; let a = 0; for (let i = 3; i < px.length; i += 4) a += px[i]; return a })()`)

  await h.emitTo('drag', 'drag-start', { scale: 1 })
  ok('idle: nothing drawn', (await lit()) === 0)
  await h.emitTo('drag', 'portal', { k: 0.35, side: 'right', x: 1920, y: 540 })
  ok('far from the edge → small portal (k ≈ 0.35)', await until(async () => Math.abs((await k()) - 0.35) < 0.02))
  ok('…drawn at the right edge, centred on the cursor row', (await lit()) > 0 && (await d.eval(`(() => { const b = document.querySelector('canvas.portal').getBoundingClientRect(); return Math.round(b.right) === 1920 && Math.round(b.top + b.height / 2) === 540 })()`)))
  ok('no hint while not close', await d.eval(`!document.querySelector('.portal-hint').classList.contains('on')`))
  await h.emitTo('drag', 'portal', { k: 1, side: 'right', x: 1920, y: 560 })
  ok('within ~50 px → full size (k = 1)', await until(async () => (await k()) === 1))
  ok('full portal → hint "놓으면 MacBook으로"', await until(() => d.eval(`document.querySelector('.portal-hint').classList.contains('on') && document.querySelector('.portal-hint').textContent === '놓으면 MacBook으로'`)))
  await h.emitTo('drag', 'portal', { k: 0.6, side: 'up', x: 800, y: 0 })
  ok('top edge → canvas rotated −90°, anchored on the edge point', await until(() => d.eval(`/rotate\\(-90deg\\)/.test(document.querySelector('canvas.portal').style.transform)`)))

  /* 가장자리에 놓음 */
  await h.emitTo('drag', 'portal', { k: 1, side: 'right', x: 1920, y: 600 })
  await until(async () => (await k()) === 1)
  const n = h.calls.length
  await h.emitTo('drag', 'portal-drop', { paths: ['C:\\x\\견적서_최종.pdf'], edge: 'left', pos: 0.42, x: 1916, y: 600 })
  ok('edge drop → ghost spirals into the portal', await until(() => d.eval(`!!document.querySelector('.suck')`), 1500))
  ok('…not sent yet while the animation plays', !called('link_send', n))
  ok('…flash + shockwave, then link_send(path, edge, pos)', await until(() => called('link_send', n, (a) => a.path === 'C:\\x\\견적서_최종.pdf' && a.edge === 'left' && a.pos === 0.42), 3000))
  await h.emitTo('drag', 'drag-end', null)
  ok('drag ended + animation done → drag_hide', await until(() => called('drag_hide', n), 4000))
  ok('render loop stopped, canvas cleared', (await until(() => d.eval(`document.querySelector('canvas.portal').dataset.run === '0'`), 4000)) && (await lit()) === 0)

  /* 움직임 줄이기 */
  const r = await h.open('drag', { label: 'drag2', geo: { x: 0, y: 0, w: 1920, h: 1079 }, reduced: true })
  await until(() => r.eval(`!!document.querySelector('canvas.portal')`), 8000)
  ok('reduced motion: pad uses a plain fade', await r.eval(`(() => { const s = [...document.styleSheets].flatMap((x) => [...x.cssRules]).find((x) => x.media && /reduce/.test(x.media.mediaText) && /\\.pad/.test(x.cssText)); return !!s })()`))
  ok('no page errors', d.errors.length === 0 && r.errors.length === 0, [...d.errors, ...r.errors].join(' | '))
} catch (e) {
  ok('suite ran', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
