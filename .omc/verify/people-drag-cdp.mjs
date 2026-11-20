// People-in-the-drag-overlay suite — HEADLESS only (headless.mjs, mocked IPC). As Rust drives it (drag.rs):
// 'fan' (file over the pet) → 선반 + 내 맥 + online people around the pet, away from the screen edge, each a drop target → people_send;
// 'gates' (file near the edge) → one round portal per online person (+ 내 맥) in a column → drop → people_send / link_send;
// shake pad gets a people row. Offline people never show.   node .omc/verify/people-drag-cdp.mjs
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('people-drag')
const h = await start()
const called = (cmd, n0, f = () => true) => h.calls.slice(n0).some((c) => c[1] === cmd && f(c[2] ?? {}))
const A = 'a'.repeat(64), B = 'b'.repeat(64), M = 'd'.repeat(64)
const FILES = ['C:/Users/me/Desktop/견적서.pdf']
try {
  h.store.set(`people:${A}`, { id: A, name: '박지윤', at: 1 })
  h.store.set(`people:${B}`, { id: B, name: '최서현', at: 2 })
  h.store.set('link.peerName', 'MacBook')
  h.handlers.people_near = () => [{ pk: A, name: '박지윤', known: true }]
  h.handlers.link_devices = () => [{ id: M, name: 'MacBook', os: 'mac', files: true, paired: true }]
  const d = await h.open('drag', { geo: { x: 0, y: 0, w: 1920, h: 1079 } })
  await until(() => d.eval(`!!document.querySelector('canvas.portal')`), 8000)
  const at = (sel) => d.eval(`(() => { const e = document.querySelector('${sel}'); return { x: +e.dataset.x, y: +e.dataset.y } })()`)
  const drag = async () => { await sleep(400); await h.emitTo('drag', 'drag-start', { scale: 1 }); await h.emitTo('drag', 'tauri://drag-enter', { paths: FILES, position: { x: 900, y: 700 } }) }

  /* 펫 둘레 */
  await drag()
  await h.emitTo('drag', 'fan', { on: true, x: 1440, y: 950, mac: true })
  ok('fan: 선반 · 내 맥 · online person (offline 최서현 left out)', await until(() => d.eval(`[...document.querySelectorAll('.fo')].map((e) => e.dataset.z).join() === 'shelf,dev:${M},${A}'`)))
  ok('pet near the bottom → orbs open upwards, all on screen', await d.eval(`[...document.querySelectorAll('.fo')].every((e) => +e.dataset.y <= 950 && +e.dataset.x > 0 && +e.dataset.x < 1920)`))
  ok('every orb is a drop target (hit rects)', await until(() => (h.hits.get('drag') ?? []).length >= 3))
  await sleep(600) // 등장 스프링이 끝난 뒤
  let p = await at(`.fo[data-z="${A}"]`)
  await h.emitTo('drag', 'tauri://drag-over', { position: p })
  ok('dragging over an orb lights it', await until(() => d.eval(`document.querySelector('.fo[data-z="${A}"]').classList.contains('over')`)))
  let n = h.calls.length
  await h.emitTo('drag', 'tauri://drag-drop', { paths: FILES, position: p })
  ok('drop on a person → people_send(pk, paths)', await until(() => called('people_send', n, (a) => a.pk === A && a.paths[0] === FILES[0])))
  await h.emitTo('drag', 'drag-end', null)
  ok('drag end → overlay hides (drag_hide), orbs gone', await until(() => called('drag_hide', n) && d.eval(`!document.querySelector('.fo')`)))

  /* 가장자리 사람 포탈 */
  await drag()
  await h.emitTo('drag', 'gates', { on: true, side: 'right', y: 500, mac: true })
  ok('gates: 내 맥 + online person in a column at the right edge', await until(() => d.eval(`(() => { const g = [...document.querySelectorAll('.gate')]; return g.map((e) => e.dataset.z).join() === 'dev:${M},${A}' && g.every((e) => +e.dataset.x > 1850) && +g[1].dataset.y > +g[0].dataset.y })()`)))
  n = h.calls.length
  await h.emitTo('drag', 'tauri://drag-drop', { paths: FILES, position: await at(`.gate[data-z="dev:${M}"]`) })
  ok('drop on the Mac gate → link_send(dev)', await until(() => called('link_send', n, (a) => a.path === FILES[0] && a.dev === M)))
  await h.emitTo('drag', 'drag-end', null)
  await until(() => d.eval(`!document.querySelector('.gate')`))

  /* 받침의 사람 줄 */
  await drag()
  await h.emitTo('drag', 'pad-show', { x: 900, y: 700, mac: false, to: null })
  ok('shake pad: people row with the online person', await until(() => d.eval(`[...document.querySelectorAll('.pchip')].map((e) => e.dataset.z).join() === '${A}'`)))
  n = h.calls.length
  const c = await d.eval(`(() => { const b = document.querySelector('.pchip').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
  await h.emitTo('drag', 'tauri://drag-drop', { paths: FILES, position: c })
  ok('drop on a pad person → people_send', await until(() => called('people_send', n, (a) => a.pk === A)))
  ok('no page errors', d.errors.length === 0, d.errors.join(' | '))
} catch (e) {
  ok('suite ran', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
