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
  ok('open portal → its drawing becomes a drop target (hit rect, 140 deep)', await until(() => h.calls.some((c) => c[1] === 'report_hit_rects' && (c[2]?.rects ?? []).some((r) => Math.round(r[0]) === 1780 && Math.round(r[2]) === 140 && Math.round(r[1]) === 432))))
  { const n0 = h.calls.length
    await h.emitTo('drag', 'tauri://drag-drop', { paths: ['C:/x/a.txt'], position: { x: 1830, y: 600 } })
    ok('drop on the portal drawing (not the 4 px strip) → portal_drop_here(paths)', await until(() => called('portal_drop_here', n0, (a) => a.paths?.[0] === 'C:/x/a.txt'))) }
  await until(async () => (await k()) === 1)
  let n = h.calls.length
  await h.emitTo('drag', 'portal-drop', { paths: ['C:\\x\\견적서_최종.pdf'], edge: 'left', pos: 0.42, x: 1916, y: 600 })
  ok('edge drop → ghost spirals into the portal', await until(() => d.eval(`!!document.querySelector('.suck')`), 1500))
  ok('…not sent yet while the animation plays', !called('link_send', n))
  ok('…flash + shockwave, then link_send(path, edge, pos)', await until(() => called('link_send', n, (a) => a.path === 'C:\\x\\견적서_최종.pdf' && a.edge === 'left' && a.pos === 0.42), 3000))
  await h.emitTo('drag', 'drag-end', null)
  ok('drag ended + animation done → drag_hide', await until(() => called('drag_hide', n), 4000))
  ok('render loop stopped, canvas cleared', (await until(() => d.eval(`document.querySelector('canvas.portal').dataset.run === '0'`), 4000)) && (await lit()) === 0)

  /* 받는 포탈 (맥 → 윈도우) */
  n = h.calls.length
  await h.emitTo('drag', 'recv-portal', { edge: 'right', x: 1920, y: 400, to: [1800, 1055], name: '회의록.docx' })
  ok('recv via Mac edge → big portal at that edge point, particles flow out', await until(() => d.eval(`(() => { const c = document.querySelector('canvas.portal').getBoundingClientRect(); return Math.round(c.right) === 1920 && Math.round(c.top + c.height / 2) === 400 && Number(document.querySelector('canvas.portal').dataset.k) > 0.5 })()`), 3000))
  ok('…the file pops out of it', await until(() => d.eval(`!!document.querySelector('.suck[data-recv="회의록.docx"]')`), 2000))
  ok('…flies into the tray icon (ring there), then drag_hide', (await until(() => d.eval(`(() => { const r = document.querySelector('.recv-ring'); return !!r && r.style.left === '1800px' && r.style.top === '1055px' })()`), 4000)) && (await until(() => called('drag_hide', n), 4000)))
  ok('…nothing sent while receiving', !called('link_send', n))
  n = h.calls.length
  await h.emitTo('drag', 'recv-portal', { edge: null, x: 1800, y: 1055, to: [1800, 1055], name: '사진.png' })
  ok('normal recv → small round portal just above the tray icon', await until(() => d.eval(`(() => { const c = document.querySelector('canvas.portal'), b = c.getBoundingClientRect(); return c.style.transform === 'none' && Math.round(b.left + b.width / 2) === 1800 && Math.round(b.top + b.height / 2) === 945 })()`), 3000))
  ok('…then into the tray icon and hidden', (await until(() => d.eval(`!!document.querySelector('.recv-ring')`), 4000)) && (await until(() => called('drag_hide', n), 4000)))
  await h.emitTo('drag', 'portal', { k: 1, side: 'right', x: 1920, y: 300 })
  ok('a send after a receive → normal edge portal again (not round)', await until(() => d.eval(`document.querySelector('canvas.portal').style.transform !== 'none' && Math.round(document.querySelector('canvas.portal').getBoundingClientRect().right) === 1920`)), await d.eval(`document.querySelector('canvas.portal').style.cssText`))
  await h.emitTo('drag', 'portal', { k: 0, side: 'right', x: 1920, y: 300 })

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
