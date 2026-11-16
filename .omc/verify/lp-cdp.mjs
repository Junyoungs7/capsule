// (a3) LP player suite — HEADLESS only (headless.mjs). Hub LP icon → desktop LP player window → play an effect / ASCII scene →
// the capsule shows 'LP 재생 중' with a stop chip → stopping clears it.   node .omc/verify/lp-cdp.mjs
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('lp')
const h = await start()
try {
  // 가짜 Rust: 효과·아스키 창 열기/닫기 = 이벤트만 (창은 만들지 않는다)
  h.handlers.fx = async (p, a) => (await h.emit('fx-open', a.kind), null)
  h.handlers.fx_stop = async () => (await h.emit('fx-closed', null), null)
  h.handlers.ascii = async (p, a) => (await h.emit('ascii-open', { scene: a.scene ?? null, saver: false }), null)
  h.handlers.ascii_stop = async () => (await h.emit('ascii-closed', null), null)
  const isl = await h.open('island')
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(400)
  await isl.clickSel('.isl .petbox')
  await until(() => isl.eval(`document.querySelector('.isl .skin').offsetWidth === 432`))
  await sleep(300)
  await isl.clickSel('.hub .app[data-go=lp]')
  ok('LP icon opens the LP player window (desktop prop) and folds the hub', await until(() => h.pages.has('float-lp') && isl.eval(`document.querySelector('.isl').dataset.open === 'false'`)))
  const lp = h.pages.get('float-lp')
  ok('10 records (5 effects + 5 ASCII)', await until(() => lp.eval(`document.querySelectorAll('.lp-recs .crate-rec').length === 10`), 6000))
  ok('LP window keeps its own drag (no OS caption region)', await lp.eval(`!document.querySelector('[data-tauri-drag-region]')`))
  const tap = (i) => lp.clickSel(`.lp-recs .crate-rec:nth-child(${i + 1})`) // 6px 안에서 누르고 떼기 = 바로 재생
  await tap(0)
  ok('tap = on the platter, arm down, effect requested', (await until(() => lp.eval(`document.querySelector('.arm')?.dataset.down === 'true'`))) && h.calls.some((c) => c[1] === 'fx'))
  ok('capsule shows "LP 재생 중" with a stop chip', await until(() => isl.eval(`/LP 재생 중/.test(document.querySelector('.isl .ptext')?.textContent ?? '') && [...document.querySelectorAll('.isl .ptext:not(.measure) .chp')].some((b) => b.textContent === '정지')`)))
  await isl.eval(`[...document.querySelectorAll('.isl .ptext:not(.measure) .chp')].find((b) => b.textContent === '정지').click()`)
  ok('stop chip stops it (fx_stop) and the arm lifts', (await until(() => h.calls.some((c) => c[1] === 'fx_stop'))) && (await until(() => lp.eval(`document.querySelector('.arm')?.dataset.down !== 'true'`))))
  ok('pill clears', await until(() => isl.eval(`!/LP 재생 중/.test(document.querySelector('.isl .ptext')?.textContent ?? '')`), 8000))
  await tap(6)
  ok('ASCII record → ascii scene requested', await until(() => h.calls.some((c) => c[1] === 'ascii')))
  ok('capsule shows the ASCII scene playing', await until(() => isl.eval(`/LP 재생 중/.test(document.querySelector('.isl .ptext')?.textContent ?? '')`)))
  await isl.eval(`[...document.querySelectorAll('.isl .ptext:not(.measure) .chp')].find((b) => b.textContent === '정지').click()`)
  ok('stop chip stops ASCII too', await until(() => h.calls.some((c) => c[1] === 'ascii_stop')))
  void lp.clickSel('.float-btn[aria-label="닫기"]')
  ok('closing the LP window destroys it', await until(() => !h.pages.has('float-lp')))
  ok('no page errors', isl.errors.length + lp.errors.length === 0, [...isl.errors, ...lp.errors].slice(0, 2).join(' | '))
} catch (e) {
  ok('suite ran to the end', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
