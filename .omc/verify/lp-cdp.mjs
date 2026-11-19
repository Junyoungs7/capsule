// (a6) LP launcher suite — HEADLESS only (headless.mjs). Hub LP icon → LP view inside the Island (452×612): deck + two crates
// that never mix (앱 LP · 효과·아스키 LP) · tap = on the platter + play · eject an app = app stays open · effects: the newest replaces
// the previous one · capsule 'LP 재생 중' + stop chip · ★ = first in its crate · add sheet (URL · 세트 · 묶음)
// · Space = play/stop · detach → LP window with the same launcher.   node .omc/verify/lp-cdp.mjs
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('lp')
const h = await start()
const REC = (id, title, target, cover, kind = 'single', targets) => h.store.set(`record:${id}`, { id, title, target, kind, cover, glyph: 'text', ...(targets && { targets }) })
REC('calc', '계산기', 'calc.exe', '#334155')
REC('code', 'VS Code', 'C:\\Code.exe', '#2F80ED')
REC('gh', 'GitHub', 'https://github.com', '#1F2937')
REC('set1', '작업 세트', '', '#14B8A6', 'set', ['code', 'gh'])
h.store.set('group:g1', { id: 'g1', title: '개발', recordIds: ['code', 'gh'] })
try {
  // 가짜 Rust: 효과·아스키 창 열기/닫기 = 이벤트만 (창은 만들지 않는다) · 앱 실행 = 기록만
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
  ok('LP icon opens the LP launcher inside the Island (452×612)', await until(async () => (await isl.eval(`!!document.querySelector('.view[data-k=lp] .lpv .deck') && document.querySelector('.isl .skin').offsetWidth === 452 && document.querySelector('.isl .skin').offsetHeight === 612`))))
  await sleep(500)
  const crate = () => isl.eval(`[...document.querySelectorAll('.lpv .crate [data-rec], .lpv .crate [data-grp]')].map((e) => e.dataset.rec ?? 'grp:' + e.dataset.grp)`)
  const FX = ['fx:snow', 'fx:rain', 'fx:leaves', 'fx:sunset', 'fx:moon', 'ascii:auto', 'ascii:xmas', 'ascii:city', 'ascii:autumn', 'ascii:calm']
  const a0 = await crate()
  ok('앱 LP crate = apps · sets · groups only (no effects)', JSON.stringify(a0) === JSON.stringify(['calc', 'code', 'gh', 'set1', 'grp:g1']), JSON.stringify(a0))
  await isl.clickSel('.lpv .filters [data-crate=fx]')
  await until(async () => (await crate()).length === 10)
  const f0 = await crate()
  ok('효과·아스키 LP crate = 5 effects + 5 ASCII only (no apps) — the crates never mix', JSON.stringify(f0) === JSON.stringify(FX), JSON.stringify(f0))
  ok('crate choice is remembered (lp.crate)', h.store.get('lp.crate') === 'fx')
  ok('no + (add) on the effects crate — fixed set', await isl.eval(`!document.querySelector('.lpv .filters [data-sheet=add]')`))
  {
    const [rx, ry] = await isl.eval(`(() => { const r = document.querySelector('.lpv .crate [data-rec] .disc').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
    await isl.mouse('mousePressed', rx, ry)
    await isl.mouse('mouseMoved', rx + 30, ry + 20, { buttons: 1 })
    await isl.mouse('mouseMoved', rx + 50, ry + 40, { buttons: 1 })
    const gc = await isl.eval(`(() => { const g = document.querySelector('.dragghost'); if (!g) return null; const r = g.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
    await isl.mouse('mouseReleased', rx + 50, ry + 40)
    ok('Island LP: dragged record sits under the cursor (±6px)', !!gc && Math.abs(gc[0] - (rx + 50)) <= 6 && Math.abs(gc[1] - (ry + 40)) <= 6, JSON.stringify({ gc, at: [rx + 50, ry + 40] }))
    await sleep(300)
  }
  {
    // 캡슐 끌림 확대(scale 1.16)가 걸려 있어도
    await isl.eval(`document.querySelector('.isl').dataset.magnet = 'hot'`)
    await sleep(600) // 확대 전환이 끝난 뒤
    const [rx, ry] = await isl.eval(`(() => { const r = document.querySelector('.lpv .crate [data-rec] .disc').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
    await isl.mouse('mousePressed', rx, ry)
    await isl.mouse('mouseMoved', rx + 30, ry + 20, { buttons: 1 })
    await isl.mouse('mouseMoved', rx + 90, ry + 60, { buttons: 1 })
    const gc = await isl.eval(`(() => { const g = document.querySelector('.dragghost'); if (!g) return null; const r = g.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
    await isl.mouse('mouseReleased', rx + 90, ry + 60)
    await isl.eval(`delete document.querySelector('.isl').dataset.magnet`)
    ok('Island LP scaled (magnet hot): dragged record under the cursor (±6px)', !!gc && Math.abs(gc[0] - (rx + 90)) <= 6 && Math.abs(gc[1] - (ry + 60)) <= 6, JSON.stringify({ gc, at: [rx + 90, ry + 60] }))
    await sleep(300)
  }

  /* 효과: 누르기 = 판 · 재생 · 새 판이 앞 판을 바꾼다 */
  let n = h.calls.length
  await isl.clickSel('.lpv [data-rec="fx:snow"]')
  ok('tap an effect = on the platter, arm down, fx requested', (await until(() => isl.eval(`document.querySelector('.lpv .deck').dataset.play === 'true' && /눈/.test(document.querySelector('.lpv .info b').textContent)`))) && (await until(() => h.calls.slice(n).some((c) => c[1] === 'fx' && c[2].kind === 'snow'))))
  ok('capsule alert stays out while the hub is open; the deck shows 재생 중', await isl.eval(`/재생 중/.test(document.querySelector('.lpv .info .kind').textContent)`))
  n = h.calls.length
  await isl.clickSel('.lpv [data-rec="fx:rain"]')
  ok('a second effect replaces the first (fx_stop, then fx rain) — one record on the deck', await until(() => { const c = h.calls.slice(n).map((x) => x[1] + (x[2]?.kind ? ':' + x[2].kind : '')); return c.indexOf('fx_stop') >= 0 && c.indexOf('fx:rain') > c.indexOf('fx_stop') }), JSON.stringify(h.calls.slice(n).map((x) => x[1])))
  await until(() => isl.eval(`document.querySelector('.lpv .deck').dataset.play === 'true'`))
  // 허브를 접으면 캡슐이 'LP 재생 중' + 정지
  await isl.key('Escape')
  ok('capsule shows "LP 재생 중" with a stop chip', await until(() => isl.eval(`/LP 재생 중/.test(document.querySelector('.isl .ptext')?.textContent ?? '') && [...document.querySelectorAll('.isl .ptext:not(.measure) .chp')].some((b) => b.textContent === '정지')`)))
  n = h.calls.length
  await isl.eval(`[...document.querySelectorAll('.isl .ptext:not(.measure) .chp')].find((b) => b.textContent === '정지').click()`)
  ok('stop chip stops it (fx_stop) and the pill clears', (await until(() => h.calls.slice(n).some((c) => c[1] === 'fx_stop'))) && (await until(() => isl.eval(`!/LP 재생 중/.test(document.querySelector('.isl .ptext')?.textContent ?? '')`), 8000)))

  /* 다시 LP: ★ · 앱 실행 · 꺼내기 */
  await sleep(400)
  await isl.clickSel('.isl .petbox')
  await until(() => isl.eval(`document.querySelector('.isl .skin').offsetWidth === 432`))
  await sleep(300)
  await isl.clickSel('.hub .app[data-go=lp]')
  await until(() => isl.eval(`!!document.querySelector('.lpv .deck')`))
  await sleep(500)
  ok('the deck went back to empty after the effect ended', await isl.eval(`!document.querySelector('.lpv .platter .disc')`))
  await isl.eval(`document.querySelector('.lpv [data-star="fx:moon"]').click()`)
  ok('★ on an effect → first in the effects crate (lp.star.fx)', await until(async () => (await crate())[0] === 'fx:moon' && h.store.get('lp.star')?.fx?.[0] === 'fx:moon'))
  await isl.clickSel('.lpv .filters [data-crate=app]')
  await until(async () => (await crate()).includes('calc'))
  await isl.eval(`document.querySelector('.lpv [data-star="gh"]').click()`)
  ok('★ on an app → first in the app crate; the other crate keeps its own ★', await until(async () => (await crate())[0] === 'gh' && h.store.get('lp.star')?.app?.join() === 'gh' && h.store.get('lp.star')?.fx?.join() === 'fx:moon'), JSON.stringify(h.store.get('lp.star')))
  n = h.calls.length
  await isl.clickSel('.lpv [data-rec="calc"]')
  ok('tap an app = on the platter + launch', await until(() => h.calls.slice(n).some((c) => c[1] === 'launch' && c[2].target === 'calc.exe')))
  n = h.calls.length
  await isl.clickSel('.lpv .ctl [data-eject]')
  ok('eject an app record = off the deck, the app is NOT closed (no stop/kill call)', (await until(() => isl.eval(`!document.querySelector('.lpv .platter .disc') && /그대로 열려/.test(document.querySelector('.lpv .toast')?.textContent ?? '')`))) && !h.calls.slice(n).some((c) => /stop|kill|close/.test(c[1])), JSON.stringify(h.calls.slice(n).map((c) => c[1])))
  n = h.calls.length
  await isl.clickSel('.lpv [data-rec="set1"]')
  ok('a set launches its records in order (VS Code → GitHub) with step bars', (await until(() => { const l = h.calls.slice(n).filter((c) => c[1] === 'launch').map((c) => c[2].target); return l.join('|') === 'C:\\Code.exe|https://github.com' })) && (await until(() => isl.eval(`document.querySelectorAll('.lpv .steps i.on').length === 2`))))
  // Space = 재생 / 정지
  await isl.eval(`document.querySelector('.lpv').focus()`)
  await isl.key(' ', { code: 'Space' })
  ok('Space toggles the deck (stop)', await until(() => isl.eval(`document.querySelector('.lpv .deck').dataset.play === 'false'`)))
  await isl.clickSel('.lpv .ctl [data-eject]')

  /* 추가 시트: URL · 세트 */
  await isl.clickSel('.lpv .filters [data-sheet=add]')
  await until(() => isl.eval(`document.querySelector('.lpv .sheet').classList.contains('on')`))
  await sleep(500)
  await isl.clickSel('.lpv .sheet .addrow .inp')
  await isl.type('https://example.com/board')
  await isl.clickSel('.lpv [data-lpadd]')
  ok('add sheet: URL → a new app record', await until(() => [...h.store.values()].some((v) => v?.target === 'https://example.com/board')))
  await isl.clickSel('.lpv .sheet [data-sheet=set]')
  await sleep(300)
  await isl.clickSel('.lpv .sheet [data-pick=gh]')
  await isl.clickSel('.lpv .sheet [data-pick=calc]')
  ok('set picker numbers the order (1 · 2)', await until(() => isl.eval(`document.querySelector('.lpv .sheet [data-pick=gh] .ord').textContent === '1' && document.querySelector('.lpv .sheet [data-pick=calc] .ord').textContent === '2'`)))
  await isl.clickSel('.lpv [data-lpmake]')
  ok('세트 만들기 → a set record in that order', await until(() => [...h.store.values()].some((v) => v?.kind === 'set' && v.targets?.join() === 'gh,calc')))
  ok('sheet closes after making', await until(() => isl.eval(`!document.querySelector('.lpv .sheet').classList.contains('on')`)))

  /* 떼어내기 → LP 창 (같은 런처) */
  await isl.clickSel('.view[data-k=lp] [data-detach]')
  ok('detach → LP window with the same launcher (both crates)', await until(() => h.pages.has('float-lp') && h.pages.get('float-lp').eval(`!!document.querySelector('.lpv .deck') && document.querySelectorAll('.lpv .filters [data-crate]').length === 2`), 8000))
  const lp = h.pages.get('float-lp')
  ok('LP window keeps its own drag (no OS caption region)', await lp.eval(`!document.querySelector('[data-tauri-drag-region]')`))
  // 끌기: 고스트 판이 커서 바로 밑에 (조상 transform 이 있어도) — 사용자 보고: 오른쪽에서 잡힘
  await sleep(600)
  const [rx, ry] = await lp.eval(`(() => { const r = document.querySelector('.lpv .crate [data-rec] .disc').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  await lp.mouse('mousePressed', rx, ry)
  await lp.mouse('mouseMoved', rx + 30, ry + 20, { buttons: 1 })
  await lp.mouse('mouseMoved', rx + 50, ry + 40, { buttons: 1 })
  const gc = await lp.eval(`(() => { const g = document.querySelector('.dragghost'); if (!g) return null; const r = g.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  await lp.mouse('mouseReleased', rx + 50, ry + 40)
  ok('dragged record sits under the cursor (±6px)', !!gc && Math.abs(gc[0] - (rx + 50)) <= 6 && Math.abs(gc[1] - (ry + 40)) <= 6, JSON.stringify({ gc, at: [rx + 50, ry + 40] }))
  void lp.clickSel('.float-btn[aria-label="닫기"]')
  ok('closing the LP window destroys it', await until(() => !h.pages.has('float-lp')))
  ok('no page errors', isl.errors.length + lp.errors.length === 0, [...isl.errors, ...lp.errors].slice(0, 2).join(' | '))
} catch (e) {
  ok('suite ran to the end', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
