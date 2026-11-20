// Talk suite — HEADLESS only (headless.mjs, mocked IPC). 전체 톡 창: history, Enter sends (Shift+Enter = newline), incoming 'talk' event,
// file drop → talk_file, + 초대 (online people only) → talk_invite, 지우기 (two clicks) → talk_clear, unread reset (talk_read).
// 빠른 톡: panel 'quick' view → favourites online only, Enter → poke_send, ⋯ = pet menu. Received poke in the drag overlay: face + bubble,
// click closes it (no reply), the overlay hides when the last one is gone. Panel: 내 이름 card, ⭐ toggles people:<pk>.fav, 톡 button + unread.
//   node .omc/verify/talk-cdp.mjs
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('talk')
const h = await start()
const called = (cmd, n0, f = () => true) => h.calls.slice(n0).some((c) => c[1] === cmd && f(c[2] ?? {}))
const A = 'a'.repeat(64), B = 'b'.repeat(64)
try {
  h.store.set(`people:${A}`, { id: A, name: '박지윤', at: 1, fav: true })
  h.store.set(`people:${B}`, { id: B, name: '최서현', at: 2 })
  h.store.set('talk.unread', 3)
  h.handlers.people_near = () => [{ pk: A, name: '박지윤', known: true }]
  h.handlers.talk_list = () => [
    { id: 'm1', at: Date.now() - 60_000, from: A, name: '박지윤', text: '점심 뭐 먹어요?' },
    { id: 'm2', at: Date.now() - 50_000, from: A, name: '박지윤', text: '국밥?' },
    { id: 'm3', at: Date.now() - 40_000, from: 'me', text: '좋아요' },
  ]

  /* 톡 창 */
  const t = await h.open('talk', { geo: { x: 200, y: 200, w: 380, h: 560 } })
  await until(() => t.eval(`document.querySelectorAll('[data-msg]').length === 3`), 8000)
  ok('history: 3 messages, mine on the right, same sender grouped', await t.eval(`(() => { const m = [...document.querySelectorAll('.m')]; return m[2].classList.contains('me') && m[1].classList.contains('cont') && !m[0].classList.contains('cont') })()`))
  ok('opening the window clears unread (talk_read)', called('talk_read', 0))
  ok('header: 2 people · 1 online, offline person named in the hint', await t.eval(`/2명 · 1명 켜짐/.test(document.querySelector('[data-talk-count]').textContent) && /최서현님은 지금 꺼져 있어/.test(document.querySelector('.hint').textContent)`))
  let n = h.calls.length
  await t.eval(`(() => { const ta = document.querySelector('[data-talk-in]'); ta.focus() })()`)
  await t.send('Input.insertText', { text: '네 알겠어요' })
  await t.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  ok('Enter → talk_send(text), input cleared', (await until(() => called('talk_send', n, (a) => a.text === '네 알겠어요'))) && (await until(() => t.eval(`document.querySelector('[data-talk-in]').value === ''`))))
  await h.emit('talk', { id: 'm4', at: Date.now(), from: A, name: '박지윤', text: '회의 3시로 미뤄졌어요' })
  ok('incoming talk event appears at the bottom', await until(() => t.eval(`document.querySelector('[data-talk-list]').lastElementChild.textContent.includes('회의 3시로')`)))
  await h.emit('talk', { id: 'm4', at: Date.now(), from: A, name: '박지윤', text: '회의 3시로 미뤄졌어요' })
  ok('same id twice → shown once', await sleep(150).then(() => t.eval(`[...document.querySelectorAll('.b')].filter((b) => b.textContent.includes('회의 3시로')).length === 1`)))
  await h.emit('talk', { id: 'm5', at: Date.now(), from: 'me', file: { name: '견적서.pdf', size: 1258291 } })
  ok('file card with size', await until(() => t.eval(`/견적서.pdf/.test(document.querySelector('.file')?.textContent) && /1.2MB/.test(document.querySelector('.file').textContent)`)))
  n = h.calls.length
  await h.emitTo('talk', 'tauri://drag-drop', { paths: ['C:/x/회의자료.pdf'], position: { x: 190, y: 300 } })
  ok('file dropped on the window → talk_file(paths)', await until(() => called('talk_file', n, (a) => a.paths[0] === 'C:/x/회의자료.pdf')))
  await t.eval(`document.querySelector('[data-invite]').click()`)
  ok('+ 초대: offline person disabled', await until(() => t.eval(`document.querySelector('[data-inv-pk="${B}"]').disabled && !document.querySelector('[data-inv-pk="${A}"]').disabled`)))
  n = h.calls.length
  await t.eval(`document.querySelector('[data-inv-pk="${A}"]').click()`)
  await t.eval(`document.querySelector('[data-inv-go]').click()`)
  ok('초대하기 → talk_invite([pk])', await until(() => called('talk_invite', n, (a) => a.pks.length === 1 && a.pks[0] === A)))
  n = h.calls.length
  await t.eval(`document.querySelector('[data-talk-clear]').click()`)
  ok('지우기 needs a second click', await sleep(100).then(() => !called('talk_clear', n) && t.eval(`document.querySelector('[data-talk-clear]').classList.contains('danger')`)))
  await t.eval(`document.querySelector('[data-talk-clear]').click()`)
  ok('second click → talk_clear', await until(() => called('talk_clear', n)))
  ok('talk window: no page errors', t.errors.length === 0, t.errors.join(' | '))

  /* 패널: 내 이름 · ⭐ · 톡 단추 */
  const p = await h.open('panel', { geo: { x: 1540, y: 300, w: 368, h: 760 } })
  await until(() => p.eval(`!!document.querySelector('[data-people]')`), 8000)
  ok('no name yet → 내 이름 card', await until(() => p.eval(`!!document.querySelector('[data-myname]')`)))
  await p.eval(`document.querySelector('[data-myname] input').focus()`)
  await p.send('Input.insertText', { text: '김준영' })
  await p.eval(`document.querySelector('[data-myname-save]').click()`)
  ok('저장 → people.name, card gone', await until(() => h.store.get('people.name') === '김준영' && p.eval(`!document.querySelector('[data-myname]')`)))
  ok('톡 button shows unread 3', await until(() => p.eval(`document.querySelector('[data-unread]')?.textContent === '3'`)))
  n = h.calls.length
  await p.eval(`document.querySelector('[data-talk]').click()`)
  ok('톡 → talk_open', await until(() => called('talk_open', n)))
  await p.eval(`document.querySelector('[data-fav="${B}"]').click()`)
  ok('⭐ → people:<pk>.fav = true', await until(() => h.store.get(`people:${B}`)?.fav === true))

  /* 빠른 톡 (패널 quick 보기) */
  await h.emitTo('panel', 'panel-show', 'quick')
  ok('quick view: only online favourites (박지윤), input focused', await until(() => p.eval(`/친한 친구 1명에게/.test(document.querySelector('[data-quick-to]').textContent) && document.activeElement === document.querySelector('[data-quick-in]')`)))
  await p.send('Input.insertText', { text: '오늘 회식 어때요?' })
  n = h.calls.length
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  ok('Enter → poke_send(text) and the panel hides', (await until(() => called('poke_send', n, (a) => a.text === '오늘 회식 어때요?'))) && called('panel_hide', n))
  await h.emitTo('panel', 'panel-show', 'quick')
  await p.eval(`document.querySelector('[data-quick-more]').click()`)
  ok('⋯ → pet menu (effects + image/home)', await until(() => p.eval(`!!document.querySelector('[data-quick] [data-fx]') && !!document.querySelector('[data-quick] [data-pet-home]')`)))
  ok('panel: no page errors', p.errors.length === 0, p.errors.join(' | '))

  /* 받은 빠른 톡 (끌기 오버레이) */
  const d = await h.open('drag', { geo: { x: 0, y: 0, w: 1920, h: 1079 } })
  await until(() => d.eval(`!!document.querySelector('canvas.portal')`), 8000)
  await h.emitTo('drag', 'poke', { from: A, name: '박지윤', text: '점심 뭐 먹어요? 🍜', x: 1440, y: 930 })
  ok('poke: face + bubble above the pet', await until(() => d.eval(`(() => { const e = document.querySelector('[data-poke]'); if (!e) return false; const b = e.getBoundingClientRect(); return /박지윤/.test(e.textContent) && /점심/.test(e.textContent) && b.bottom <= 930 })()`)))
  ok('the bubble is a hit rect (clickable)', await until(() => (h.hits.get('drag') ?? []).length === 1))
  n = h.calls.length
  const c = await d.eval(`(() => { const b = document.querySelector('[data-poke] .bb').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
  await d.click(c.x, c.y)
  ok('click → closes (no reply input), overlay hides', (await until(() => d.eval(`!document.querySelector('[data-poke]')`))) && (await until(() => called('drag_hide', n))) && !called('pet_click', n))
  ok('overlay: no page errors', d.errors.length === 0, d.errors.join(' | '))
} catch (e) {
  ok('suite ran', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
