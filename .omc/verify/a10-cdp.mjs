// (a10) 팀 그룹 나가기 — HEADLESS only (headless.mjs; never launches Hera, never real input).
//   node .omc/verify/a10-cdp.mjs
// 카드 · 설정 둘 다 '그룹 나가기' · 바로 사라지고 5초 '되돌리기' · 되돌리면 그대로 · 그동안 Rust 는 아무것도 안 함(새로 고쳐 받아도 숨김)
// · 5초 뒤 team_leave 딱 한 번 · 화면 높이 그대로. (Rust 쪽 지우기·알리기 = cargo team::leave_group_wipes_here_keeps_peers)
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('a10')
const h = await start()
let isl
const skin = () => isl.eval(`(() => { const r = document.querySelector('.isl .skin').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round) })()`)
const hubOpen = () => isl.eval(`document.querySelector('.isl').dataset.open === 'true'`)
const openView = async (k) => {
  if (!(await hubOpen())) await isl.clickSel('.isl .petbox')
  await until(hubOpen)
  if (await isl.eval(`!!document.querySelector('.isl .view')`)) await isl.clickSel('.isl .view [data-back]')
  await until(async () => (await isl.eval(`!!document.querySelector('.hub .app')`)) && (await skin())[2] === 432)
  await sleep(250)
  await isl.clickSel(`.hub .app[data-go=${k}]`)
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=${k}]')`))
  await sleep(650)
}
const V = '.view[data-k=team]'
const cards = (p = isl) => p.eval(`[...document.querySelectorAll('.team-card')].map((c) => c.dataset.group + ':' + c.querySelector('.team-top b').textContent + ':' + c.style.getPropertyValue('--g'))`)
const leaves = () => h.calls.filter((c) => c[1] === 'team_leave')

try {
  let groups = [
    { id: 'g1', name: '개발팀', color: '#14b8a6', members: [{ name: '나', pk: 'me' }, { name: '민수', pk: 'ff' }], alarms: true, news: true },
    { id: 'g2', name: '배너 프로젝트', color: '#8b5cf6', members: [{ name: '나', pk: 'me' }], alarms: true, news: false },
  ]
  h.handlers.team_state = () => ({ name: '나', pk: 'me', groups, online: ['ff'] })
  h.handlers.team_leave = (p, a) => ((groups = groups.filter((g) => g.id !== a.group)), null)
  isl = await h.open('island')
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(400)
  await openView('team')
  const before = await cards()
  ok('each group card has a "그룹 나가기" button', await isl.eval(`[...document.querySelectorAll('${V} .team-card')].every((c) => c.querySelector('[data-leave]')?.textContent === '그룹 나가기')`) && before.length === 2, JSON.stringify(before))
  const h0 = (await skin())[3]

  /* 나가기 → 되돌리기 */
  await isl.clickSel(`${V} .team-card[data-group=g1] [data-leave]`)
  ok('leave: the card disappears at once, no confirm dialog', await until(async () => (await cards()).length === 1) && (await isl.eval(`!document.querySelector('[role=dialog]')`)))
  ok('…toast "개발팀에서 나왔어요 · 되돌리기"', await until(() => isl.eval(`/개발팀에서 나왔어요/.test(document.querySelector('${V} .undo-toast')?.textContent ?? '') && !!document.querySelector('${V} .undo-toast [data-undo]')`)))
  ok('…nothing is sent yet (leave is deferred)', leaves().length === 0)
  await h.emit('team', { kind: 'online', pk: 'ff', online: true }) // 새로 고쳐 받기 (Rust 에는 아직 그룹이 있다)
  await sleep(400)
  ok('…a refresh from Rust during the undo window does not bring it back', (await cards()).length === 1)
  ok('…view height unchanged (±2px)', Math.abs((await skin())[3] - h0) <= 2, JSON.stringify([h0, (await skin())[3]]))
  await isl.clickSel(`${V} .undo-toast [data-undo]`)
  ok('되돌리기 restores the group exactly (id · name · colour · order)', await until(async () => JSON.stringify(await cards()) === JSON.stringify(before)), JSON.stringify(await cards()))
  await sleep(5600)
  ok('…and no leave is ever sent after an undo', leaves().length === 0)

  /* 나가기 → 5초 기다림 */
  await isl.clickSel(`${V} .team-card[data-group=g1] [data-leave]`)
  await until(async () => (await cards()).length === 1)
  await sleep(4500)
  ok('still nothing sent at 4.5 s', leaves().length === 0)
  ok('after the 5 s window: team_leave sent exactly once, for that group', await until(() => leaves().length === 1, 2500) && leaves()[0][2]?.group === 'g1', JSON.stringify(leaves().map((c) => c[2])))
  await sleep(800)
  ok('…the group stays gone (Rust state no longer has it) and the toast is gone', (await cards()).join() === before[1] && (await isl.eval(`!document.querySelector('.undo-toast')`)))
  ok('…exactly once (no repeat)', (await sleep(1500), leaves().length === 1))
  ok('…view height still unchanged', Math.abs((await skin())[3] - h0) <= 2)

  /* 설정 → 채팅 → 팀 그룹 (같은 컴포넌트) */
  const sw = await h.open('settings&sec=chat', { label: 'settings', geo: { x: 490, y: 176, w: 940, h: 680 } })
  await until(() => sw.eval(`!!document.querySelector('.swin .team-card [data-leave]')`), 8000)
  ok('settings › 채팅 › 팀 그룹: same card with "그룹 나가기"', await sw.eval(`document.querySelector('.swin .team-card[data-group=g2] [data-leave]')?.textContent === '그룹 나가기'`))
  await sw.clickSel('.swin .team-card[data-group=g2] [data-leave]')
  ok('…toast in the settings window', await until(() => sw.eval(`/배너 프로젝트에서 나왔어요/.test(document.querySelector('.swin .undo-toast')?.textContent ?? '')`)))
  await sw.clickSel('.swin .undo-toast [data-undo]')
  ok('…되돌리기 brings it back, nothing sent', (await until(async () => (await cards(sw)).length === 1)) && leaves().length === 1)
  ok('no page errors', isl.errors.length === 0 && sw.errors.length === 0, [...isl.errors, ...sw.errors].slice(0, 2).join(' | '))
} catch (e) {
  ok('suite ran to the end', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
