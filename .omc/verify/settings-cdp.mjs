// Settings window suite — HEADLESS only (headless.mjs). Native-framed Windows window, 4 sections (일반 · 연결 · 꾸미기 · 정보),
// every switch writes the real store key, 연결 tabs, pairing code, Deskflow import = one call, 꾸미기 pet picker → pet.kind,
// 설정 폴더 shows the real folder (dev.hera.dock).   node .omc/verify/settings-cdp.mjs
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('settings')
const h = await start()
try {
  h.handlers.autostart = (p, a) => (a.on === undefined || a.on === null ? false : a.on)
  h.handlers.link_import = () => ({ me: 'DESK', peer: 'MacBook Pro', side: 'right', port: 24800, tls: true, doubleTap: false, filePort: 24810, keymap: 'habit', keyRows: [], ime: 'hera' })
  const sw = await h.open('settings&sec=general', { label: 'settings', geo: { x: 600, y: 200, w: 720, h: 600 } })
  await until(() => sw.eval(`!!document.querySelector('.set nav')`), 8000)
  const nav = await sw.eval(`[...document.querySelectorAll('.set nav [data-sec]')].map((b) => b.textContent.trim())`)
  ok('4 sections: 일반 · 연결 · 꾸미기 · 정보', nav.join('|') === '일반|연결|꾸미기|정보', nav.join('|'))
  ok('no removed features anywhere (캡슐 · 채팅 · 터미널 · 단축키 · 할 일 · MCP)', await sw.eval(`!/캡슐|채팅|터미널|단축키|할 일|MCP|아라/.test(document.body.textContent)`))
  const row = (t) => `[...document.querySelectorAll('.set .row')].find((r) => r.querySelector('.tt b')?.textContent.startsWith(${JSON.stringify(t)}))`
  const press = (t) => sw.eval(`${row(t)}.querySelector('.sw').click()`)

  /* 일반 */
  ok('설정 폴더 = %APPDATA%\\dev.hera.dock (not com.hera.app)', await sw.eval(`/dev\\.hera\\.dock/.test(${row('설정 폴더')}.textContent) && !/com\\.hera\\.app/.test(document.body.textContent)`))
  let n = h.calls.length
  await press('Windows 시작 시')
  ok('autostart switch → Rust autostart(on: true)', await until(() => h.calls.slice(n).some((c) => c[1] === 'autostart' && c[2].on === true)))
  await press('클립보드 공유')
  ok('클립보드 공유 off → link.share.clip = false', await until(() => h.store.get('link.share')?.clip === false))
  await press('넘어갈 때 물결')
  ok('넘어갈 때 물결 off → ripple.enabled = false', await until(() => h.store.get('ripple.enabled') === false))
  await press('흔들어 커서 찾기')
  ok('흔들어 커서 찾기 off → locator.enabled = false', await until(() => h.store.get('locator.enabled') === false))

  /* 연결 */
  await sw.eval(`document.querySelector('.set nav [data-sec=link]').click()`)
  await until(() => sw.eval(`document.querySelector('.set main').dataset.pane === 'link'`))
  const tabs = await sw.eval(`[...document.querySelectorAll('.set [data-ltab]')].map((b) => b.textContent)`)
  ok('연결 tabs: 기기 · 화면 배치 · 키보드 · 고급', tabs.join('|') === '기기|화면 배치|키보드|고급', tabs.join('|'))
  n = h.calls.length
  await sw.eval(`document.querySelector('.set main .row .sw').click()`)
  ok('연결 switch → link.enabled + link_apply', (await until(() => h.store.get('link.enabled') === true)) && (await until(() => h.calls.slice(n).some((c) => c[1] === 'link_apply'), 3000)))
  await h.emit('link-files', { kind: 'peer', state: 'pairing', name: 'MacBook', code: '482913' })
  ok('pairing → 6 digits "482 913" + 같아요/아니요', await until(() => sw.eval(`document.querySelector('.set .pair')?.dataset.code === '482913' && /482 913/.test(document.querySelector('.set .pair').textContent) && !!document.querySelector('[data-pair=ok]') && !!document.querySelector('[data-pair=no]')`)))
  n = h.calls.length
  await sw.eval(`document.querySelector('[data-pair=ok]').click()`)
  ok('같아요 → link_pair(true)', await until(() => h.calls.slice(n).some((c) => c[1] === 'link_pair' && c[2].ok === true)))
  await sw.eval(`document.querySelector('[data-ltab=keyboard]').click()`)
  await until(() => sw.eval(`!!document.querySelector('[data-keymap=position]')`))
  await sw.eval(`document.querySelector('[data-keymap=position]').click()`)
  ok('키 위치대로 → link.cfg.keymap = position', await until(() => h.store.get('link.cfg')?.keymap === 'position'))
  await sw.eval(`document.querySelector('[data-ltab=adv]').click()`)
  n = h.calls.length
  await until(() => sw.eval(`!!document.querySelector('[data-import]')`))
  await sw.eval(`document.querySelector('[data-import]').click()`)
  ok('Deskflow 가져오기 = one read-only link_import call', await until(() => h.calls.slice(n).filter((c) => c[1] === 'link_import').length === 1))

  /* 꾸미기 */
  await sw.eval(`document.querySelector('.set nav [data-sec=deco]').click()`)
  await until(() => sw.eval(`document.querySelector('.set main').dataset.pane === 'deco'`))
  ok('꾸미기 default OFF', await sw.eval(`${row('꾸미기')}.querySelector('.sw').getAttribute('aria-checked') === 'false'`))
  await press('꾸미기')
  ok('꾸미기 on → deco.enabled = true', await until(() => h.store.get('deco.enabled') === true))
  await sw.eval(`document.querySelector('[data-pettab=pixel]').click()`)
  await until(() => sw.eval(`!!document.querySelector('[data-pet-set=penguin]')`))
  await sw.eval(`document.querySelector('[data-pet-set=penguin]').click()`)
  ok('built-in pet picker → pet.kind = penguin (no custom pet import/editor)', (await until(() => h.store.get('pet.kind') === 'penguin')) && (await sw.eval(`!/내 펫|가져오기 zip|펫 추가/.test(document.body.textContent)`)))
  await sw.eval(`${row('대기 시간')}.querySelector('[aria-label=늘리기]').click()`)
  ok('자리 비움 대기 + → ascii.idleMin 11', await until(() => h.store.get('ascii.idleMin') === 11))

  /* 다른 창이 다른 섹션을 요청 */
  await h.emitTo('settings', 'settings-sec', 'about')
  ok('settings-sec event jumps to 정보', await until(() => sw.eval(`document.querySelector('.set main').dataset.pane === 'about'`)))
  ok('no page errors', sw.errors.length === 0, sw.errors.join(' | '))
} catch (e) {
  ok('suite ran', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
