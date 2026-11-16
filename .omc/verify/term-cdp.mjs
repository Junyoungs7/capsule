// (a3) Mini terminal suite — HEADLESS only (headless.mjs). The real ConPTY + ARA handoff are Rust (term.rs; ARA only via the FAKE CLI,
// HERA_ARA_CLI=.omc/verify/fake-ara.cmd — never the user's ARA). Here: Ctrl+` → 640×300 view opening upward from the corner,
// lazy xterm, running → typing pose (persistent), done/fail → pose + pill → tap = view, ARA button → term_to_ara.
//   node .omc/verify/term-cdp.mjs
import { start, sleep, suite, ISL } from './headless.mjs'

const { ok, until, done } = suite('term')
const h = await start()
try {
  h.handlers.term_to_ara = () => 'C:\\Users\\me'
  const isl = await h.open('island')
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(400)
  await h.emitTo('island', 'island-open', 'term')
  ok('Ctrl+` → terminal view', await until(() => isl.eval(`!!document.querySelector('.view[data-k=term]')`)))
  ok('xterm loads lazily (only now)', (await until(() => isl.eval(`!!document.querySelector('.view[data-k=term] .xterm')`), 8000)) && h.calls.some((c) => c[1] === 'term_start'))
  await sleep(700)
  const r = await isl.eval(`(() => { const b = document.querySelector('.isl .skin').getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round) })()`)
  ok('640×300, anchored bottom-right (opens upward and inward)', r[2] === 640 && r[3] === 300 && r[0] + r[2] === ISL.w - 16 && r[1] + r[3] === ISL.h - 8, JSON.stringify(r))
  ok('terminal header = 40px', (await isl.eval(`document.querySelector('.view[data-k=term] .vhead').offsetHeight`)) === 40)
  await h.emitTo('island', 'term-out', 'hello from pty\r\n')
  ok('output reaches xterm', await until(() => isl.eval(`/hello from pty/.test(document.querySelector('.view[data-k=term] .xterm-rows')?.textContent ?? '')`)))
  if (await isl.eval(`!!document.querySelector('.view[data-k=term] .term-ara')`)) {
    await isl.clickSel('.view[data-k=term] .term-ara')
    ok('아라에서 이어서 하기 → term_to_ara (documented CLI path, faked)', await until(() => h.calls.some((c) => c[1] === 'term_to_ara')))
  }
  await isl.key('Escape')
  await until(() => isl.eval(`document.querySelector('.isl').dataset.open === 'false'`))
  await sleep(500)
  await h.emitTo('island', 'term-state', { running: true, cmd: 'npm run dev' })
  ok('running → typing pose that stays', await until(() => isl.eval(`document.querySelector('.isl .pet').dataset.s === 'typing'`), 8000))
  await h.emitTo('island', 'term-done', { ok: true, cmd: 'npm run build', ms: 2100, focused: false })
  ok('done → cheer + "완료" pill', await until(() => isl.eval(`document.querySelector('.isl .pet').dataset.s === 'done' && /npm run build/.test(document.querySelector('.isl .ptext').textContent) && /완료/.test(document.querySelector('.isl .ptext').textContent)`)))
  await h.emitTo('island', 'term-done', { ok: false, cmd: 'cargo test', ms: 2100, focused: false })
  ok('fail → worried pose + red rim', await until(() => isl.eval(`document.querySelector('.isl .pet').dataset.s === 'fail' && document.querySelector('.isl .skin').classList.contains('fail')`)))
  await isl.clickSel('.isl .ptext')
  ok('tap the fail pill → terminal view', await until(() => isl.eval(`!!document.querySelector('.view[data-k=term]')`)))
  await isl.key('Escape')
  await until(() => isl.eval(`document.querySelector('.isl').dataset.open === 'false'`))
  await sleep(500)
  await h.emitTo('island', 'term-done', { ok: true, cmd: 'quick', ms: 300, focused: false })
  await sleep(400)
  ok('short commands (<1s) do not ping', !(await isl.eval(`/quick/.test(document.querySelector('.isl .ptext')?.textContent ?? '')`)))
  ok('no page errors', isl.errors.length === 0, isl.errors.slice(0, 2).join(' | '))
} catch (e) {
  ok('suite ran to the end', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
