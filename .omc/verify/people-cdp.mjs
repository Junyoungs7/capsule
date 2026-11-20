// People suite — HEADLESS only (headless.mjs, mocked IPC). Panel 보낼 사람: 내 맥 + 등록한 사람 (켜진 사람 먼저, 꺼진 사람 흐리게),
// drop on a person → people_send / link_send (mac), drop elsewhere → shelf, + 사람 추가 → nearby (not yet registered) → people_pair,
// pairing code card → people_confirm, × → people_forget, received-from label on the shelf.   node .omc/verify/people-cdp.mjs
import { start, suite } from './headless.mjs'

const { ok, until, done } = suite('people')
const h = await start()
const GEO = { x: 1540, y: 300, w: 368, h: 760 }
const called = (cmd, n0, f = () => true) => h.calls.slice(n0).some((c) => c[1] === cmd && f(c[2] ?? {}))
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), M = 'd'.repeat(64), L = 'e'.repeat(64)
let devs = []
try {
  h.store.set(`people:${A}`, { id: A, name: '박지윤', at: 1 })
  h.store.set(`people:${B}`, { id: B, name: '최서현', at: 2 })
  h.store.set('shelf:r', { id: 'r', path: 'C:/Users/me/Downloads/Hera/견적서.pdf', at: Date.now(), from: '박지윤' })
  h.handlers.people_my_ip = () => '192.168.0.7'
  h.handlers.link_devices = () => devs
  h.handlers.people_near = () => [{ pk: A, name: '박지윤', known: true }, { pk: C, name: '정다운', known: false }]
  const p = await h.open('panel', { geo: GEO })
  await until(() => p.eval(`document.querySelectorAll('[data-person]').length === 2`), 8000)
  ok('registered people listed, online first; offline dimmed', await p.eval(`(() => { const r = [...document.querySelectorAll('[data-person]')]; return r[0].dataset.person === '${A}' && !r[0].classList.contains('off') && r[1].classList.contains('off') })()`))
  ok('shelf: "박지윤님에게 받음"', await p.eval(`/박지윤님에게 받음/.test(document.querySelector('[data-file=r]').textContent)`))
  devs = [{ id: M, name: 'MacBook', os: 'mac', files: true, paired: true }, { id: L, name: 'LAPTOP', os: 'win', files: true, paired: true }]
  await h.emit('link-devices', null)
  ok('connected devices (Mac + Windows laptop) join the row first', await until(() => p.eval(`[...document.querySelectorAll('[data-person]')].slice(0, 2).map((e) => e.dataset.person + ':' + e.className.includes(e.dataset.person.endsWith('${M}') ? 'mac' : 'win')).join() === 'dev:${M}:true,dev:${L}:true'`)))

  const at = async (sel) => p.eval(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  let pos = await at(`[data-person="${A}"]`)
  await h.emitTo('panel', 'tauri://drag-over', { paths: [], position: pos })
  ok('dragging over a person highlights them', await until(() => p.eval(`document.querySelector('[data-person="${A}"]').classList.contains('over')`)))
  let n = h.calls.length
  await h.emitTo('panel', 'tauri://drag-drop', { paths: ['C:/x/a.pdf', 'C:/x/b.png'], position: pos })
  ok('drop on a person → people_send(pk, paths), not the shelf', (await until(() => called('people_send', n, (a) => a.pk === A && a.paths.length === 2))) && !called('shelf_add', n))
  n = h.calls.length
  await h.emitTo('panel', 'tauri://drag-drop', { paths: ['C:/x/c.txt'], position: await at(`[data-person="${B}"]`) })
  ok('drop on an offline person → shelf instead (nothing sent)', (await until(() => called('shelf_add', n))) && !called('people_send', n))
  n = h.calls.length
  await h.emitTo('panel', 'tauri://drag-drop', { paths: ['C:/x/d.txt'], position: await at(`[data-person="dev:${M}"]`) })
  ok('drop on my Mac → link_send(dev = Mac)', await until(() => called('link_send', n, (a) => a.path === 'C:/x/d.txt' && a.dev === M)))
  n = h.calls.length
  await h.emitTo('panel', 'tauri://drag-drop', { paths: ['C:/x/w.txt'], position: await at(`[data-person="dev:${L}"]`) })
  ok('drop on the Windows laptop → link_send(dev = laptop)', await until(() => called('link_send', n, (a) => a.path === 'C:/x/w.txt' && a.dev === L)))
  n = h.calls.length
  await h.emitTo('panel', 'tauri://drag-drop', { paths: ['C:/x/e.txt'], position: await at('[data-drop]') })
  ok('drop elsewhere → shelf', await until(() => called('shelf_add', n, (a) => a.paths[0] === 'C:/x/e.txt')))

  await p.eval(`document.querySelector('[data-people-add]').click()`)
  ok('+ 사람 추가 → nearby Hera not yet registered (정다운 only)', await until(() => p.eval(`document.querySelectorAll('[data-near-pk]').length === 1 && !!document.querySelector('[data-near-pk="${C}"]')`)))
  n = h.calls.length
  await p.eval(`document.querySelector('[data-near-pk="${C}"]').click()`)
  ok('click → people_pair(pk)', await until(() => called('people_pair', n, (a) => a.pk === C)))
  ok('내 IP shown for the other side', await until(() => p.eval(`/192.168.0.7/.test(document.querySelector('[data-my-ip]').textContent)`)))
  n = h.calls.length
  await p.eval(`document.querySelector('[data-ip]').focus()`)
  await p.send('Input.insertText', { text: '192.168.0.12' })
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  ok('IP + Enter → people_pair_ip(ip)', await until(() => called('people_pair_ip', n, (a) => a.ip === '192.168.0.12')))
  await h.emit('people-pair', { name: '정다운', code: '4821' })
  ok('pairing card shows the 4-digit code', await until(() => p.eval(`document.querySelector('[data-people-code]')?.dataset.peopleCode === '4821' && /정다운/.test(document.querySelector('[data-people-code]').textContent)`)))
  n = h.calls.length
  await p.eval(`document.querySelector('[data-people-pair=ok]').click()`)
  ok('같아요 → people_confirm(true)', await until(() => called('people_confirm', n, (a) => a.ok === true)))
  await h.emit('people-pair', null)
  ok('card goes away when pairing ends', await until(() => p.eval(`!document.querySelector('[data-people-code]')`)))
  n = h.calls.length
  await p.eval(`document.querySelector('[data-people-del="${B}"]').click()`)
  ok('× → people_forget(pk)', await until(() => called('people_forget', n, (a) => a.pk === B)))
  ok('no page errors', p.errors.length === 0, p.errors.join(' | '))
} catch (e) {
  ok('suite ran', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
