// 미니 터미널 on the ISOLATED build. ARA handoff uses a FAKE CLI — never creates tabs in the user's ARA:
//   $env:HERA_ARA_CLI = "$PWD\.omc\verify\fake-ara.cmd"; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'; start src-tauri\target\debug\hera.exe
import { page, PORT } from './cdp.mjs'
import { readFileSync, rmSync } from 'node:fs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const has = async (q) => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).some((x) => x.type === 'page' && x.url.includes(q))
const inv = (cmd, args = {}) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
let fails = 0
const ok = (name, cond, extra = '') => (console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`), cond || fails++)
const until = async (f, ms = 8000) => {
  for (let t = 0; t < ms; t += 200) {
    if (await f()) return true
    await sleep(200)
  }
  return false
}
const log = `${process.env.TEMP}\\hera-fake-ara.log`
rmSync(log, { force: true })

const island = await page('island')
await island.evaluate(inv('float_open', { f: 'term' }))
ok('terminal window opens', await until(() => has('f=term')))
let term = await page('float&f=term')
const screen = () => term.evaluate(`document.querySelector('.xterm-rows')?.textContent ?? ''`)
ok('xterm loaded (lazy chunk)', await until(() => term.evaluate(`!!document.querySelector('.xterm')`)))
ok('PowerShell prompt', await until(async () => /PS .+>/.test(await screen()), 15000))
await term.evaluate(inv('term_write', { data: 'echo hera-cdp-1\r' }))
ok('command output shows', await until(async () => /hera-cdp-1[\s\S]*hera-cdp-1/.test(await screen())))

// 실행 중 → 창 닫기 → 끝나면 Island 완료 알림 (셸은 창과 따로 산다)
await term.evaluate(inv('term_write', { data: 'cd C:\\Windows; Start-Sleep 2; echo hera-cdp-2\r' }))
ok('island shows the running terminal', await until(() => island.evaluate(`/터미널/.test(document.querySelector('.hubpill')?.textContent ?? '') && !!document.querySelector('.hubnotch i[data-k=busy]')`), 3000))
void term.evaluate(inv('float_close'))
term.close()
ok('window closed while running', await until(async () => !(await has('f=term'))))
ok('island: 완료 ✓ after it finished', await until(() => island.evaluate(`/완료.*hera-cdp-2/.test(document.querySelector('.hubflash')?.textContent ?? '')`), 10000))
const st = await island.evaluate(inv('term_state'))
ok('shell kept its folder', /Windows$/i.test(st.cwd) && !st.running, JSON.stringify(st))

// 실패 명령 (창 없음) → 실패 ✕
await island.evaluate(inv('term_write', { data: 'Start-Sleep 1.3; cmd /c exit 3\r' }))
ok('island: 실패 ✕ for a failing command', await until(() => island.evaluate(`/실패.*exit 3/.test(document.querySelector('.hubflash')?.textContent ?? '') && document.querySelector('.flash-ok')?.dataset.fail === 'true'`), 10000))

// 다시 열면 지금까지의 출력
await island.evaluate(inv('float_open', { f: 'term' }))
await until(() => has('f=term'))
term = await page('float&f=term')
ok('reopened window shows earlier output', await until(async () => /hera-cdp-2/.test(await screen()), 8000))

// 아라에서 이어서 하기 (가짜 CLI): status → open → terminal create --title "Hera에서", cwd = 셸 폴더
await term.evaluate(`document.querySelector('.term-ara').click()`)
ok('handoff calls the CLI', await until(() => { try { return /terminal create --title/.test(readFileSync(log, 'utf8')) } catch { return false } }, 10000))
const lines = readFileSync(log, 'utf8').trim().split(/\r?\n/)
ok('order: status → open → terminal create', /\| status --json/.test(lines[0] ?? '') && /\| open --json/.test(lines[1] ?? '') && /terminal create --title .+ --json/.test(lines[2] ?? ''), JSON.stringify(lines))
ok('cwd = the terminal folder', lines.every((l) => /^C:\\Windows\s*\|/i.test(l)))
ok('no --command unless asked', !/--command/.test(lines[2] ?? ''))
ok('island: handoff confirmation', await until(() => island.evaluate(`/아라/.test(document.querySelector('.hubflash')?.textContent ?? '')`), 5000))

// '명령도' 체크 → 마지막 명령을 --command 로 (& · ; 가 있어도 한 인자)
await island.evaluate(inv('term_write', { data: 'echo a&b; echo hera-cdp-3\r' }))
await until(async () => /hera-cdp-3/.test(await screen()), 6000)
rmSync(log, { force: true })
await term.evaluate(`document.querySelector('.term-opt input').click()`)
await sleep(300)
await term.evaluate(`document.querySelector('.term-ara').click()`)
ok('with 명령도: --command <last command>', await until(() => { try { return /terminal create --title .+ --json --command .*a&b.*hera-cdp-3/.test(readFileSync(log, 'utf8')) } catch { return false } }, 10000), (() => { try { return readFileSync(log, 'utf8').trim().split(/\r?\n/).pop() } catch { return '' } })())
await term.evaluate(`document.querySelector('.term-opt input').click()`) // 기본(끔)으로 되돌림

await island.evaluate(inv('term_kill'))
ok('term_kill ends the shell', await until(async () => (await island.evaluate(inv('term_state'))).alive === false))
void term.evaluate(inv('float_close'))
term.close()
island.close()
rmSync(log, { force: true })
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
process.exit(fails ? 1 : 0)
