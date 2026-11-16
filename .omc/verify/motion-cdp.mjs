// (a6) Motion pack suite — HEADLESS only (headless.mjs). Real springs as CSS linear() on html.mx · hub open = width then height
// with the icons rising row by row · view content 90ms late from .965 · stretchy selection pill · switch knob · wire dash 3 runs
// · frame times for hub open / view open · after the UI settles NO motion-pack animation is left running (idle = 0)
// · reduced motion = html.mx off, nothing staggers.   node .omc/verify/motion-cdp.mjs   (detach/absorb frames: island-cdp FRAMES)
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('motion')
const h = await start()
// rAF 간격 기록 (n 프레임) — 클릭 직전에 켠다
const sampler = (p, n = 45) => p.eval(`(() => { window.__mf = []; let t = performance.now(); const f = (x) => { __mf.push(x - t); t = x; if (__mf.length < ${n}) requestAnimationFrame(f) }; requestAnimationFrame(f) })()`)
const stats = (p) => p.eval(`(() => { const f = (window.__mf || []).slice(1), s = f.slice().sort((a, b) => a - b); return { n: f.length, p50: +(s[Math.floor(f.length * 0.5)] ?? 0).toFixed(1), p95: +(s[Math.floor(f.length * 0.95)] ?? 0).toFixed(1), max: +(s[f.length - 1] ?? 0).toFixed(1), within17: +(f.filter((x) => x <= 17.5).length / Math.max(1, f.length)).toFixed(3) } })()`)
// 쉬는 중에 남은 움직임: 모션 팩(WAAPI)·트랜지션 = 0. CSS 애니메이션은 펫 자신의 것만 (잠들면 멈춘다 — island-cdp)
const live = (p, scope = 'document') => p.eval(`${scope}.getAnimations({ subtree: true }).filter((a) => a.playState === 'running' && !(a instanceof CSSAnimation && a.effect?.target?.closest?.('.pet'))).map((a) => (a.constructor.name + ':' + (a.animationName ?? a.transitionProperty ?? a.id ?? '') + ':' + (a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? '')).slice(0, 80))`)
const FR = {}
try {
  const isl = await h.open('island')
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(600)
  ok('motion pack on: html.mx + spring vars as CSS linear()', await isl.eval(`document.documentElement.classList.contains('mx') && /^linear\\(/.test(getComputedStyle(document.documentElement).getPropertyValue('--sp-settle').trim()) && parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sp-w-ms')) > 200`))
  ok('idle capsule: no motion running (WAAPI · transitions = 0)', (await live(isl)).length === 0, JSON.stringify(await live(isl)))

  /* 허브 열기: 폭 먼저, 높이 뒤 · 아이콘 줄마다 */
  await sampler(isl)
  await isl.click(...(await isl.eval(`(() => { const r = document.querySelector('.isl .skin').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)))
  const dur = await isl.eval(`(() => { const s = getComputedStyle(document.querySelector('.isl .skin')); return [s.transitionProperty, s.transitionDuration, s.transitionDelay] })()`)
  await sleep(120)
  const rise = await isl.eval(`[...document.querySelectorAll('.hub .app')].map((a) => a.getAnimations()[0]?.effect.getTiming().delay ?? -1)`)
  ok('hub icons rise row by row (5 per row, 45ms apart, after the 90ms lead)', rise.length === 13 && rise[0] === 90 && rise[4] === 90 && rise[5] === 135 && rise[10] === 180, JSON.stringify(rise))
  ok('skin springs: width leads, height follows (two curves)', /width/.test(dur[0]) && /height/.test(dur[0]), JSON.stringify(dur))
  await sleep(900)
  FR['hub open'] = await stats(isl)
  ok('hub open frames ≥95% ≤17ms', FR['hub open'].within17 >= 0.95, JSON.stringify(FR['hub open']))
  ok('hub settled: nothing left running', await until(async () => (await live(isl)).length === 0, 3000), JSON.stringify(await live(isl)))

  /* 화면 열기: 내용은 90ms 늦게 .965 에서 */
  await sampler(isl)
  await isl.clickSel('.hub .app[data-go=todo]')
  await until(() => isl.eval(`document.querySelectorAll('.view[data-k=todo] .vbody > *').length > 0`), 2000)
  const content = await isl.eval(`(() => { const c = document.querySelector('.isl .content'); const s = getComputedStyle(c); return [s.transitionDelay, document.querySelectorAll('.view[data-k=todo] .vbody > *').length, [...document.querySelectorAll('.view[data-k=todo] .vbody > *')].map((e) => e.getAnimations().length).reduce((a, b) => a + b, 0)] })()`)
  await sleep(900)
  FR['view open'] = await stats(isl)
  ok('view rows rise in (stagger) as the view opens', content[2] > 0, JSON.stringify(content))
  ok('view open frames ≥95% ≤17ms', FR['view open'].within17 >= 0.95, JSON.stringify(FR['view open']))
  ok('view settled: nothing left running', await until(async () => (await live(isl)).length === 0, 3000), JSON.stringify(await live(isl)))

  /* LP: 판이 없으면 아무것도 돌지 않는다 */
  await isl.clickSel('.isl .view [data-back]')
  await until(() => isl.eval(`!!document.querySelector('.hub .app[data-go=lp]')`))
  await sleep(500)
  await isl.clickSel('.hub .app[data-go=lp]')
  await until(() => isl.eval(`!!document.querySelector('.lpv .deck')`))
  await sleep(500)
  await isl.clickSel('.lpv .filters [data-crate=fx]')
  ok('LP crate records rise in (4 per row)', await until(() => isl.eval(`(() => { const d = [...document.querySelectorAll('.lpv .crate > *')].map((e) => e.getAnimations()[0]?.effect.getTiming().delay ?? -1); return d.length === 10 && d[0] === 30 && d[3] === 30 && d[4] === 75 })()`), 1500))
  ok('LP settled with an empty deck: nothing spins', await until(async () => (await live(isl)).length === 0, 4000), JSON.stringify(await live(isl)))
  await isl.key('Escape')

  /* 설정 창: 알약 · 스위치 손잡이 · 숫자 · 연결선 3번 */
  const sw = await h.open('settings&sec=island', { label: 'settings', geo: { x: 490, y: 176, w: 940, h: 680 } })
  await until(() => sw.eval(`!!document.querySelector('.swin .sizes')`), 8000)
  await sleep(700)
  await sw.clickSel('.swin [data-size-set=xl]')
  ok('stretchy pill flies to the new size and stretches on the way (≤1.6×)', await until(() => sw.eval(`(() => { const p = document.querySelector('.swin .sizes .mx-pill'); if (!p) return false; const k = p.getAnimations()[0]?.effect.getKeyframes()[1]?.transform ?? ''; const m = /scale\\(([\\d.]+), 1\\)/.exec(k); return !!m && +m[1] > 1 && +m[1] <= 1.6 })()`), 600))
  ok('…and the pill is removed when it lands', await until(() => sw.eval(`!document.querySelector('.swin .mx-pill')`), 1500))
  const sw0 = await sw.eval(`(() => { const b = [...document.querySelectorAll('.swin .srow')].find((r) => /전체화면 앱에서/.test(r.textContent)).querySelector('.sw'); b.click(); return true })()`)
  ok('switch knob stretches toward its new side (::after)', sw0 && (await until(() => sw.eval(`document.getAnimations().some((a) => a.effect?.pseudoElement === '::after' && /scaleX\\(1\\.34\\)/.test(JSON.stringify(a.effect.getKeyframes())))`), 600)))
  await sw.clickSel('.swin [data-size-set=m]')
  await sw.clickSel('.swin .nav [data-sec=link]')
  await until(() => sw.eval(`!!document.querySelector('.swin .pcs .wire')`))
  ok('연결 wire dash plays 3 times on a state change, then stops (not infinite)', await sw.eval(`getComputedStyle(document.querySelector('.swin .pcs .wire i')).animationIterationCount === '3'`))
  await sw.clickSel('.swin .nav [data-sec=general]')
  await until(() => sw.eval(`!!document.querySelector('.swin .step')`))
  await sleep(300)
  await sw.eval(`[...document.querySelectorAll('.swin .step button')].find((b) => b.getAttribute('aria-label') === '늘리기').click()`)
  ok('stepper number rolls (from below when it goes up)', await until(() => sw.eval(`document.querySelector('.swin .step b').getAnimations().some((a) => /translateY\\(12px\\)/.test(JSON.stringify(a.effect.getKeyframes())))`), 600))
  ok('settings window settled: nothing running (pane without pets)', await until(async () => (await live(sw)).length === 0, 4000), JSON.stringify(await live(sw)))
  await h.closePage('settings')

  /* 움직임 줄이기 */
  const rm = await h.open('island', { label: 'island-rm', reduced: true })
  await until(() => rm.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(500)
  ok('reduced motion → html.mx off (calm curves)', await rm.eval(`!document.documentElement.classList.contains('mx')`))
  await rm.click(...(await rm.eval(`(() => { const r = document.querySelector('.isl .skin').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)))
  await until(() => rm.eval(`!!document.querySelector('.hub .app')`))
  await sleep(150)
  ok('reduced motion → no stagger animations on the hub icons', await rm.eval(`[...document.querySelectorAll('.hub .app')].every((a) => a.getAnimations().length === 0)`))
  await h.closePage('island-rm')
  console.log('FRAMES ' + JSON.stringify(FR))
  ok('no page errors', isl.errors.length + sw.errors.length === 0, [...isl.errors, ...sw.errors].slice(0, 2).join(' | '))
} catch (e) {
  ok('suite ran to the end', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
