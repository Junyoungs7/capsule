// Pet suite — HEADLESS only (headless.mjs, mocked IPC). The `pet` window (always there — pet.rs, cargo tests cover the home spot and
// keeping a moved pet on a monitor): built-in pet from pet.kind, hit rect = the pet box, press → pet_press (Rust: click = panel, move = drag), Enter → pet_click, right-click → pet menu,
// custom image from pet_image, sleeps after a quiet spell, short reactions on file received / sent.   node .omc/verify/pet-cdp.mjs
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('pet')
const h = await start()
const called = (cmd, n0) => h.calls.slice(n0).some((c) => c[1] === cmd)
try {
  h.store.set('pet.kind', 'penguin')
  const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  h.handlers.pet_image = () => IMG
  const p = await h.open('pet', { geo: { x: 1440, y: 940, w: 84, h: 84 } })
  await until(() => p.eval(`!!document.querySelector('.petbar .pet')`), 8000)
  ok('built-in pet from pet.kind (penguin)', await until(() => p.eval(`document.querySelector('.pet').dataset.pet === 'penguin'`)))
  ok('hit rect = the pet only (rest of the window clicks through)', await until(() => { const r = h.hits.get('pet'); return r?.length === 1 && r[0][2] === 84 && r[0][3] === 84 }))
  ok('built-in pet drawn big enough for the floating window', (await p.eval(`document.querySelector('.pet').getBoundingClientRect().width`)) > 60)
  let n = h.calls.length
  await p.clickSel('.petbar')
  ok('press → pet_press (Rust decides click = panel vs drag = move); a mouse click sends no second pet_click', (await until(() => called('pet_press', n))) && !called('pet_click', n))
  n = h.calls.length
  await p.eval(`document.querySelector('.petbar').focus()`)
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  ok('keyboard Enter → pet_click main', await until(() => h.calls.slice(n).some((c) => c[1] === 'pet_click' && c[2]?.view === 'main')))
  n = h.calls.length
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 42, y: 60, button: 'right', buttons: 2, clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 42, y: 60, button: 'right', buttons: 0, clickCount: 1 })
  ok('right-click → pet menu (pet_click fx)', await until(() => h.calls.slice(n).some((c) => c[1] === 'pet_click' && c[2]?.view === 'fx')))
  n = h.calls.length
  await p.mouse('mouseMoved', 42, 60)
  await p.mouse('mousePressed', 42, 60)
  for (const x of [44, 46, 50, 55]) await p.mouse('mouseMoved', x, 60, { buttons: 1 })
  await p.mouse('mouseReleased', 55, 60)
  ok('drag starts with the same pet_press (no web-side drag logic)', (await until(() => called('pet_press', n))) && !called('pet_click', n))
  h.store.set('pet.kind', 'custom')
  await h.emit('store://change', { path: 'hera.json', resourceId: 1, key: 'pet.kind', value: 'custom', exists: true })
  ok('custom image from pet_image', await until(() => p.eval(`document.querySelector('.petbar .pimg')?.src.startsWith('data:image/png')`)))
  h.store.set('pet.kind', 'penguin')
  await h.emit('store://change', { path: 'hera.json', resourceId: 1, key: 'pet.kind', value: 'penguin', exists: true })
  ok('back to a built-in pet', await until(() => p.eval(`!document.querySelector('.pimg') && document.querySelector('.pet')?.dataset.pet === 'penguin'`)))
  ok('awake: idle pose, animating', (await p.eval(`document.querySelector('.pet').dataset.s`)) === 'idle' && (await p.eval(`document.getAnimations().length`)) > 0)
  await h.emitTo('pet', 'pet-react', 'recv')
  ok('file received → shelf pose (box)', await until(() => p.eval(`document.querySelector('.pet').dataset.s === 'shelf'`)))
  await h.emitTo('pet', 'pet-react', 'sent')
  ok('file sent → done pose (cheer)', await until(() => p.eval(`document.querySelector('.pet').dataset.s === 'done'`)))
  // 2분 + 반응 3초를 가상 시간으로 건너뛴다 (실제로 기다리지 않음)
  await new Promise((r) => { p.on('Emulation.virtualTimeBudgetExpired', r); void p.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 130_000 }) })
  ok('quiet spell → sleep', await until(() => p.eval(`document.querySelector('.pet').dataset.s === 'sleep'`)))
  ok('asleep: no animation running', (await p.eval(`document.getAnimations().filter((a) => a.playState === 'running').length`)) === 0)
  n = h.calls.length
  await p.clickSel('.petbar')
  ok('press wakes it (and pet_press opens the panel)', (await until(() => p.eval(`document.querySelector('.pet').dataset.s === 'idle'`))) && called('pet_press', n))
  ok('no page errors', p.errors.length === 0, p.errors.join(' | '))
} catch (e) {
  ok('suite ran', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
