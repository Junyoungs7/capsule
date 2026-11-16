// (a3) Team chat suite — HEADLESS only (headless.mjs). Two-PC transfer + file P2P = `cargo test team::chat_messages_and_files`.
// Incoming message → pet perks up (bubble with count) + pill → tap → chat view in the Island (unread cleared) → send → chat:<id> stored.
//   node .omc/verify/chat-cdp.mjs
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('chat')
const h = await start()
try {
  h.handlers.team_state = () => ({ name: '나', pk: 'me', groups: [{ id: 'g1', name: '개발팀', color: '#14b8a6', members: [{ name: '나', pk: 'me' }, { name: '민수', pk: 'ff' }], alarms: true, news: true }], online: ['ff'] })
  h.store.set('chat.group', 'g1')
  const isl = await h.open('island')
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(400)
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: 'chat.unread', value: 2 })`)
  await h.emit('chat-msg', { id: 'r1', group: 'g1', by: '민수', byPk: 'ff', kind: 'text', text: '내일 3시 회의 어때요?', at: Date.now() })
  ok('message → chat pose + pill (who · text)', await until(() => isl.eval(`document.querySelector('.isl .pet').dataset.s === 'chat' && /민수/.test(document.querySelector('.isl .ptext').textContent) && /3시 회의/.test(document.querySelector('.isl .ptext').textContent)`)))
  ok('speech bubble shows the unread count', await isl.eval(`document.querySelector('.isl .pet .acc.bubble').textContent === '2'`))
  await isl.clickSel('.isl .ptext')
  ok('tapping the pill opens the chat view in the Island', await until(() => isl.eval(`!!document.querySelector('.view[data-k=chat] .chat-input')`)))
  ok('…and clears unread', await until(() => h.store.get('chat.unread') === 0))
  await sleep(600)
  await isl.clickSel('.view[data-k=chat] .chat-input input:not([type=file])')
  await isl.type('좋아요 3시에 봐요')
  await isl.key('Enter')
  ok('send → chat:<id> stored for the group', await until(() => [...h.store].some(([k, v]) => k.startsWith('chat:') && v?.text === '좋아요 3시에 봐요' && v.group === 'g1' && v.byPk === 'me')))
  ok('bubble rendered in the view', await until(() => isl.eval(`[...document.querySelectorAll('.view[data-k=chat] .chat-bubble')].some((b) => b.textContent === '좋아요 3시에 봐요')`)))
  await isl.key('Escape')
  ok('Esc folds it; pose returns to normal (no unread)', await until(() => isl.eval(`document.querySelector('.isl').dataset.open === 'false' && document.querySelector('.isl .pet').dataset.s !== 'chat'`), 8000))
  ok('no page errors', isl.errors.length === 0, isl.errors.slice(0, 2).join(' | '))
} catch (e) {
  ok('suite ran to the end', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
