// Taskbar pet suite — HEADLESS only (headless.mjs, mocked IPC). The `pet` window (created by Rust only while 꾸미기 is on — pet.rs, cargo tests
// cover placement on every taskbar side/DPI and auto-hide): built-in pet from pet.kind, hit rect = the pet only, click → pet_click (panel),
// sleeps after a quiet spell with no animation running, short reactions on file received / sent.   node .omc/verify/pet-cdp.mjs
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('pet')
const h = await start()
const called = (cmd, n0) => h.calls.slice(n0).some((c) => c[1] === cmd)
try {
  h.store.set('pet.kind', 'penguin')
  const p = await h.open('pet', { geo: { x: 1580, y: 990, w: 52, h: 46 } })
  await until(() => p.eval(`!!document.querySelector('.petbar .pet')`), 8000)
  ok('built-in pet from pet.kind (penguin)', await until(() => p.eval(`document.querySelector('.pet').dataset.pet === 'penguin'`)))
  ok('hit rect = the pet only (rest of the window clicks through)', await until(() => { const r = h.hits.get('pet'); return r?.length === 1 && r[0][2] <= 52 && r[0][3] <= 46 && r[0][2] >= 30 }))
  let n = h.calls.length
  await p.clickSel('.petbar')
  ok('click → pet_click (opens the panel)', await until(() => called('pet_click', n)))
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
  ok('click wakes it and opens the panel', (await until(() => p.eval(`document.querySelector('.pet').dataset.s === 'idle'`))) && called('pet_click', n))
  ok('no page errors', p.errors.length === 0, p.errors.join(' | '))
} catch (e) {
  ok('suite ran', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
