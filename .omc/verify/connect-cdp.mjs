// (a6) 연결 suite — HEADLESS only (headless.mjs). Hub 연결 icon (two screens) carries a status dot + one-line summary,
// the in-Island 연결 view (status chip · Link switch · devices · 6 shares · pairing digits · '설정에서 자세히'),
// and "채팅 알림은 커서가 있는 PC 에서만": with the cursor on the Mac the pet stays quiet, switch it off and the pet tells you here.
// Fake Rust only (link-status / link-files events) — never touches Deskflow or port 24800.   node .omc/verify/connect-cdp.mjs
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('connect')
const h = await start()
try {
  const isl = await h.open('island')
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(400)
  const hub = async () => {
    if (await isl.eval(`document.querySelector('.isl').dataset.open === 'true'`)) {
      if (await isl.eval(`!!document.querySelector('.isl .view')`)) await isl.clickSel('.isl .view [data-back]')
    } else await isl.clickSel('.isl .petbox')
    await until(() => isl.eval(`document.querySelector('.isl .skin').offsetWidth === 432 && !!document.querySelector('.hub .app[data-go=link]')`))
    await sleep(300)
  }
  await hub()
  ok('hub icon is 연결 (two screens) with a grey dot while Link is off, no summary line', await isl.eval(`document.querySelector('.hub .app[data-go=link]').textContent.trim() === '연결' && document.querySelector('.hub .app[data-go=link] .sdot').dataset.sdot === 'off' && !document.querySelector('.hub .linkline')`))
  // 연결됨 (가짜 Rust 이벤트)
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: 'link.enabled', value: true })`)
  await h.emit('link-status', { state: 'connected', detail: '', peer: 'MacBook Pro', onPeer: false, fingerprint: '' })
  ok('connected → green dot + summary line "MacBook Pro 와 연결됨"', await until(() => isl.eval(`document.querySelector('.hub .app[data-go=link] .sdot').dataset.sdot === 'ok' && /MacBook Pro 와 연결됨/.test(document.querySelector('.hub .linkline')?.textContent ?? '')`)))
  await isl.clickSel('.hub .linkline')
  ok('summary line opens the 연결 view (420 wide, content-sized)', await until(() => isl.eval(`!!document.querySelector('.view[data-k=link] .lnk') && document.querySelector('.isl .skin').offsetWidth === 420`)))
  await sleep(600)
  ok('view head: 연결됨 chip + Link switch on', await isl.eval(`document.querySelector('.view[data-k=link] .vhead .lchip').dataset.link === 'ok' && document.querySelector('.view[data-k=link] [data-linkon]').getAttribute('aria-pressed') === 'true'`))
  const shares = await isl.eval(`[...document.querySelectorAll('.view[data-k=link] .share')].map((b) => b.dataset.share).join()`)
  ok('6 shares: input · clip · files · sync · chat · fx', shares === 'input,clip,files,sync,chat,fx', shares)
  await isl.clickSel('.view[data-k=link] .share[data-share=files]')
  ok('tap 파일 → link.share.files = false (drop target to the Mac goes away)', await until(() => h.store.get('link.share')?.files === false && isl.eval(`document.querySelector('.view[data-k=link] .share[data-share=files]').classList.contains('off')`)))
  await isl.clickSel('.view[data-k=link] .share[data-share=files]')
  // 페어링 숫자
  await h.emit('link-files', { kind: 'peer', state: 'pairing', name: 'DESKTOP-7Q2K', code: '105273' })
  ok('pairing → digits drop in, one by one (6)', await until(() => isl.eval(`document.querySelector('.view[data-k=link] .pairbox .code')?.dataset.code === '105273' && document.querySelectorAll('.view[data-k=link] .pairbox .code span').length === 6`)))
  let n = h.calls.length
  await isl.clickSel('.view[data-k=link] .pairbox [data-pair=no]')
  ok('취소 → link_pair(ok: false)', await until(() => h.calls.slice(n).some((c) => c[1] === 'link_pair' && c[2].ok === false)))
  await h.emit('link-files', { kind: 'peer', state: 'ready', name: 'MacBook Pro', code: '' })
  await until(() => isl.eval(`!document.querySelector('.view[data-k=link] .pairbox')`))
  n = h.calls.length
  await isl.clickSel('.view[data-k=link] [data-opensec=link]')
  ok('설정에서 자세히 → settings window, 연결 section', await until(() => h.pages.has('settings') && h.calls.slice(n).some((c) => c[1] === 'settings_open' && c[2].sec === 'link')))
  const sw = h.pages.get('settings')
  ok('…opened on 연결', await until(() => sw.eval(`document.querySelector('.swin .pin')?.dataset.pane === 'link'`), 8000))
  await h.closePage('settings')
  // Link 끄기 = 헤더 스위치
  await isl.clickSel('.isl .petbox').catch(() => {})
  await hub()
  await isl.clickSel('.hub .app[data-go=link]')
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=link] [data-linkon]')`))
  await sleep(500)
  n = h.calls.length
  await isl.clickSel('.view[data-k=link] [data-linkon]')
  ok('head switch off → link.enabled = false + link_apply', (await until(() => h.store.get('link.enabled') === false)) && (await until(() => h.calls.slice(n).some((c) => c[1] === 'link_apply'), 3000)))
  await isl.key('Escape')
  await until(() => isl.eval(`document.querySelector('.isl').dataset.open === 'false'`))
  await sleep(500)

  /* 채팅 알림은 커서가 있는 PC 에서만 */
  await h.emit('link-status', { state: 'connected', detail: '', peer: 'MacBook Pro', onPeer: true, fingerprint: '' })
  await h.emit('chat-msg', { id: 'm1', group: 'g', by: '민수', kind: 'text', text: '회의 3시', at: Date.now() })
  await sleep(1200)
  ok('cursor on the Mac + 채팅 알림 switch on → the pet here stays quiet', await isl.eval(`!/회의 3시/.test(document.querySelector('.isl .ptext')?.textContent ?? '')`))
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: 'link.share', value: { chat: false } })`)
  await h.emit('chat-msg', { id: 'm2', group: 'g', by: '민수', kind: 'text', text: '회의 4시', at: Date.now() })
  ok('switch off → the pet tells you here too', await until(() => isl.eval(`/회의 4시/.test(document.querySelector('.isl .ptext')?.textContent ?? '')`)))
  ok('no page errors', isl.errors.length + sw.errors.length === 0, [...isl.errors, ...sw.errors].slice(0, 2).join(' | '))
} catch (e) {
  ok('suite ran to the end', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
