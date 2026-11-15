// LP 플레이어 (떠 있는 유리 턴테이블) on the ISOLATED build (see island-cdp.mjs header). Plays a short effect + an ASCII scene and stops them.
import { page, PORT } from './cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const has = async (q) => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).some((x) => x.type === 'page' && x.url.includes(q))
const inv = (cmd, args = {}) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
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
await island.evaluate(`document.querySelector('.hub')?.dataset.show === 'true' || document.querySelector('.island').click()`)
await until(() => island.evaluate(`document.querySelector('.hub')?.dataset.show === 'true'`))
await island.evaluate(`document.querySelector('.hub-icon[data-k=lp]').click()`)
ok('LP player window opens from the hub', await until(() => has('f=lp')))
const lp = await page('float&f=lp')
ok('10 records (5 effects + 5 ASCII)', await until(() => lp.evaluate(`document.querySelectorAll('.lp-recs .crate-rec').length === 10`)))

// tap = put on platter → arm down → effect window + island 'LP 재생 중'
const tap = (i) => lp.evaluate(`(() => { const b = document.querySelectorAll('.crate-rec')[${i}]; b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 })); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })) })()`)
await tap(0) // 눈
ok('record on the platter, arm down', await until(() => lp.evaluate(`document.querySelector('.arm')?.dataset.down === 'true' && !!document.querySelector('.on-platter')`)))
ok('effect window opened', await until(() => has('surface=fx')))
ok('island shows the playing pill', await until(() => island.evaluate(`document.querySelector('.island').dataset.mode === 'ascii' && /눈/.test(document.querySelector('.island-layer.ascii')?.textContent ?? '')`)))
await lp.evaluate(`document.querySelector('.arm').click()`) // 암 들기 = 정지
ok('lifting the arm stops the effect', await until(async () => !(await has('surface=fx')), 5000))
ok('record back in the crate', await until(() => lp.evaluate(`!document.querySelector('.on-platter')`)))
ok('island pill gone', await until(() => island.evaluate(`document.querySelector('.island').dataset.mode !== 'ascii'`)))

await tap(6) // 아스키 · 크리스마스
ok('ASCII scene window opened', await until(() => has('surface=ascii')))
ok('scene = xmas', await until(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).some((x) => x.url.includes('scene=xmas'))))
await lp.evaluate(`document.querySelector('.on-platter').click()`) // 판 꺼내기 = 정지
ok('ejecting the record stops ASCII', await until(async () => !(await has('surface=ascii')), 6000))

void lp.evaluate(inv('float_close'))
lp.close()
island.close()
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
process.exit(fails ? 1 : 0)
