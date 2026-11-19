// (a13) 떠 있는 캡슐 · 설정 바로 적용 · 검색 팔레트 제거 — HEADLESS only (headless.mjs; never launches Hera, never real input).
//   node .omc/verify/a13-cdp.mjs
// 끌어서 옮기기 → 자리 저장 · 놓은 뒤 click 은 허브를 열지 않음 · 그냥 누르기는 여전히 허브 · 절반에 따라 펼치는 쪽이 바뀜(창 안, 안 잘림)
// · 알림 글이 캡슐 안에 보임 · 설정 창 변경이 아일랜드에 바로 · 저장된 도시가 설정에 보임 · 팔레트 없음 · 상용구 누르기 = snippet_paste.
// (창 배치·모니터·배율 규칙 자체 = cargo island::tests)
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { start, sleep, suite, WA, ISL } from './headless.mjs'

const { ok, until, done } = suite('a13')
const h = await start()
let isl
const skin = () => isl.eval(`(() => { const r = document.querySelector('.isl .skin').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round) })()`)
const hubOpen = () => isl.eval(`document.querySelector('.isl').dataset.open === 'true'`)
const side = () => isl.eval(`(() => { const d = document.querySelector('.isl').dataset; return d.h + d.v })()`)
const center = async () => { const s = await skin(); return [s[0] + s[2] / 2, s[1] + s[3] / 2] }
const geo = () => h.pages.get('island').geo
const inWindow = (s) => s[0] >= 0 && s[1] >= 0 && s[0] + s[2] <= ISL.w && s[1] + s[3] <= ISL.h
// 캡슐을 화면 (x, y) 로 끈다: 누름 → 6px 넘게 → 커서를 따라 → 놓음 (헤드리스 페이지 안 입력 + 가짜 화면 커서만)
async function dragTo(x, y) {
  const [cx, cy] = await center()
  const g = geo()
  h.setCursor(g.x + cx, g.y + cy)
  await isl.mouse('mouseMoved', cx, cy)
  await isl.mouse('mousePressed', cx, cy)
  h.setCursor(g.x + cx - 10, g.y + cy - 10)
  await isl.mouse('mouseMoved', cx - 10, cy - 10, { buttons: 1 })
  for (let i = 1; i <= 4; i++) {
    h.setCursor(g.x + cx - 10 + ((x - g.x - cx + 10) * i) / 4, g.y + cy - 10 + ((y - g.y - cy + 10) * i) / 4)
    await isl.mouse('mouseMoved', cx - 10, cy - 10, { buttons: 1 }) // 실제 앱: 창이 커서를 따라가니 창 안 좌표는 그대로
  }
  await isl.mouse('mouseReleased', cx - 10, cy - 10)
}
const pillInside = async () => isl.eval(`(() => { const s = document.querySelector('.isl .skin').getBoundingClientRect(), t = document.querySelector('.isl .ptext:not(.measure)'), b = t.querySelector('b').getBoundingClientRect(); return getComputedStyle(t).opacity === '1' && b.width > 20 && b.left >= s.left - 0.5 && b.right <= s.right + 0.5 && b.top >= s.top && b.bottom <= s.bottom && s.left >= 0 && s.top >= 0 && s.right <= innerWidth && s.bottom <= innerHeight })()`)

