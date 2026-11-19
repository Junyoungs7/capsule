// Tray panel + toast suite — HEADLESS only (headless.mjs, mocked IPC). The 368px panel: connection row + pairing, 3 tiles that persist,
// 선반 (native drop → shelf_add, 맥으로 보내기 needs the Mac file channel, 열기, 빼기, 맥에서 받음 label), 메모 (Enter saves, Shift+Enter = newline,
// latest 3, 모두 보기 → board), 꾸미기 switch, Esc hides, height reported for the window. Toast card: shows, times out, destroys itself.
//   node .omc/verify/panel-cdp.mjs
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('panel')
const h = await start()
const GEO = { x: 1540, y: 400, w: 368, h: 620 }
const called = (cmd, n0, f = () => true) => h.calls.slice(n0).some((c) => c[1] === cmd && f(c[2] ?? {}))
try {
  h.store.set('shelf:a', { id: 'a', path: 'C:\\Users\\me\\Desktop\\기획안_v3.pdf', at: Date.now() - 60_000, from: 'pc' })
  h.store.set('shelf:b', { id: 'b', path: 'C:\\Users\\me\\Downloads\\Hera\\IMG_2041.png', at: Date.now(), from: 'mac' })
  for (let i = 0; i < 4; i++) h.store.set(`note:m${i}`, { id: `m${i}`, text: `메모 ${i}`, color: i, x: 16, y: 16, w: 210, h: 140, at: 1000 + i })
  let p = await h.open('panel', { geo: GEO })
  await until(() => p.eval(`!!document.querySelector('.pn .tiles')`), 8000)

  /* 한 화면 구성 */
  ok('one screen: connection row · 3 tiles · 선반 · 메모 · 꾸미기 footer', await p.eval(`!!document.querySelector('.pn .peer .sw') && document.querySelectorAll('.pn .tile').length === 3 && /선반/.test(document.querySelector('.pn').textContent) && /메모/.test(document.querySelector('.pn').textContent) && /꾸미기/.test(document.querySelector('.pn .foot').textContent)`))
  ok('tile labels = 클립보드 공유 · 넘어갈 때 물결 · 흔들어 커서 찾기', (await p.eval(`[...document.querySelectorAll('.pn .tile small')].map((x) => x.textContent).join('|')`)) === '클립보드 공유|넘어갈 때 물결|흔들어 커서 찾기')
  ok('window height reported (panel_fit)', await until(() => called('panel_fit', 0, (a) => a.h > 200)))

  /* 타일 → store, 다시 열어도 그대로 */
  for (const k of ['clip', 'ripple', 'locator']) await p.eval(`document.querySelector('[data-tile=${k}]').click()`)
  ok('tiles off → link.share.clip · ripple.enabled · locator.enabled = false', await until(() => h.store.get('link.share')?.clip === false && h.store.get('ripple.enabled') === false && h.store.get('locator.enabled') === false))
  await h.closePage('panel')
  p = await h.open('panel', { geo: GEO })
  await until(() => p.eval(`!!document.querySelector('.pn .tiles')`), 8000)
  ok('toggles persist across a reload (aria-pressed false)', await until(() => p.eval(`[...document.querySelectorAll('.pn .tile')].every((t) => t.getAttribute('aria-pressed') === 'false')`)))

  /* 선반 */
  ok('shelf: newest first, 맥에서 받음 label on the received file', await until(() => p.eval(`(() => { const r = [...document.querySelectorAll('.pn .files li')]; return r.length === 2 && r[0].dataset.file === 'b' && /맥에서 받음/.test(r[0].textContent) && /이 PC/.test(r[1].textContent) })()`)))
  ok('맥으로 보내기 disabled without the Mac file channel ("맥 Hera 연결 필요")', await p.eval(`document.querySelector('[data-send=a]').disabled && document.querySelector('[data-send=a]').title === '맥 Hera 연결 필요'`))
  await h.emit('link-files', { kind: 'peer', state: 'ready', name: 'MacBook', code: '' })
  ok('…enabled once the Mac file channel is ready', await until(() => p.eval(`!document.querySelector('[data-send=a]').disabled`)))
  let n = h.calls.length
  await p.eval(`document.querySelector('[data-send=a]').click()`)
  ok('send → link_send(path) + "맥에 보냄" badge', (await until(() => called('link_send', n, (a) => a.path.endsWith('기획안_v3.pdf')))) && (await until(() => h.store.get('shelf:a')?.sent === true && p.eval(`/맥에 보냄/.test(document.querySelector('[data-file=a]').textContent)`))))
  n = h.calls.length
  await p.eval(`document.querySelector('[data-open=b]').click()`)
  ok('열기 → open_path', await until(() => called('open_path', n, (a) => a.path.endsWith('IMG_2041.png'))))
  await p.eval(`document.querySelector('[data-del=b]').click()`)
  ok('빼기 → shelf:b removed from the store', await until(() => !h.store.has('shelf:b') && p.eval(`!document.querySelector('[data-file=b]')`)))
  n = h.calls.length
  await h.emitTo('panel', 'tauri://drag-enter', { paths: ['C:\\x\\new.docx'], position: { x: 100, y: 200 } })
  ok('native drag over → drop area highlights', await until(() => p.eval(`document.querySelector('[data-drop]').classList.contains('over')`)))
  await h.emitTo('panel', 'tauri://drag-drop', { paths: ['C:\\x\\new.docx'], position: { x: 100, y: 200 } })
  ok('drop → shelf_add(paths) (Rust caps + dedups)', await until(() => called('shelf_add', n, (a) => a.paths?.[0] === 'C:\\x\\new.docx')))

  /* 메모 */
  ok('memos: latest 3 (by time)', (await p.eval(`[...document.querySelectorAll('.pn .memos li span')].map((x) => x.textContent).join('|')`)) === '메모 3|메모 2|메모 1')
  await p.clickSel('.pn .memo-in')
  await p.type('첫 줄')
  await p.eval(`document.querySelector('.pn .memo-in').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))`)
  ok('Shift+Enter does not save', !(await sleep(150), [...h.store.keys()].some((k) => k.startsWith('note:') && h.store.get(k).text?.startsWith('첫 줄'))))
  await p.key('Enter')
  ok('Enter saves a note:<id> with at, input clears, shows on top', await until(() => [...h.store.values()].some((v) => v?.text === '첫 줄' && v.at > 0) && p.eval(`document.querySelector('.pn .memo-in').value === '' && document.querySelector('.pn .memos li span').textContent === '첫 줄'`)))
  const firstKey = () => [...h.store.keys()].find((k) => k.startsWith('note:') && h.store.get(k)?.text === '첫 줄')
  const fid = firstKey().slice(5)
  await p.eval(`document.querySelector('[data-memo-del="${fid}"]').click()`)
  ok('메모 지우기 → note removed + 되돌리기 bar', await until(() => !firstKey() && p.eval(`!document.querySelector('[data-memo="${fid}"]') && /메모를 지웠어요/.test(document.querySelector('.undo-toast')?.textContent ?? '')`)))
  await p.eval(`document.querySelector('[data-undo]').click()`)
  ok('되돌리기 → same note back, bar gone', await until(() => firstKey() === 'note:' + fid && p.eval(`!!document.querySelector('[data-memo="${fid}"]') && !document.querySelector('.undo-toast')`)))
  n = h.calls.length
  await p.eval(`document.querySelector('[data-board]').click()`)
  ok('모두 보기 → board_open + panel hides', await until(() => called('board_open', n) && called('panel_hide', n)))

  /* 페어링 · 꾸미기 · Esc · 설정 */
  await h.emit('link-files', { kind: 'peer', state: 'pairing', name: 'MacBook', code: '482913' })
  ok('pairing in the panel: 482 913 + 같아요/아니요', await until(() => p.eval(`/482 913/.test(document.querySelector('.pn .pair')?.textContent ?? '')`)))
  n = h.calls.length
  await p.eval(`document.querySelector('.pn [data-pair=ok]').click()`)
  ok('같아요 → link_pair(true), box goes away', (await until(() => called('link_pair', n, (a) => a.ok === true))) && (await until(() => p.eval(`!document.querySelector('.pn .pair')`))))
  ok('꾸미기 default off', await p.eval(`document.querySelector('.pn .foot .sw').getAttribute('aria-checked') === 'false'`))
  await p.eval(`document.querySelector('.pn .foot .sw').click()`)
  ok('꾸미기 switch → deco.enabled = true', await until(() => h.store.get('deco.enabled') === true))
  n = h.calls.length
  await p.key('Escape')
  ok('Esc → panel_hide', await until(() => called('panel_hide', n)))
  n = h.calls.length
  await p.eval(`document.querySelector('[data-settings]').click()`)
  ok('설정 → settings_open', await until(() => called('settings_open', n)))
  await h.closePage('settings')
  ok('no page errors (panel)', p.errors.length === 0, p.errors.join(' | '))

  /* 알림 카드 */
  h.handlers.toast_next = () => ({ kind: 'recv', title: '맥에서 파일을 받았어요', sub: 'IMG_2041.png · 선반과 다운로드\\Hera에 있어요' })
  n = h.calls.length
  const t = await h.open('toast', { geo: { x: 1544, y: 948, w: 364, h: 72 } })
  ok('toast shows the pending card', await until(() => t.eval(`/맥에서 파일을 받았어요/.test(document.querySelector('.toast')?.textContent ?? '')`), 8000))
  await h.emitTo('toast', 'toast', { kind: 'sent', title: '맥으로 보냈어요', sub: 'a.pdf' })
  ok('a new toast replaces the card', await until(() => t.eval(`document.querySelector('.toast').dataset.kind === 'sent'`)))
  ok('…then slides out and destroys its window (toast_done)', await until(() => called('toast_done', n), 7000))
} catch (e) {
  ok('suite ran', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
