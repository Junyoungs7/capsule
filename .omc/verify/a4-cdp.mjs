// (a4) Regression suite for the bugs found on the installed a3 — HEADLESS only (headless.mjs; never launches Hera, never real input).
//   node .omc/verify/a4-cdp.mjs
// 1 할 일 기간 고르기: 페이지 안 달력(네이티브 팝업 없음) · 고르는 동안 허브가 안 접힘(달력이 히트 rect 안) · start~due 저장
// 2 달력 음력 없음 · 3 채팅(그룹 없음)이 예전 패널 창을 띄우지 않음 · 5 선반 말풍선(토큰) · 놓은 뒤 펫이 평소로 · 6 최근 복사가 아일랜드에 보임
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('a4')
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
const inside = (r, s) => r[0] >= s[0] && r[1] >= s[1] && r[0] + r[2] <= s[0] + s[2] + 0.5 && r[1] + r[3] <= s[1] + s[3] + 0.5

try {
  h.handlers.clips = () => [{ id: 'c1', text: '배너 노출 기간 확인', at: Date.now() - 120000 }]
  isl = await h.open('island')
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(400)

  /* 1. 할 일 기간: 기본값 · 직접 쓰기 · ↑↓ · Tab · 칩 · 달력 — 무엇을 해도 허브가 접히지 않는다 */
  await openView('todo')
  ok('no native date/time/select popups anywhere in the Island', await isl.eval(`!document.querySelector('.isl input[type=date], .isl input[type=datetime-local], .isl input[type=time], .isl select')`))
  const field = (i) => isl.eval(`document.querySelectorAll('.view[data-k=todo] .when-f input')[${i}].value`)
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const ceil5 = (t) => new Date(Math.ceil(t / 300000) * 300000)
  const n0 = Date.now()
  await isl.clickSel('.view[data-k=todo] .add input') // 제목 칸 포커스 = 기본값을 지금으로
  await sleep(200)
  const [s0, e0] = [await field(0), await field(1)]
  const okStart = [fmt(ceil5(n0)), fmt(ceil5(Date.now()))].includes(s0)
  ok('default start = now rounded up to the next 5 minutes', okStart, `${s0} (now ${fmt(new Date(n0))})`)
  ok('default end = start + 1h', e0 === fmt(new Date(ceil5(Date.now()).getTime() + 3600000)) || e0 === fmt(new Date(ceil5(n0).getTime() + 3600000)), e0)
  const inside2 = async (sel) => {
    const r = await isl.eval(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })()`)
    return inside(r, (h.hits.get('island') ?? [])[0] ?? [0, 0, 0, 0])
  }
  ok('root cause guard: the date fields sit inside the Island hit rect (never an "outside" click)', await inside2('.view[data-k=todo] .when'))
  // 할 일 + Enter 만으로 저장 (기본값)
  await isl.type('주간 보고')
  await isl.key('Enter')
  const saved = async (title) => { for (let t = 0; t < 3000; t += 100) { const v = [...h.store].find(([k, v]) => k.startsWith('todo:') && v?.title === title); if (v) return v[1]; await sleep(100) } return null }
  const t1 = await saved('주간 보고')
  ok('"할 일 + Enter" saves with the defaults (no date interaction)', !!t1 && new Date(t1.due) - new Date(t1.start) === 3600000 && Math.abs(new Date(t1.start) - ceil5(Date.now())) <= 300000, JSON.stringify(t1))
  // 직접 쓰기: 시작 '내일 3시' → 끝이 같은 길이로 따라감
  await isl.clickSel('.view[data-k=todo] .when-f input')
  await isl.type('내일 3시')
  await isl.key('Enter')
  const tm = new Date(); tm.setDate(tm.getDate() + 1)
  ok('typing "내일 3시" + Enter → normalised start', await until(async () => (await field(0)) === `${tm.getMonth() + 1}/${tm.getDate()} 15:00`), await field(0))
  ok('…end shifts with it (same 1h)', (await field(1)) === `${tm.getMonth() + 1}/${tm.getDate()} 16:00`, await field(1))
  ok('Enter in a date field parses but does not save', !(await saved('')) && (await hubOpen()))
  // Tab = 다음 칸, ↑ = 커서가 있는 칸 한 칸
  await isl.key('Tab')
  ok('Tab moves to the end field', await isl.eval(`document.activeElement === document.querySelectorAll('.view[data-k=todo] .when-f input')[1]`))
  await isl.eval(`(() => { const i = document.activeElement; i.setSelectionRange(i.value.length, i.value.length) })()`)
  await isl.key('ArrowUp')
  ok('↑ on the minutes = +5 min', await until(async () => (await field(1)) === `${tm.getMonth() + 1}/${tm.getDate()} 16:05`), await field(1))
  await isl.eval(`(() => { const i = document.activeElement; i.setSelectionRange(0, 0); i.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })()`)
  await isl.key('ArrowUp')
  ok('↑ on the month = +1 month', await until(async () => (await field(1)).startsWith(`${((tm.getMonth() + 1) % 12) + 1}/`)), await field(1))
  await isl.key('ArrowDown')
  await isl.key('ArrowDown')
  ok('end can never go before start (↓↓ clamps to start + 1h)', await until(async () => (await field(1)) === `${tm.getMonth() + 1}/${tm.getDate()} 16:00`), await field(1))
  // 잘못 쓰면 되돌림
  await isl.clickSel('.view[data-k=todo] .when-f input')
  await isl.type('abc')
  await isl.key('Enter')
  ok('unreadable text reverts (and flags the field)', (await field(0)) === `${tm.getMonth() + 1}/${tm.getDate()} 15:00`)
  // 칩
  await isl.eval(`[...document.querySelectorAll('.view[data-k=todo] .when .dr-chip')].find((b) => b.textContent === '이번 주말').click()`)
  ok('이번 주말 → all day, date-only fields', await until(async () => !/:/.test(await field(0)) && (await isl.eval(`document.querySelector('[data-allday]').getAttribute('aria-pressed')`)) === 'true'))
  await isl.clickSel('[data-allday]')
  ok('종일 toggles back to times', await until(async () => /:/.test(await field(0))))
  await isl.eval(`[...document.querySelectorAll('.view[data-k=todo] .when .dr-chip')].find((b) => b.textContent === '오늘').click()`)
  ok('오늘 → today', await until(async () => (await field(0)).startsWith(`${new Date().getMonth() + 1}/${new Date().getDate()} `)))
  // 달력에서 기간
  await isl.clickSel('[data-cal]')
  ok('달력 opens in the view (prototype tokens), inside the hit rect', (await until(() => isl.eval(`!!document.querySelector('.view[data-k=todo] .dr .dr-grid')`))) && (await sleep(600), await inside2('.view[data-k=todo] .dr')))
  const d = new Date(), k1 = d.toLocaleDateString('sv'), d3 = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 2), k3 = d3.toLocaleDateString('sv')
  await isl.clickSel(`.dr-d[data-k="${k1}"]`)
  ok('clicking a date keeps the hub open', (await hubOpen()) && (await skin())[2] === 380)
  if (d3.getMonth() !== d.getMonth()) await isl.clickSel('.dr-head button[aria-label="다음 달"]')
  await isl.clickSel(`.dr-d[data-k="${k3}"]`)
  await isl.clickSel('.view[data-k=todo] .add input')
  await isl.type('배너 QA 기간')
  await isl.key('Enter')
  const todo = await saved('배너 QA 기간')
  ok('saved as a range start ~ due', !!todo && new Date(todo.start).toLocaleDateString('sv') === k1 && new Date(todo.due).toLocaleDateString('sv') === k3, JSON.stringify(todo))
  ok('list shows the range', await until(() => isl.eval(`[...document.querySelectorAll('.view[data-k=todo] .list li')].some((li) => /배너 QA 기간/.test(li.textContent) && /–/.test(li.textContent))`)))
  ok('the view fits its content (no scrollbar) and never collapsed', (await hubOpen()) && (await isl.eval(`(() => { const b = document.querySelector('.view[data-k=todo] .vbody'); return b.scrollHeight - b.clientHeight <= 1 || b.clientHeight >= 540 })()`)))

  /* 2. 달력: 음력 없음 */
  await openView('calendar')
  ok('calendar shows no lunar dates', await isl.eval(`!document.querySelector('.view[data-k=calendar] .mc-lunar') && !/음력|음 \\d/.test(document.querySelector('.view[data-k=calendar]').textContent)`))
  ok('a multi-day todo marks every day of its range', await isl.eval(`(() => { const days = [...document.querySelectorAll('.view[data-k=calendar] .mc-day')].filter((b) => b.querySelector('.mc-dots .todo')); return days.length >= 3 })()`))

  /* 3. 채팅 (그룹 없음): 예전 패널 창이 아니라 아일랜드 안 Team */
  await openView('chat')
  const n3 = h.calls.length
  await isl.clickSel('.view[data-k=chat] [data-team]')
  ok('채팅 → Team stays inside the Island', await until(() => isl.eval(`!!document.querySelector('.view[data-k=team]')`)))
  ok('…and never opens the legacy panel window', !h.calls.slice(n3).some((c) => ['toggle_panel', 'hub_action', 'float_open'].includes(c[1])), JSON.stringify(h.calls.slice(n3).map((c) => c[1])))
  await close()

  /* 6. 최근 복사 */
  await openView('clips')
  ok('최근 복사 shows the clipboard history in the Island', await until(() => isl.eval(`/배너 노출 기간 확인/.test(document.querySelector('.view[data-k=clips]').textContent)`)))
  await h.emit('clips', [{ id: 'c2', text: 'SELECT banner_id FROM banner', at: Date.now() }, { id: 'c1', text: '배너 노출 기간 확인', at: Date.now() - 120000 }])
  ok('…and updates live when you copy something', await until(() => isl.eval(`/SELECT banner_id/.test(document.querySelector('.view[data-k=clips]').textContent)`)))
  await isl.eval(`[...document.querySelectorAll('.view[data-k=clips] .float-list button')].find((b) => /SELECT/.test(b.textContent)).click()`)
  ok('…tap copies it back (set_clip)', await until(() => h.calls.some((c) => c[1] === 'set_clip' && c[2]?.text === 'SELECT banner_id FROM banner')))
  await close()

  /* 5. 선반: 놓으면 펫이 상자를 잠깐 → 평소로 · 말풍선 */
  await h.emitTo('island', 'shelf-add', 'C:\\Users\\me\\Documents\\기획서_v3.pdf')
  ok('drop → pet holds a box + "선반" pill', await until(() => isl.eval(`document.querySelector('.isl .pet').dataset.s === 'shelf' && /선반/.test(document.querySelector('.isl .ptext').textContent)`)))
  ok('…then returns to its normal pose (not stuck in the shelf pose)', await until(() => isl.eval(`document.querySelector('.isl .pet').dataset.s !== 'shelf'`), 9000))
  ok('…the file is still on the shelf', [...h.store].some(([k, v]) => k.startsWith('shelf:') && /기획서_v3/.test(v?.path ?? '')))
  await openView('shelf')
  ok('shelf rows have no native title tooltip', await isl.eval(`![...document.querySelectorAll('.view[data-k=shelf] .shelf-list [title]')].length`))
  const row = await isl.eval(`(() => { const r = document.querySelector('.view[data-k=shelf] .shelf-list li button').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  await isl.mouse('mouseMoved', row[0], row[1])
  ok('hover → styled tooltip (tokens) with the path', await until(() => isl.eval(`(() => { const t = document.querySelector('.view[data-k=shelf] .tip'); const c = getComputedStyle(t); return c.opacity === '1' && /기획서_v3/.test(t.textContent) && c.borderRadius === '10px' })()`), 2500))
  await close()

  /* 7. 메모 보드 (바탕화면 메모 대신) · 메모장으로 열기 */
  h.handlers.note_notepad = (p, a) => `C:\\Users\\me\\AppData\\Roaming\\Hera\\notes\\${a.id}.txt` // 시험은 메모장을 띄우지 않는다
  const set = (k, v) => isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: ${JSON.stringify(k)}, value: ${JSON.stringify(v)} })`)
  await set('note:m1', { id: 'm1', text: '배너 QA\n- [ ] 3시', color: 0, x: 16, y: 16, w: 210, h: 140 })
  await set('note:m2', { id: 'm2', text: '와이파이', color: 4, x: 248, y: 16, w: 210, h: 140 })
  await openView('notes')
  ok('메모 view: 보드 열기 · 보드에 붙이기 (no 데스크톱에 붙이기)', await isl.eval(`!!document.querySelector('.view[data-k=notes] [data-board]') && /보드에 붙이기/.test(document.querySelector('.view[data-k=notes] [data-attach]').textContent) && !/데스크톱/.test(document.querySelector('.view[data-k=notes]').textContent)`))
  ok('memo view is not detachable (the board is its window)', await isl.eval(`!document.querySelector('.view[data-k=notes] [data-detach]')`))
  await isl.eval(`document.querySelector('.view[data-k=notes] [data-notepad="m2"]').click()`)
  ok('메모장으로 열기 from the memo view → note_notepad(id) (Rust writes the file + opens Notepad)', await until(() => h.calls.some((c) => c[1] === 'note_notepad' && c[2]?.id === 'm2')))
  await isl.clickSel('.view[data-k=notes] textarea')
  await isl.type('새 보드 메모')
  const nb = h.calls.length
  await isl.clickSel('.view[data-k=notes] [data-attach]')
  ok('보드에 붙이기 → a note in a free board slot + the board opens', await until(() => [...h.store].some(([k, v]) => k.startsWith('note:') && v?.text === '새 보드 메모' && v.x === 480 && v.y === 16) && h.calls.slice(nb).some((c) => c[1] === 'float_open' && c[2]?.f === 'notes') && h.pages.has('float-notes'), 10000))
  ok('no desktop-notes surface / toggle anymore', !h.calls.some((c) => c[1] === 'hub_action' && c[2]?.kind === 'notes') && ![...h.pages.keys()].some((l) => /^notes\d/.test(l)))
  const bd = h.pages.get('float-notes')
  ok('board window = Hera float chrome (Island로 · pin · close)', await until(() => bd.eval(`[...document.querySelectorAll('.wbar .act button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()).join('|') === 'Island로|항상 위|닫기'`), 5000))
  ok('notes stick on the board', await until(() => bd.eval(`document.querySelectorAll('.board .note').length === 3`)))
  ok('the new note opens for editing', await until(() => bd.eval(`!!document.querySelector('.board .note textarea')`)))
  await bd.eval(`document.activeElement?.blur()`)
  // 끌어 옮기기 → 자리 저장
  const bar = await bd.eval(`(() => { const r = document.querySelector('.note[data-id=m1] .note-bar').getBoundingClientRect(); return [r.left + 60, r.top + r.height / 2] })()`)
  await bd.mouse('mouseMoved', bar[0], bar[1])
  await bd.mouse('mousePressed', bar[0], bar[1])
  for (let i = 1; i <= 6; i++) await bd.mouse('mouseMoved', bar[0] + i * 20, bar[1] + i * 30, { buttons: 1 }), await sleep(16)
  await bd.mouse('mouseReleased', bar[0] + 120, bar[1] + 180)
  ok('dragging a note moves it and saves its position', await until(() => { const v = h.store.get('note:m1'); return v && v.x === 136 && v.y === 196 }), JSON.stringify(h.store.get('note:m1')))
  // 제자리 편집
  await bd.clickSel('.note[data-id=m2] .note-body')
  await until(() => bd.eval(`!!document.querySelector('.note[data-id=m2] textarea')`))
  await bd.eval(`(() => { const t = document.querySelector('.note[data-id=m2] textarea'); t.setSelectionRange(t.value.length, t.value.length) })()`)
  await bd.type(' HERA-5G')
  ok('edit in place', await until(() => h.store.get('note:m2')?.text === '와이파이 HERA-5G'))
  // 색
  await bd.clickSel('.note[data-id=m2] [aria-label="색 바꾸기"]')
  await bd.clickSel('.note[data-id=m2] .note-colors button[aria-label="하늘"]')
  ok('change colour', await until(() => h.store.get('note:m2')?.color === 2))
  // 메모장으로 열기 · 메모장에서 고친 글이 돌아옴 (Rust 가 store 를 바꾼다)
  await bd.clickSel('.note[data-id=m1] [data-notepad]')
  ok('메모장으로 열기 on a board note → note_notepad', await until(() => h.calls.some((c) => c[0] === 'float-notes' && c[1] === 'note_notepad' && c[2]?.id === 'm1')))
  await set('note:m1', { ...h.store.get('note:m1'), text: '배너 QA\n- [x] 3시 (메모장에서)' })
  ok('Notepad edits sync back onto the board', await until(() => bd.eval(`/메모장에서/.test(document.querySelector('.note[data-id=m1]').textContent)`)))
  // 삭제
  await bd.clickSel('.note[data-id=m2] [aria-label="메모 삭제"]')
  ok('delete', await until(() => !h.store.has('note:m2') && bd.eval(`!document.querySelector('.note[data-id=m2]')`)))
  ok('board page has no errors', bd.errors.length === 0, bd.errors.slice(0, 2).join(' | '))
  ok('no page errors', isl.errors.length === 0, isl.errors.slice(0, 2).join(' | '))
} catch (e) {
  ok('suite ran to the end', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
