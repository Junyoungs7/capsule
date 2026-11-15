// 팀 채팅 on the ISOLATED build (see island-cdp.mjs header). Real two-PC transfer is covered by `cargo test chat` (team::chat_messages_and_files).
// Never touches the user's clipboard (clip_files is not called).
import { page, PORT, storeSet } from './cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const has = async (q) => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).some((x) => x.type === 'page' && x.url.includes(q))
const inv = (cmd, args = {}) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
const entries = (prefix) => `(async () => { const I = window.__TAURI_INTERNALS__; const rid = await I.invoke('plugin:store|get_store', { path: 'hera.json' }); return (await I.invoke('plugin:store|entries', { rid })).filter(([k]) => k.startsWith(${JSON.stringify(prefix)})).map(([, v]) => v) })()`
let fails = 0
const ok = (name, cond, extra = '') => (console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`), cond || fails++)
const until = async (f, ms = 6000) => {
  for (let t = 0; t < ms; t += 150) {
    if (await f()) return true
    await sleep(150)
  }
  return false
}

const island = await page('island')
const st = await island.evaluate(inv('team_state'))
let g = st.groups.find((x) => x.name === 'CDP채팅')
if (!g) g = await island.evaluate(inv('team_create', { name: 'CDP채팅', color: '#8b5cf6' }))
await island.evaluate(storeSet('chat.group', g.id))

await island.evaluate(inv('float_open', { f: 'chat' }))
ok('chat window opens', await until(() => has('f=chat')))
const chat = await page('float&f=chat')
ok('room for the share group', await until(() => chat.evaluate(`/CDP채팅/.test(document.querySelector('.chat-head')?.textContent ?? '')`)))

// 텍스트 보내기 → chat:<id> {group, byPk}
await chat.evaluate(`(() => { const i = document.querySelector('.chat-input input:not([type=file])'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '안녕 CDP'); i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.chat-input .primary').click() })()`)
ok('text message stored for the group', await until(async () => (await island.evaluate(entries('chat:'))).some((m) => m.text === '안녕 CDP' && m.group === g.id && m.byPk === st.pk)))
ok('bubble rendered', await until(() => chat.evaluate(`[...document.querySelectorAll('.chat-bubble')].some((b) => b.textContent === '안녕 CDP')`)))

// '+' 첨부 경로 = 바이트 → chat_attach (1x1 PNG)
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
await chat.evaluate(`(async () => { const b = Uint8Array.from(atob('${png}'), (c) => c.charCodeAt(0)); return window.__TAURI_INTERNALS__.invoke('chat_attach', b, { headers: { 'x-group': '${g.id}', 'x-name': encodeURIComponent('점.png') } }) })()`)
ok('image message stored (fid, from = me)', await until(async () => (await island.evaluate(entries('chat:'))).some((m) => m.kind === 'image' && m.name === '점.png' && m.fid && m.from === st.pk)))
ok('own file path recorded (chatin:)', await until(async () => (await island.evaluate(entries('chatin:'))).some((p) => /점\.png$/.test(p))))
ok('image thumbnail via asset protocol', await until(() => chat.evaluate(`[...document.querySelectorAll('.chat-img img')].some((i) => i.src.includes('asset') && i.naturalWidth === 1)`), 6000))
const big = await chat.evaluate(inv('chat_send_paths', { group: g.id, paths: ['C:\\definitely\\missing.bin'] })).then(() => 'ok', (e) => String(e))
ok('missing path rejected', big !== 'ok', big)

// Island: 받은 메시지 알림 + 빠른 답장 (원격 수신을 이벤트로 흉내)
await island.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'chat-msg', payload: { id: 'r1', group: '${g.id}', by: '민수', byPk: 'ff', kind: 'text', text: '내일 3시 회의 어때요?', at: Date.now() } })`)
ok('island shows the message pill', await until(() => island.evaluate(`document.querySelector('.island').dataset.mode === 'msg'`)))
await island.evaluate(`(() => { const i = document.querySelector('.msg-reply input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '좋아요'); i.dispatchEvent(new Event('input', { bubbles: true })); i.form.requestSubmit() })()`)
ok('quick reply stored in the room', await until(async () => (await island.evaluate(entries('chat:'))).some((m) => m.text === '좋아요' && m.group === g.id)))
ok('pill returns to idle', await until(() => island.evaluate(`document.querySelector('.island').dataset.mode !== 'msg'`)))

// 선반에 (shelf_add → island)
const img = (await island.evaluate(entries('chatin:'))).find((p) => /점\.png$/.test(p))
await chat.evaluate(inv('shelf_add', { path: img }))
ok('선반에 → island shelf', await until(async () => (await island.evaluate(entries('shelf:'))).some((f) => f.path === img)))

void chat.evaluate(inv('float_close'))
chat.close()
island.close()
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
process.exit(fails ? 1 : 0)
