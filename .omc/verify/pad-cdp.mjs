// Shake pad suite — HEADLESS only (headless.mjs, mocked IPC). The `drag` overlay as Rust drives it (drag.rs: probe → file drag → shake → pad-show):
// synthetic native drag events (tauri://drag-enter/over/drop) → probe confirm (drag_file) → pad at the cursor with the spring entrance →
// targets: 선반에 올리기 → shelf_add · 맥으로 보내기 disabled without the Mac ("맥 Hera 연결 필요") / with the Mac → spiral suck-in → link_send.
// The overlay is a drop target only over the pad (hit rect), and hides itself (drag_hide) when the drag ends. The shake math itself = cargo test (drag.rs).
//   node .omc/verify/pad-cdp.mjs
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('pad')
const h = await start()
const called = (cmd, n0, f = () => true) => h.calls.slice(n0).some((c) => c[1] === cmd && f(c[2] ?? {}))
const FILES = ['C:\\Users\\me\\Desktop\\회의록_1119.docx']
try {
  const d = await h.open('drag', { geo: { x: 0, y: 0, w: 1920, h: 1079 } })
  await until(() => d.eval(`!!document.querySelector('canvas.portal')`), 8000)
  const zone = (z) => d.eval(`(() => { const b = document.querySelector('[data-z=${z}]').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2] })()`)

  /* 1) 맥 없음: 시험 → 확정 → 흔들기 → 받침 → 선반 */
  await h.emitTo('drag', 'drag-start', { scale: 1 })
  let n = h.calls.length
  await h.emitTo('drag', 'tauri://drag-enter', { paths: FILES, position: { x: 900, y: 700 } })
  ok('probe: DragEnter with paths → drag_file (OLE file drag confirmed)', await until(() => called('drag_file', n)))
  ok('no pad before the shake', await d.eval(`!document.querySelector('[data-pad]')`))
  await h.emitTo('drag', 'pad-show', { x: 900, y: 700, mac: false, to: null })
  ok('shake → pad above the cursor (spring entrance)', await until(() => d.eval(`(() => { const p = document.querySelector('[data-pad]'); if (!p) return false; const b = p.getBoundingClientRect(); return b.bottom < 700 && Math.abs(b.left + b.width / 2 - 900) < 2 && getComputedStyle(p).animationName === 'pad-in' })()`)))
  ok('two targets: 선반에 올리기 · 맥으로 보내기', (await d.eval(`[...document.querySelectorAll('[data-z]')].map((z) => z.dataset.z).join()`)) === 'shelf,mac')
  ok('맥으로 보내기 disabled without the Mac: "맥 Hera 연결 필요"', await d.eval(`document.querySelector('[data-z=mac]').getAttribute('aria-disabled') === 'true' && /맥 Hera 연결 필요/.test(document.querySelector('[data-z=mac]').textContent)`))
  ok('the overlay takes drops only over the pad (hit rect = pad)', await until(() => { const r = h.hits.get('drag'); return r?.length === 1 && r[0][2] > 250 && r[0][2] < 400 && r[0][1] + r[0][3] < 700 }))
  let [x, y] = await zone('mac')
  await h.emitTo('drag', 'tauri://drag-over', { position: { x, y } })
  ok('dragging over the disabled 맥 target does not light it', await sleep(150).then(() => d.eval(`!document.querySelector('[data-z=mac]').classList.contains('over')`)))
  ;[x, y] = await zone('shelf')
  await h.emitTo('drag', 'tauri://drag-over', { position: { x, y } })
  ok('over 선반에 올리기 → it lifts (.over)', await until(() => d.eval(`document.querySelector('[data-z=shelf]').classList.contains('over')`)))
  n = h.calls.length
  await h.emitTo('drag', 'tauri://drag-drop', { paths: FILES, position: { x, y } })
  ok('drop on 선반 → shelf_add(paths) + gulp', (await until(() => called('shelf_add', n, (a) => a.paths?.[0] === FILES[0]))) && (await d.eval(`document.querySelector('[data-z=shelf]').classList.contains('done')`)))
  await h.emitTo('drag', 'drag-end', null)
  ok('drag ends → pad gone, hit rects cleared, drag_hide', (await until(() => called('drag_hide', n))) && (await d.eval(`!document.querySelector('[data-pad]')`)) && (h.hits.get('drag') ?? []).length === 0)

  /* 2) 맥 연결: 받침 '맥으로 보내기' → 빨려 들어감 → link_send */
  await h.emitTo('drag', 'drag-start', { scale: 1 })
  await h.emitTo('drag', 'tauri://drag-enter', { paths: FILES, position: { x: 700, y: 600 } })
  await h.emitTo('drag', 'pad-show', { x: 700, y: 600, mac: true, to: [1920, 600] })
  ok('with the Mac: 맥으로 보내기 enabled', await until(() => d.eval(`document.querySelector('[data-z=mac]') && !document.querySelector('[data-z=mac]').hasAttribute('aria-disabled')`)))
  ;[x, y] = await zone('mac')
  await h.emitTo('drag', 'tauri://drag-over', { position: { x, y } })
  ok('over 맥으로 보내기 → .over', await until(() => d.eval(`document.querySelector('[data-z=mac]').classList.contains('over')`)))
  n = h.calls.length
  await h.emitTo('drag', 'tauri://drag-drop', { paths: FILES, position: { x, y } })
  ok('drop → spiral ghost flies to the portal', await until(() => d.eval(`!!document.querySelector('.suck')`), 1500))
  ok('…then link_send(path) (after the animation)', (await d.eval(`!!document.querySelector('.suck')`)) && !called('link_send', n) && (await until(() => called('link_send', n, (a) => a.path === FILES[0]), 3000)))
  await h.emitTo('drag', 'drag-end', null)
  ok('…and the overlay hides when the flash settles', await until(() => called('drag_hide', n), 4000))
  ok('portal canvas stops drawing when idle', await until(() => d.eval(`document.querySelector('canvas.portal').dataset.run === '0'`), 4000))
  ok('no page errors', d.errors.length === 0, d.errors.join(' | '))
} catch (e) {
  ok('suite ran', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
