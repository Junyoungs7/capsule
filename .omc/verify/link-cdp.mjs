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

const dock = await page('island') // Island-only: 독 없음 — 선반·받은 파일은 아일랜드가 맡는다
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
  const shelf = await dock.evaluate(`(async () => { const I = window.__TAURI_INTERNALS__; const rid = await I.invoke('plugin:store|get_store', { path: 'hera.json' }); return (await I.invoke('plugin:store|entries', { rid })).filter(([k]) => k.startsWith('shelf:')).map(([, v]) => v.path).join(', ') })()`)
  ok('received file is on the shelf (island)', shelf.length > 0, `(${shelf})`)
  // 3b: 맥 모니터 보고 → 배치에 반영, 동기화된 할 일, 상대 화면 효과(달·별) 창, Hera 가 보낸 동기화 스냅숏
  const [mons] = await dock.evaluate(inv('link_plan'))
  ok('Mac monitors from the link appear in the layout', mons.filter((m) => m.mac).map((m) => m.id).join(',') === 'TestMac A,TestMac B', `(${mons.map((m) => (m.mac ? 'mac:' : 'pc:') + m.id).join(' ')})`)
  const todo = await dock.evaluate(`(async () => { const I = window.__TAURI_INTERNALS__; const rid = await I.invoke('plugin:store|get_store', { path: 'hera.json' }); return I.invoke('plugin:store|get', { rid, key: 'todo:hera-live-test' }) })()`)
  ok('synced todo landed in the store', JSON.stringify(todo).includes('맥에서 온 할 일'), `(${JSON.stringify(todo)})`)
  const fxOpen = (await (await fetch('http://127.0.0.1:9333/json')).json()).some((p) => p.url.includes('surface=fx'))
  ok('ambient fx from the peer opened the effect window', fxOpen)
  ok('Hera sent its own sync snapshot + monitors + keymap', /"t":"sync"/.test(r.out) && /"t":"monitors"/.test(r.out) && /"t":"keymap"/.test(r.out))
  ok('edge-dropped file metadata arrived', /SEND Ok/.test(r.out))
}
// 정리: 링크 끄기 (격리 store)
await dock.evaluate(storeSet('link.enabled', false))
await dock.evaluate(inv('link_apply'))
dock.close()
island.close()
