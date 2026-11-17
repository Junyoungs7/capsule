// (a8) "쉽고 빠르게" — HEADLESS only (headless.mjs; never launches Hera, never real input).
//   node .omc/verify/a8-cdp.mjs
// 1 Team: 그룹 만들기가 한 화면 (창·대화상자 없음 · 높이 그대로 · Enter = 만들기 · 만들면 초대 코드가 그 카드 안에)
// 2 화면을 열면 첫 칸에 커서 (할 일 · 메모 · 채팅) · LP 추가 시트 (첫 칸 커서 · Esc = 시트만) · 설정 이름 칸 Enter = 저장
// 3 바꾼 문구: 예전 문구가 소스 어디에도 없다 (copy-a8.json)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('a8')
const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/* 3. 문구 (앱을 띄울 필요 없음) */
const table = JSON.parse(readFileSync(new URL('./copy-a8.json', import.meta.url), 'utf8'))
const left = table.filter(([f, before, after]) => before !== after && readFileSync(ROOT + f, 'utf8').includes(before))
ok(`none of the ${table.length} replaced strings remain in the source`, left.length === 0, JSON.stringify(left.slice(0, 3)))
const src = ['src/surfaces/Team.tsx', 'src/surfaces/Settings.tsx', 'src/surfaces/Connect.tsx', 'src/surfaces/Chat.tsx'].map((f) => readFileSync(ROOT + f, 'utf8')).join('\n')
ok('no "같은 사내망 동료와 달력·메모 공유" (read as "팀 같은 …") and no bare "Hera Link" label in Team/연결/채팅/설정', !/같은 사내망 동료와 달력·메모 공유/.test(src) && !/['>]Hera Link (꺼짐|켜기)/.test(src) && !/\(Hera Link\)/.test(src))

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
const close = async () => (await isl.key('Escape'), await until(async () => !(await hubOpen())), await sleep(450))
const focused = () => isl.eval(`document.activeElement?.getAttribute('aria-label')`)

try {
  // 가짜 Rust Team: 처음엔 그룹 없음 → team_create 뒤 team_state 에 나타남
  const groups = []
  h.handlers.team_state = () => ({ name: '나', pk: 'me', groups, online: [] })
  h.handlers.team_create = (p, a) => {
    const g = { id: 'g-new', name: a.name, color: a.color, members: [{ name: '나', pk: 'me' }], alarms: true, news: true }
    groups.push(g)
    return g
  }
  h.handlers.team_invite = () => ['482913', 'hera-team:7b2261223a5b2231302e32302e33312e3434225d7d']
  isl = await h.open('island')
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(400)

  /* 1. Team 한 화면 */
  await openView('team')
  const V = '.view[data-k=team]'
  ok('empty state = the create form itself (no "그룹 만들기" button to press first)', await isl.eval(`!!document.querySelector('${V} .team-add[data-first=true] input[aria-label="새 그룹 이름"]') && ![...document.querySelectorAll('${V} button')].some((b) => b.textContent.trim() === '그룹 만들기')`))
  ok('…cursor already in the name field', (await focused()) === '새 그룹 이름', await focused())
  ok('…join-by-code is on the same screen', await isl.eval(`!!document.querySelector('${V} input[aria-label="초대 코드"]')`))
  const h0 = (await skin())[3]
  const pages0 = h.pages.size
  await isl.type('디자인팀')
  await sleep(150)
  const h1 = (await skin())[3]
  await isl.key('Enter')
  ok('Enter creates the group (team_create with the typed name)', await until(() => h.calls.some((c) => c[1] === 'team_create' && c[2]?.name === '디자인팀')))
  ok('…the new group card appears with its invite code open inside it', await until(() => isl.eval(`(() => { const c = document.querySelector('${V} .team-card[data-group=g-new]'); return !!c && /디자인팀/.test(c.textContent) && c.querySelectorAll('.invite .code span').length === 6 && c.querySelector('.invite .code').textContent === '482913' })()`), 5000))
  await sleep(700)
  const h2 = (await skin())[3]
  ok('no extra window and no dialog/sheet during the whole flow', h.pages.size === pages0 && (await isl.eval(`!document.querySelector('.team-sheet, ${V} [role=dialog]')`)))
  ok('view height stays the same across the flow (±2px)', Math.abs(h1 - h0) <= 2 && Math.abs(h2 - h0) <= 2, JSON.stringify([h0, h1, h2]))
  ok('name field is cleared for the next group', await isl.eval(`document.querySelector('${V} input[aria-label="새 그룹 이름"]').value === ''`))
  await isl.clickSel(`${V} .team-card[data-group=g-new] [data-invite]`)
  ok('동료 초대 toggles the invite panel inline', await until(() => isl.eval(`!document.querySelector('${V} .team-card[data-group=g-new] .invite')`)))
  ok('…height still stable', Math.abs((await skin())[3] - h0) <= 2)
  ok('team heading reads cleanly (subtitle on its own line, no "팀 같은")', await isl.eval(`(() => { const h = document.querySelector('${V} .team h3'); const s = h.querySelector('small'); return getComputedStyle(s).display === 'block' && !/팀 같은/.test(h.textContent) })()`))
  await close()

  /* 2. 첫 칸에 커서 */
  await openView('todo')
  ok('할 일: cursor lands in the title field', (await focused()) === '할 일 제목', await focused())
  await close()
  await openView('notes')
  ok('메모: cursor lands in the quick memo', (await focused()) === '빠른 메모', await focused())
  await close()
  await openView('chat')
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=chat] .chat-input')`), 5000)
  await sleep(300)
  ok('채팅: cursor lands in the message field', (await focused()) === '메시지', await focused())
  await close()

  /* LP 추가 시트 */
  await openView('lp')
  await isl.clickSel('.lpv .filters [data-sheet=add]')
  ok('LP 추가 시트: cursor lands in the URL field', await until(async () => (await focused()) === 'URL 또는 경로'), await focused())
  await isl.key('Escape')
  ok('…Esc closes only the sheet (hub stays open)', await until(() => isl.eval(`!document.querySelector('.lpv .sheet.on')`)) && (await hubOpen()))
  await isl.clickSel('.lpv .filters [data-sheet=add]')
  await until(() => isl.eval(`!!document.querySelector('.lpv .sheet.on')`))
  await isl.clickSel('.lpv .sheet [data-sheet=set]')
  ok('…세트 만들기: cursor moves to the name field', await until(async () => (await focused()) === '이름'), await focused())
  await close()

  /* 설정: 이름 칸은 Enter 로 저장 */
  const sw = await h.open('settings&sec=link', { label: 'settings', geo: { x: 490, y: 176, w: 940, h: 680 } })
  await until(() => sw.eval(`!!document.querySelector('.swin input[aria-label="이 PC 이름"]')`), 8000)
  await sleep(300)
  await sw.eval(`document.querySelector('.swin input[aria-label="이 PC 이름"]').select()`)
  await sw.clickSel('.swin input[aria-label="이 PC 이름"]')
  await sw.eval(`document.querySelector('.swin input[aria-label="이 PC 이름"]').select()`)
  await sw.type('DESK-7')
  await sw.key('Enter')
  ok('설정 › 이 PC 이름: Enter saves (no need to click elsewhere)', await until(() => h.store.get('link.cfg')?.me === 'DESK-7'), JSON.stringify(h.store.get('link.cfg')))
  ok('no page errors', isl.errors.length === 0 && sw.errors.length === 0, [...isl.errors, ...sw.errors].slice(0, 2).join(' | '))
} catch (e) {
  ok('suite ran to the end', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
