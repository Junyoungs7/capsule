// (a9) a8 제안 전부 + 할 일 달력 펼침 — HEADLESS only (headless.mjs; never launches Hera, never real input, no real file dialog).
//   node .omc/verify/a9-cdp.mjs
// 1 파일 대화상자가 떠 있는 동안 아일랜드 밖 클릭 무시 (채팅 + · 선반 '파일 고르기' · 펫 zip) → 닫히면 다시
// 2 지우기 = 5초 '되돌리기' (할 일 · 일정 · 메모 보드) → 그대로 복원
// 3 영문·${…} 뒤 조사 띄어쓰기 없음 (grep)  4 화면 문구에 'Island' 없음 → '캡슐'  5 달력 추가 칸은 자동 포커스 없음
// 6 할 일: 작은 달력이 처음부터 펼쳐짐 · 칩으로 접기 · 스크롤 없음 · 커서 = 제목 · '할 일 + Enter' 저장
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globSync } from 'node:fs'
import { start, sleep, suite } from './headless.mjs'

const { ok, until, done } = suite('a9')
const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/* 3·4. 문구 grep (앱 없이) — 문자열·JSX 글자만, 주석 줄 제외 (particles.py 와 같은 규칙) */
const P = '((?:에서|으로|에게|에|가|를|을|은|는|의|로|와|과|도|만|까지|부터|처럼|보다|예요|이에요)+)'
const RX = new RegExp(`([A-Za-z0-9}]) ${P}(?=[\\s.,·!?)'"\`<:;—…]|$)`, 'g')
const SPAN = /'[^'\n]*'|"[^"\n]*"|`[^`\n]*`|[>}][^<>{}\n]*</g
const ALLOW = [] // 분명한 예외만 (지금 없음)
const files = [...globSync('src/**/*.{ts,tsx}', { cwd: ROOT }), ...globSync('src-tauri/src/*.rs', { cwd: ROOT })]
const spaced = [], island = []
for (const f of files) {
  readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((l, i) => {
    const t = l.trim()
    if (/^(\/\/|\/\*|\*)/.test(t)) return
    const code = l.replace(/(?<![:"'`])\s\/\/\s.*$/, '')
    if (!/[가-힣]/.test(code)) return
    for (const s of code.match(SPAN) ?? []) {
      for (const m of s.match(RX) ?? []) if (!ALLOW.includes(m)) spaced.push(`${f}:${i + 1} "${m}"`)
      // 화면에 보이는 한국어 문구 안의 Island (MCP 의 영어 설명 'in the Island' 같은 AI 용 영어 부분은 제외)
      if (/[가-힣]/.test(s) && /Island(?! \()/.test(s.replace(/ in the Island|the Island/g, ''))) island.push(`${f}:${i + 1}`)
    }
  })
}
ok(`no space between a Latin word / \${…} and its particle in UI strings (${files.length} files)`, spaced.length === 0, spaced.slice(0, 5).join(' | '))
ok('no "Island" in user-facing Korean strings (it is 캡슐)', island.length === 0, island.slice(0, 5).join(' | '))

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
const focused = (p = isl) => p.eval(`document.activeElement?.getAttribute('aria-label')`)
const set = (k, v) => isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: ${JSON.stringify(k)}, value: ${JSON.stringify(v)} })`)
const rectIn = (p, sel, hit) => p.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? [r.left, r.top, r.width, r.height] : null })()`).then((r) => !!r && (!hit || (r[0] >= hit[0] && r[1] >= hit[1] && r[0] + r[2] <= hit[0] + hit[2] + 0.5 && r[1] + r[3] <= hit[1] + hit[3] + 0.5)))
const tmp = mkdtempSync(join(tmpdir(), 'hera-a9-'))

try {
  h.handlers.team_state = () => ({ name: '나', pk: 'me', groups: [{ id: 'g1', name: '개발팀', color: '#14b8a6', members: [{ name: '나', pk: 'me' }], alarms: true, news: true }], online: [] })
  h.store.set('chat.group', 'g1')
  isl = await h.open('island')
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(400)

  /* 1. 파일 대화상자 지킴이 — 채팅 + (웹뷰 파일 고르기를 CDP 가 가로챔: 실제 대화상자 없음) */
  let chooser = null
  isl.on('Page.fileChooserOpened', (e) => (chooser = e))
  await isl.send('Page.setInterceptFileChooserDialog', { enabled: true })
  await openView('chat')
  await isl.clickSel('.view[data-k=chat] .chat-plus')
  ok('chat +: file chooser opens and the guard is up', await until(() => !!chooser && isl.eval(`window.__heraPicking === 1`)))
  await h.emitTo('island', 'island-outside', null)
  await sleep(300)
  ok('…a click inside the dialog (island-outside) does not collapse the hub', await hubOpen())
  const f1 = join(tmp, '회의록.txt')
  writeFileSync(f1, 'hello')
  const n1 = h.calls.length
  await isl.send('DOM.setFileInputFiles', { files: [f1], backendNodeId: chooser.backendNodeId })
  ok('…picking a file attaches it (chat_attach) and drops the guard', await until(() => h.calls.slice(n1).some((c) => c[1] === 'chat_attach')) && (await until(() => isl.eval(`window.__heraPicking === 0`))))
  await h.emitTo('island', 'island-outside', null)
  ok('…after the dialog closes, an outside click collapses the hub again', await until(async () => !(await hubOpen())))
  await sleep(450)
  await isl.send('Page.setInterceptFileChooserDialog', { enabled: false })

  /* 선반 빈 상태: '파일 고르기' (Rust 대화상자 = 가짜, 응답을 늦춘다) */
  let answer
  h.handlers.pick_files = () => new Promise((r) => (answer = r))
  await openView('shelf')
  ok('shelf empty state has a "파일 고르기" button', await isl.eval(`!!document.querySelector('.view[data-k=shelf] [data-shelf-pick]')`))
  await isl.clickSel('.view[data-k=shelf] [data-shelf-pick]')
  await until(() => !!answer)
  ok('…Rust file dialog requested (pick_files) with the guard up', h.calls.some((c) => c[1] === 'pick_files') && (await isl.eval(`window.__heraPicking === 1`)))
  await h.emitTo('island', 'island-outside', null)
  await sleep(300)
  ok('…hub stays open while the dialog is up', await hubOpen())
  answer(['C:\\Users\\me\\Documents\\기획서_v3.pdf'])
  ok('…picked file lands on the shelf', await until(() => [...h.store].some(([k, v]) => k.startsWith('shelf:') && /기획서_v3/.test(v?.path ?? ''))))
  ok('…guard dropped after it closes', await until(() => isl.eval(`window.__heraPicking === 0`)))
  await close()
  await until(() => isl.eval(`document.querySelector('.isl').dataset.mode === 'idle'`), 9000) // 선반 알림 알약(6초)이 지나가길

  /* 2. 지우기 되돌리기 — 할 일 */
  const todo = { id: 't1', title: '보고서 제출', start: new Date(Date.now() + 3600e3).toISOString(), due: new Date(Date.now() + 7200e3).toISOString(), done: false, source: 'local' }
  await set('todo:t1', todo)
  await openView('todo')
  const hit = () => (h.hits.get('island') ?? [])[0]
  await isl.clickSel('.view[data-k=todo] .list li .del')
  ok('할 일 ×: removed at once', await until(() => !h.store.has('todo:t1')))
  ok('…a "되돌리기" toast shows inside the view (inside the hit rect)', await until(async () => (await isl.eval(`/할 일을 지웠어요/.test(document.querySelector('.view[data-k=todo] .undo-toast')?.textContent ?? '')`)) && (await rectIn(isl, '.view[data-k=todo] .undo-toast [data-undo]', hit()))))
  await isl.clickSel('.view[data-k=todo] .undo-toast [data-undo]')
  ok('…되돌리기 restores it exactly', await until(() => JSON.stringify(h.store.get('todo:t1')) === JSON.stringify(todo)), JSON.stringify(h.store.get('todo:t1')))
  ok('…toast goes away', await until(() => isl.eval(`!document.querySelector('.undo-toast')`)))
  await isl.clickSel('.view[data-k=todo] .list li .del')
  await until(() => isl.eval(`!!document.querySelector('.undo-toast')`))
  ok('…without undo the toast leaves after 5 s and the item stays deleted', !(await isl.eval(`!document.querySelector('.undo-toast')`)) && (await sleep(5400), await isl.eval(`!document.querySelector('.undo-toast')`)) && !h.store.has('todo:t1'))
  await close()

  /* 일정 */
  const now = new Date(), s0 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15)
  const ev = { id: 'e1', title: '디자인 리뷰', start: s0.toISOString(), end: new Date(s0.getTime() + 3600e3).toISOString(), source: 'local' }
  await set('event:e1', ev)
  await openView('calendar')
  ok('달력: the add field is not auto-focused (view is for looking)', (await focused()) !== '일정 제목', await focused())
  await isl.clickSel('.view[data-k=calendar] .list li.ev .del')
  ok('일정 ×: removed, toast shown', await until(() => !h.store.has('event:e1')) && (await until(() => isl.eval(`/일정을 지웠어요/.test(document.querySelector('.undo-toast')?.textContent ?? '')`))))
  await isl.clickSel('.view[data-k=calendar] .undo-toast [data-undo]')
  ok('…되돌리기 restores the event exactly', await until(() => JSON.stringify(h.store.get('event:e1')) === JSON.stringify(ev)))
  await close()

  /* 메모 보드 (떠 있는 창) */
  const note = { id: 'm1', text: '와이파이 HERA-5G', color: 3, x: 248, y: 16, w: 210, h: 140 }
  await set('note:m1', note)
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('float_open', { f: 'notes' })`)
  await until(() => h.pages.has('float-notes'), 8000)
  const bd = h.pages.get('float-notes')
  await until(() => bd.eval(`!!document.querySelector('.note[data-id=m1]')`))
  await bd.clickSel('.note[data-id=m1] [aria-label="메모 삭제"]')
  ok('메모 삭제: removed, toast in the board window', await until(() => !h.store.has('note:m1')) && (await until(() => bd.eval(`/메모를 지웠어요/.test(document.querySelector('.undo-toast')?.textContent ?? '')`))))
  await bd.clickSel('.undo-toast [data-undo]')
  ok('…되돌리기 puts the note back exactly (text · colour · place · size)', await until(() => JSON.stringify(h.store.get('note:m1')) === JSON.stringify(note)) && (await until(() => bd.eval(`!!document.querySelector('.note[data-id=m1]')`))))
  ok('…the toast uses the motion-pack pop', await bd.eval(`(() => { const t = document.querySelector('.undo-toast'); return !t || /undo-in/.test(getComputedStyle(t).animationName) })()`))
  await h.closePage('float-notes')

  /* 4. 캡슐 용어 (실제 화면) */
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('float_open', { f: 'todo' })`)
  await until(() => h.pages.has('float-todo'), 8000)
  const ft = h.pages.get('float-todo')
  ok('window button says "캡슐로" (not "Island로")', await until(() => ft.eval(`/캡슐로/.test(document.querySelector('.wbar [data-absorb]')?.textContent ?? '') && !/Island/.test(document.querySelector('.wbar').textContent)`)))
  await h.closePage('float-todo')

  /* 6. 할 일: 작은 달력이 처음부터 */
  await openView('todo')
  ok('할 일: the mini calendar is open by default', await isl.eval(`!!document.querySelector('.view[data-k=todo] .dr .dr-grid') && document.querySelector('.view[data-k=todo] [data-cal]').getAttribute('aria-expanded') === 'true'`))
  ok('…cursor still lands in the title field', (await focused()) === '할 일 제목', await focused())
  ok('…the view fits its content (no scrollbar)', await isl.eval(`(() => { const b = document.querySelector('.view[data-k=todo] .vbody'); return b.scrollHeight - b.clientHeight <= 1 })()`))
  ok('…size changes on toggle are animated by the motion pack (skin height spring)', await isl.eval(`/height/.test(getComputedStyle(document.querySelector('.isl .skin')).transitionProperty)`))
  await isl.clickSel('.view[data-k=todo] [data-cal]')
  ok('…달력 chip collapses it', await until(() => isl.eval(`!document.querySelector('.view[data-k=todo] .dr')`)))
  await isl.clickSel('.view[data-k=todo] [data-cal]')
  ok('…and opens it again', await until(() => isl.eval(`!!document.querySelector('.view[data-k=todo] .dr')`)))
  await isl.clickSel('.view[data-k=todo] .add input')
  await isl.type('주간 보고')
  await isl.key('Enter')
  const saved = async () => { for (let t = 0; t < 3000; t += 100) { const v = [...h.store].find(([k, v]) => k.startsWith('todo:') && v?.title === '주간 보고'); if (v) return v[1]; await sleep(100) } return null }
  const t1 = await saved()
  ok('…"할 일 + Enter" still saves with the defaults (now → +1h)', !!t1 && new Date(t1.due) - new Date(t1.start) === 3600000, JSON.stringify(t1))

  /* 펫 zip 가져오기 (설정 창) — 같은 지킴이 */
  const sw = await h.open('settings&sec=pet', { label: 'settings', geo: { x: 490, y: 176, w: 940, h: 680 } })
  await until(() => sw.eval(`!!document.querySelector('.swin .ptile.add')`), 8000)
  await sw.send('Page.setInterceptFileChooserDialog', { enabled: true })
  let ch2 = null
  sw.on('Page.fileChooserOpened', (e) => (ch2 = e))
  await sw.eval(`document.querySelector('.pettabs [data-pettab=custom]').click()`)
  await until(() => sw.eval(`[...document.querySelectorAll('.petgrid .ptile.add')].some((b) => /zip/.test(b.textContent))`))
  await sw.clickSel('.petgrid .ptile.add[title=".herapet.zip 가져오기"]') // 실제 입력 이벤트(헤드리스 페이지 안) — 파일 고르기는 사용자 동작이 있어야 열린다
  ok('pet zip import goes through the same guard', await until(() => !!ch2 && sw.eval(`window.__heraPicking === 1`)))
  ok('no page errors', isl.errors.length === 0 && sw.errors.length === 0 && bd.errors.length === 0, [...isl.errors, ...sw.errors, ...bd.errors].slice(0, 2).join(' | '))
} catch (e) {
  ok('suite ran to the end', false, String(e?.stack ?? e))
} finally {
  await h.close()
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(done() ? 1 : 0)