try {
  isl = await h.open('island')
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(500)

  /* 1. 처음 자리 = 예전 오른쪽 아래 */
  const s0 = await skin()
  ok('home = old bottom-right corner (16 in · 8 up), expands up-left', s0[0] + s0[2] === ISL.w - 16 && s0[1] + s0[3] === ISL.h - 8 && (await side()) === 'rb', JSON.stringify(s0))
  await h.emit('chat-msg', { id: 'm1', group: 'g', by: '민수', byPk: 'ff', kind: 'text', text: '내일 3시 회의 어때요?', at: Date.now() })
  ok('alert text is fully visible inside the capsule (bottom-right)', await until(pillInside, 3000))
  await isl.mouse('mouseMoved', 10, 10)
  await sleep(6500) // 알림 접힘

  /* 2. 그냥 누르기 = 허브 (끌기 아님) */
  await isl.click(...(await center()))
  ok('a plain tap still opens the hub', await until(hubOpen, 2000))
  ok('…and never starts a drag', !h.calls.some((c) => c[1] === 'island_drag'))
  await isl.key('Escape')
  await until(async () => !(await hubOpen()))
  await sleep(500)

  /* 3. 끌어서 왼쪽 위로 */
  await dragTo(300, 200)
  const pos = await until(() => h.store.get('island.pos')).then(() => h.store.get('island.pos'))
  ok('drag → island_drag start/move/end, position saved as monitor + fractions', !!pos && pos.mon === 'D1' && Math.abs(pos.fx * WA.w - 310) < 20 && Math.abs(pos.fy * WA.h - 210) < 20, JSON.stringify(pos))
  ok('…the release did not open the hub', !(await hubOpen()))
  ok('top-left half → expands right and down (data-h=l, data-v=t)', await until(async () => (await side()) === 'lt'))
  await isl.mouse('mouseMoved', 600, 600) // 머묾 확대(1.06) 없이 잰다
  await sleep(600)
  const c1 = await center(), g1 = geo()
  ok('capsule centre is where it was dropped (screen)', Math.abs(g1.x + c1[0] - pos.fx * WA.w) < 2 && Math.abs(g1.y + c1[1] - pos.fy * WA.h) < 2, JSON.stringify({ g1, c1 }))
  ok('hit rect follows the capsule after the move', await until(async () => { const r = (h.hits.get('island') ?? [])[0], s = await skin(); return !!r && r[0] <= s[0] && r[1] <= s[1] && r[0] + r[2] >= s[0] + s[2] && r[1] + r[3] >= s[1] + s[3] }), JSON.stringify(h.hits.get('island')))
  await h.emit('chat-msg', { id: 'm2', group: 'g', by: '서연', byPk: 'ee', kind: 'text', text: '배너 시안 올렸어요', at: Date.now() })
  ok('alert text is fully visible inside the capsule (top-left)', await until(pillInside, 3000))
  await sleep(6500)
  const cap = await skin()
  await isl.click(...(await center()))
  await until(hubOpen)
  await sleep(700)
  const hub = await skin()
  ok('hub opens down-right from the capsule and stays inside the window', inWindow(hub) && hub[0] === cap[0] && hub[1] === cap[1] && hub[2] === 432, JSON.stringify({ cap, hub }))
  await isl.clickSel('.hub .app[data-go=lp]') // 가장 큰 화면 (452×612)
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=lp]')`))
  await sleep(800)
  ok('tallest view still fits (pushed inside, never clipped)', inWindow(await skin()), JSON.stringify(await skin()))
  await isl.key('Escape')
  await until(async () => !(await hubOpen()))
  await sleep(500)

  /* 4. 오른쪽 위 / 왼쪽 아래 */
  await dragTo(1700, 150)
  ok('top-right half → expands left and down', await until(async () => (await side()) === 'rt'))
  await dragTo(250, 900)
  ok('bottom-left half → expands right and up', await until(async () => (await side()) === 'lb'))
  await isl.click(...(await center()))
  ok('tap after moving still opens the hub', await until(hubOpen, 2000))
  await sleep(700)
  ok('…inside the window', inWindow(await skin()), JSON.stringify(await skin()))
  await isl.key('Escape')
  await until(async () => !(await hubOpen()))
  await sleep(500)

  /* 5. 설정 창 → 아일랜드에 바로 */
  h.store.set('fx.city', '부산')
  await h.emit('store://change', { path: 'hera.json', resourceId: 1, key: 'fx.city', value: '부산', exists: true })
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('settings_open', { sec: 'general' })`)
  const sw = h.pages.get('settings')
  await until(() => sw?.eval(`!!document.querySelector('.swin [data-pane=general]')`), 8000)
  ok('saved city shows in 설정 (not the 서울 fallback)', await until(() => sw.eval(`document.querySelector('.swin input[aria-label=도시]').value === '부산'`)))
  await sw.clickSel('.swin .nav [data-sec=island]')
  await sw.clickSel('.swin [data-size-set=xl]')
  await isl.mouse('mouseMoved', 600, 10)
  ok('설정 크기 아주 크게 → the island capsule is 112×84 right away', await until(async () => { const s = await skin(); return s[2] === 112 && s[3] === 84 }, 4000), JSON.stringify(await skin()))
  ok('preview shows the dragged spot (bottom-left)', await until(() => sw.eval(`(() => { const m = document.querySelector('.swin .ipv .mcap'), p = document.querySelector('.swin .ipv').getBoundingClientRect(), r = m.getBoundingClientRect(); return m.dataset.pos === 'saved' && r.left + r.width / 2 < p.left + p.width / 2 })()`)))
  await sw.clickSel('.swin [data-pos-reset]')
  ok('처음 자리로 → capsule back bottom-right', await until(async () => !h.store.has('island.pos') && (await side()) === 'rb' && geo().x === WA.w - ISL.w))
  await sw.clickSel('.swin [data-size-set=m]')
  await h.closePage('settings')

  /* 6. 검색 팔레트 없음 · 상용구 = 누르면 붙여 넣기 */
  await isl.click(...(await center()))
  await until(hubOpen)
  await sleep(600)
  ok('hub has no search button (Ctrl+Alt+K palette removed)', await isl.eval(`!document.querySelector('.hub .search') && !/Ctrl.?Alt.?K|앱 실행 · 검색/.test(document.querySelector('.hub').textContent)`))
  await isl.clickSel('.hub .app[data-go=snippets]')
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=snippets] [data-snip-new]')`))
  await sleep(600)
  // 실제 앱은 시드 상용구가 없다 → ＋ 새 상용구로 하나 만든다 (같은 화면 안)
  await isl.clickSel('.view[data-k=snippets] [data-snip-new]')
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=snippets] .snip-ed')`))
  await isl.type('메일 서명')
  await isl.eval(`document.querySelector('.view[data-k=snippets] .snip-ed textarea').focus()`)
  await isl.type('감사합니다.\n{이름} 드림')
  await isl.clickSel('.view[data-k=snippets] .snip-btns .btn:not(.ghost)')
  ok('＋ 새 상용구 saves in the same view', await until(() => [...h.store.keys()].some((k) => k.startsWith('snippet:') && h.store.get(k).title === '메일 서명')))
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=snippets] [data-snip-paste]')`))
  const sv = await isl.eval(`(() => { const v = document.querySelector('.view[data-k=snippets]'); return { rows: v.querySelectorAll('[data-snip-paste]').length, edits: [...v.querySelectorAll('[data-snip-edit]')].filter((e) => e.offsetWidth).length, add: !!v.querySelector('[data-snip-new]'), search: v.textContent.includes("검색") || v.textContent.includes("Alt+K") } })()`)
  ok('snippets: one screen — rows, an edit button per row, ＋ 새 상용구', sv.rows >= 1 && sv.edits === sv.rows && sv.add && !sv.search, JSON.stringify(sv))
  await isl.clickSel('.view[data-k=snippets] [data-snip-edit]')
  ok('edit opens in the same view', await until(() => isl.eval(`!!document.querySelector('.view[data-k=snippets] .snip-ed input[aria-label="상용구 이름"]')`)))
  await isl.clickSel('.view[data-k=snippets] .snip-btns .btn.ghost:not([data-snip-del])')
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=snippets] [data-snip-paste]')`))
  const n = h.calls.length
  await isl.clickSel('.view[data-k=snippets] [data-snip-paste]')
  ok('tapping a snippet calls snippet_paste with the expanded text and folds the hub', await until(() => h.calls.slice(n).some((c) => c[1] === 'snippet_paste' && /감사합니다/.test(c[2]?.text ?? '') && !/\{이름\}/.test(c[2].text))) && (await until(async () => !(await hubOpen()))), JSON.stringify(h.calls.slice(n).map((c) => c[1])))
  ok('nothing ever called a palette command', !h.calls.some((c) => /palette/.test(c[1]) || (c[1] === 'hub_action' && /palette|snippets/.test(c[2]?.kind))))
  const ROOT = fileURLToPath(new URL('../../', import.meta.url))
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d + e.name + '/') : [d + e.name]))
  const left = [...walk(ROOT + 'src/'), ...walk(ROOT + 'src-tauri/src/')].filter((f) => /\.(tsx?|rs|css)$/.test(f) && /Ctrl\+Alt\+K|PALETTE|palette|팔레트/.test(readFileSync(f, 'utf8')))
  ok('no palette code or Ctrl+Alt+K copy left in src / src-tauri', left.length === 0, JSON.stringify(left))
  ok('no page errors', isl.errors.length === 0, JSON.stringify(isl.errors.slice(0, 2)))
} catch (e) {
  ok('suite ran without throwing', false, e?.stack ?? String(e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
