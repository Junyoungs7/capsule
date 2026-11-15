// Hera Link checks on a release build over CDP. Use an ISOLATED identifier so the user's installed Hera / store are untouched:
//   npx tauri build --no-bundle --config '{"identifier":"dev.hera.linktest"}'
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'; start src-tauri\target\release\hera.exe
//   $env:HERA_LINK_SEND=<file-to-send>; node .omc/verify/link-cdp.mjs
// Never touches port 24800 or the user's Deskflow: the engine config uses 24900, and with Deskflow running the engine must report 'blocked'.
import { page, storeSet } from './cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const inv = (cmd, args = {}) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
const ok = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`)
const file = process.env.HERA_LINK_SEND // (인자로 주면 cdp.mjs 의 CLI 가 반응한다)

const dock = await page('dock')
const island = await page('island')
let [st, files] = await dock.evaluate(inv('link_status'))
ok('link off by default', st.state === 'off' && files === null, `(${st.state})`)

await dock.evaluate(storeSet('link.cfg', { me: 'HeraTest', peer: 'TestMac', side: 'right', port: 24900, tls: false, doubleTap: false, filePort: 24810 }))
await dock.evaluate(storeSet('link.enabled', true))
await dock.evaluate(inv('link_apply'))
await sleep(2500)
;[st] = await dock.evaluate(inv('link_status'))
ok("engine reports 'blocked' while the user's Deskflow runs", st.state === 'blocked' && /Deskflow/.test(st.detail), `(${st.state}: ${st.detail})`)

if (file) {
  // 맥 역할 시험 클라이언트 (Rust, link_files::tests::live_peer) — 페어링 코드는 Hera Island 에 뜬다
  const child = import('node:child_process').then(({ spawn }) =>
    new Promise((res) => {
      const p = spawn('cargo', ['test', '--lib', 'live_peer', '--', '--ignored', '--nocapture'], { cwd: 'src-tauri', env: { ...process.env, HERA_LINK_ADDR: '127.0.0.1:24810', HERA_LINK_FILE: file }, shell: true })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (out += d))
      p.on('close', (code) => res({ code, out }))
    }),
  )
  let code = ''
  for (let i = 0; i < 120 && !code; i++) {
    await sleep(500)
    code = await island.evaluate(`document.querySelector('.island')?.dataset.mode === 'pair' ? document.querySelector('.pair .code')?.textContent : ''`)
  }
  ok('Island shows the 6-digit pairing code', /^\d{3} \d{3}$/.test(code), `(${code})`)
  await island.evaluate(inv('link_pair', { ok: true }))
  const r = await child
  const sent = /SEND Ok\(\(\)\)/.test(r.out)
  ok('fake Mac paired and sent a file (ack ok)', sent && r.code === 0, sent ? '' : r.out.split('\n').filter((l) => /EVENT|SEND|panicked/.test(l)).join(' | '))
  const peer = r.out.match(/"kind":"peer","state":"pairing","name":"[^"]*","code":"(\d+)"/)?.[1]
  ok('both sides derived the same code', peer && peer === code.replace(' ', ''), `(mac ${peer})`)
  await sleep(800)
  const shelf = await dock.evaluate(`[...document.querySelectorAll('.shelf-file')].map(b => b.getAttribute('aria-label')).join(', ')`)
  ok('received file is on the dock shelf', /열기/.test(shelf), `(${shelf})`)
  const [, f2] = await dock.evaluate(inv('link_status'))
  console.log(`   files peer after close: ${f2}`)
}
// 정리: 링크 끄기 (격리 store)
await dock.evaluate(storeSet('link.enabled', false))
await dock.evaluate(inv('link_apply'))
dock.close()
island.close()
