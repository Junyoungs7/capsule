// (a3) Island suite — HEADLESS only (see headless.mjs: Vite + headless Chrome + mocked Tauri IPC). Never launches Hera, never moves the real mouse.
//   node .omc/verify/island-cdp.mjs
// Covers: corner capsule geometry + hit rect · hover intent (150ms dwell / 300ms grace / hysteresis, no restart) · tap → hub
//   · all 13 hub icons give a visible response · 메모 view (bug 1) · Ctrl+` terminal 640×300 upward · capsule size live · place bl
//   · alerts drive the pet · sleep + paused animations · detach/absorb/close keep the capsule clickable (bug 5) · frame times (bug 2/4)
//   · float drag = own pointer drag (no OS caption / no maximise on double-click) + absorb on the capsule (bug 3).
import { start, sleep, suite, WA, ISL } from './headless.mjs'

const { ok, until, done } = suite('island')
const h = await start()
let isl
// [폭, 최대 높이] — (a4) 높이는 내용에 맞춘다, 터미널·채팅만 고정
const VIEW = { notes: [380, 560], todo: [380, 600], calendar: [480, 620], chat: [400, 480], term: [640, 300], clips: [380, 520], shelf: [360, 480], ocr: [360, 300], snippets: [380, 520], team: [400, 560], link: [380, 400], settings: [380, 640] }
const FIXED = ['term', 'chat']
// 화면 = 잰 내용 높이 · 보통 내용엔 스크롤 없음
const fits = (k) => isl.eval(`(() => { const v = document.querySelector('.isl .view[data-k=${k}]'), b = v.querySelector('.vbody'), s = document.querySelector('.isl .skin').getBoundingClientRect(); return { skinH: Math.round(s.height), viewH: v.offsetHeight, scroll: b.scrollHeight - b.clientHeight } })()`)

const skin = () => isl.eval(`(() => { const r = document.querySelector('.isl .skin').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round) })()`)
const mode = () => isl.eval(`document.querySelector('.isl').dataset.mode`)
const hubOpen = () => isl.eval(`document.querySelector('.isl').dataset.open === 'true'`)
const capsuleCenter = async () => { const s = await skin(); return [s[0] + s[2] / 2, s[1] + s[3] / 2] }
const frames = () => isl.eval(`(() => { const f = (window.__heraFrames || []).slice(2); const s = f.slice().sort((a, b) => a - b); return { n: f.length, p50: +(s[Math.floor(f.length * 0.5)] ?? 0).toFixed(1), p95: +(s[Math.floor(f.length * 0.95)] ?? 0).toFixed(1), max: +(s[f.length - 1] ?? 0).toFixed(1), within17: +(f.filter((x) => x <= 17).length / Math.max(1, f.length)).toFixed(3) } })()`)
const allFrames = []
// 허브·화면 열기 (펼쳐지는 중에는 위쪽이 잘려 있으니 다 펼쳐진 뒤 누른다)
const openView = async (k) => {
  if (!(await hubOpen())) await isl.click(...(await capsuleCenter()))
  await until(hubOpen)
  if (await isl.eval(`!!document.querySelector('.isl .view')`)) await isl.clickSel('.isl .view [data-back]')
  await until(async () => (await isl.eval(`!!document.querySelector('.hub .app')`)) && (await skin())[2] === 432)
  await sleep(250)
  await isl.clickSel(`.hub .app[data-go=${k}]`)
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=${k}]')`))
  await sleep(650)
}
const hitOk = async (label) => {
  // Rust 가 쥔 히트 rect(가짜 Rust 가 island_tall 때 옮긴 값) 가 지금 캡슐을 덮는가 + 실제 마우스 길(헤드리스)로 머묾·탭이 되는가
  const r = (h.hits.get('island') ?? [])[0], s = await skin()
  const covers = !!r && r[0] <= s[0] && r[1] <= s[1] && r[0] + r[2] >= s[0] + s[2] && r[1] + r[3] >= s[1] + s[3] && (await isl.eval('innerWidth')) === ISL.w
  ok(`${label}: island back to ${ISL.w}×${ISL.h} and hit rect still covers the capsule`, covers, JSON.stringify({ r, s }))
  const [x, y] = await capsuleCenter()
  await isl.mouse('mouseMoved', x, y)
  ok(`${label}: hover still works`, await until(() => isl.eval(`document.querySelector('.isl').dataset.hover === 'true'`), 1500))
  await isl.click(x, y)
  ok(`${label}: tap still opens the hub`, await until(hubOpen, 1500))
  await isl.key('Escape')
  await until(async () => !(await hubOpen()))
  await isl.mouse('mouseMoved', 10, 10)
  await until(() => isl.eval(`document.querySelector('.isl').dataset.hover === 'false'`), 1500)
  await sleep(450)
}

try {
  isl = await h.open('island')
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(500)

  /* 1. 모서리 캡슐 */
  const s0 = await skin()
  ok('capsule = 80×60 (보통) at the bottom-right corner, 16px in · 8px above the taskbar', s0[2] === 80 && s0[3] === 60 && s0[0] + s0[2] === ISL.w - 16 && s0[1] + s0[3] === ISL.h - 8, JSON.stringify(s0))
  ok('no clock, no dots — a pet lives in it', await isl.eval(`!document.querySelector('.isl .time, .isl .dot, .island-shape, .hubnotch') && document.querySelector('.isl .pet').dataset.pet === 'cat'`))
  const hr0 = (h.hits.get('island') ?? [])[0]
  ok('hit rect = capsule + 6px', JSON.stringify(hr0) === JSON.stringify([s0[0] - 6, s0[1] - 6, s0[2] + 12, s0[3] + 12]), JSON.stringify(hr0))
  ok('Pretendard (bundled) is the UI font', /Pretendard/.test(await isl.eval(`getComputedStyle(document.querySelector('.isl')).fontFamily`)))

  /* 2. 머묾 (hover intent) */
  const [cx, cy] = await capsuleCenter()
  await isl.mouse('mouseMoved', cx, cy)
  await sleep(90)
  ok('no expand before 150ms dwell', (await isl.eval(`document.querySelector('.isl').dataset.hover`)) === 'false')
  ok('expands after the dwell', await until(() => isl.eval(`document.querySelector('.isl').dataset.hover === 'true'`), 400))
  await sleep(380)
  const tf = await isl.eval(`getComputedStyle(document.querySelector('.isl .skin')).transform`)
  ok('hover = calm scale 1.06 (no overshoot)', /matrix\(1\.06/.test(tf), tf)
  const hr1 = (h.hits.get('island') ?? [])[0]
  ok('hysteresis: hit area grows to +16px while hovered', hr1 && hr1[0] === s0[0] - 16 && hr1[2] === s0[2] + 32, JSON.stringify(hr1))
  await isl.mouse('mouseMoved', 20, 20)
  await sleep(180)
  ok('300ms grace before collapsing', (await isl.eval(`document.querySelector('.isl').dataset.hover`)) === 'true')
  ok('collapses after the grace', await until(() => isl.eval(`document.querySelector('.isl').dataset.hover === 'false'`), 500))
  // 오갔다 돌아옴: 트랜지션이 중간에서 되돌아간다 (처음부터 다시 돌지 않음) — 애니메이션 아님 · 깃발 하나
  ok('hover is a single transition flag (no keyframe restart)', await isl.eval(`getComputedStyle(document.querySelector('.isl .skin')).animationName === 'none' && /transform 0\\.32s/.test(getComputedStyle(document.querySelector('.isl .skin')).transition)`))
  await isl.mouse('mouseMoved', cx, cy)
  await sleep(60)
  await isl.mouse('mouseMoved', 20, 20)
  await sleep(400)
  ok('a quick pass-through never expands', (await isl.eval(`document.querySelector('.isl').dataset.hover`)) === 'false')

  /* 3. 탭 → 허브 (모서리에서 위·안쪽으로) */
  await isl.click(cx, cy)
  ok('tap opens the hub', await until(hubOpen))
  await sleep(700)
  const hs = await skin()
  ok('hub grows up and inward from the corner (432 wide, bottom-right fixed)', hs[2] === 432 && hs[0] + hs[2] === ISL.w - 16 && hs[1] + hs[3] === ISL.h - 8 && hs[3] > 300, JSON.stringify(hs))
  const labels = await isl.eval(`[...document.querySelectorAll('.hub .app')].map((b) => b.textContent).join(',')`)
  ok('13 labelled icons in tinted wells', labels === '메모,할 일,달력,채팅,터미널,최근 복사,선반,OCR,스니펫,LP,Team,Link,설정' && (await isl.eval(`document.querySelectorAll('.hub .app .well svg').length`)) === 13, labels)
  ok('hit rect = whole hub while open', (() => { const r = (h.hits.get('island') ?? [])[0]; return r && r[2] === 432 })())

  /* 4. 아이콘 13개 모두 눈에 보이는 반응 (버그 1) */
  for (const k of ['notes', 'todo', 'calendar', 'chat', 'term', 'clips', 'shelf', 'ocr', 'snippets', 'lp', 'team', 'link', 'settings']) {
    if (!(await hubOpen()) || (await isl.eval(`!!document.querySelector('.isl .view')`))) {
      await isl.key('Escape')
      await until(async () => !(await hubOpen()))
      await sleep(450)
      const [x, y] = await capsuleCenter()
      await isl.click(x, y)
      await until(() => isl.eval(`!!document.querySelector('.hub .app[data-go=notes]')`))
      await sleep(200)
    }
    const n0 = h.calls.length
    await isl.clickSel(`.hub .app[data-go=${k}]`)
    if (k === 'lp') {
      ok(`icon LP → LP player window (desktop prop)`, await until(() => h.pages.has('float-lp') && h.calls.slice(n0).some((c) => c[1] === 'float_open' && c[2]?.f === 'lp')), '')
      await h.closePage('float-lp')
      continue
    }
    const shown = await until(() => isl.eval(`(() => { const v = document.querySelector('.isl .view[data-k=${k}]'); return !!v && v.offsetWidth > 0 && document.querySelector('.isl .vhead b')?.textContent?.length > 0 })()`), 2000)
    await sleep(650)
    const s = await skin()
    const f = await fits(k)
    ok(`icon ${k} → its view opens in the Island, sized to its content (w ${VIEW[k][0]}, h ≤ ${VIEW[k][1]})`, shown && s[2] === VIEW[k][0] && (FIXED.includes(k) ? s[3] === VIEW[k][1] : s[3] === f.viewH && s[3] <= VIEW[k][1]), JSON.stringify({ s, f }))
    if (!['team', 'settings'].includes(k)) ok(`…${k}: no scrollbar for normal content`, f.scroll <= 1, JSON.stringify(f))
  }

  /* 5. 메모 (버그 1): 목록 · 새 메모 · '데스크톱에 붙이기' */
  await isl.clickSel('[data-back]')
  await until(() => isl.eval(`!!document.querySelector('.hub .app[data-go=notes]')`))
  await sleep(200)
  await isl.clickSel('.hub .app[data-go=notes]')
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=notes] textarea')`))
  ok('메모 view has a new-note button and 데스크톱에 붙이기', await isl.eval(`!!document.querySelector('.view[data-k=notes] .vhead [aria-label="새 메모"]') && /데스크톱에 붙이기/.test(document.querySelector('.view[data-k=notes] [data-attach]')?.textContent ?? '')`))
  await isl.clickSel('.view[data-k=notes] textarea')
  await isl.type('배너 QA 3시')
  await isl.clickSel('.view[data-k=notes] [data-attach]')
  ok('데스크톱에 붙이기 → a desktop note + notes shown', await until(() => [...h.store].some(([k, v]) => k.startsWith('note:') && v?.text === '배너 QA 3시') && h.store.get('notes.shown') === true))
  ok('…and the Island answers (collapses)', await until(async () => !(await hubOpen())))
  await sleep(450)
  await openView('notes')
  ok('memo list shows the note', await until(() => isl.eval(`[...document.querySelectorAll('.view[data-k=notes] .memo b')].some((b) => b.textContent === '배너 QA 3시')`)))
  await isl.key('Escape')
  await until(async () => !(await hubOpen()))
  await sleep(450)

  /* 6. Ctrl+` 터미널 (전역 단축키 → 'island-open') */
  await h.emitTo('island', 'island-open', 'term')
  ok('Ctrl+` opens the terminal view', await until(() => isl.eval(`!!document.querySelector('.view[data-k=term]')`)))
  ok('xterm lazy-loaded inside', await until(() => isl.eval(`!!document.querySelector('.view[data-k=term] .xterm')`), 8000))
  await sleep(700)
  const ts = await skin()
  ok('terminal = 640×300, opens upward and inward from the corner', ts[2] === 640 && ts[3] === 300 && ts[0] + ts[2] === ISL.w - 16 && ts[1] + ts[3] === ISL.h - 8, JSON.stringify(ts))
  await isl.key('Escape')
  ok('Esc folds it back into the capsule', await until(async () => !(await hubOpen())))
  await sleep(500)

  /* 7. 알림 → 펫 자세 + 글 알약 */
  const pose = () => isl.eval(`document.querySelector('.isl .pet').dataset.s`)
  await h.emitTo('island', 'term-done', { ok: true, cmd: 'npm run build', ms: 2400, focused: false })
  ok('terminal done → cheering pet + "완료" pill', await until(async () => (await pose()) === 'done' && (await mode()) === 'alert' && /npm run build/.test(await isl.eval(`document.querySelector('.isl .ptext').textContent`))))
  await sleep(500)
  const ps = await skin()
  ok('alert pill keeps the corner, only width grows', ps[3] === 60 && ps[0] + ps[2] === ISL.w - 16 && ps[2] > 80, JSON.stringify(ps))
  await h.emitTo('island', 'term-done', { ok: false, cmd: 'cargo test', ms: 2400, focused: false })
  ok('terminal fail → worried pet, red rim', await until(async () => (await pose()) === 'fail' && (await isl.eval(`document.querySelector('.isl .skin').classList.contains('fail')`))))
  await isl.clickSel('.isl .ptext')
  ok('tapping the fail pill opens the terminal view', await until(() => isl.eval(`!!document.querySelector('.view[data-k=term]')`)))
  await isl.key('Escape')
  await until(async () => !(await hubOpen()))
  await h.emitTo('island', 'term-state', { running: true, cmd: 'npm run dev' })
  ok('terminal running → persistent typing pose', await until(async () => (await pose()) === 'typing', 8000))
  await h.emitTo('island', 'term-state', { running: false, cmd: '' })
  await h.emit('chat-msg', { id: 'm1', group: 'g', by: '민수', byPk: 'ff', kind: 'text', text: '내일 3시 회의 어때요?', at: Date.now() })
  ok('chat → pet perks up with a bubble + pill', await until(async () => (await pose()) === 'chat' && /민수/.test(await isl.eval(`document.querySelector('.isl .ptext').textContent`))))

  /* 8. 크기 (live) · 정수 픽셀 · 위치 */
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: 'island.size', value: 'xl' })`)
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: 'island.pet', value: 'pxcat' })`)
  await sleep(2000) // 알림이 사라지기를 (6초 중 남은 시간은 아래에서)
  ok('capsule size applies live: 아주 크게 = 112×84', await until(async () => { const s = await skin(); return s[2] === 112 && s[3] === 84 }, 8000), JSON.stringify(await skin()))
  const pk = await isl.eval(`parseFloat(getComputedStyle(document.querySelector('.isl')).getPropertyValue('--pk'))`)
  ok('pixel pet: one art pixel = whole device pixels', Number.isInteger(+(pk * 2.5 * 1).toFixed(6)) && pk * 2.5 === 4, String(pk))
  ok('hub/views never scale with the capsule', (await (async () => { await isl.click(...(await capsuleCenter())); await until(hubOpen); await sleep(600); const s = await skin(); await isl.key('Escape'); await until(async () => !(await hubOpen())); return s[2] })()) === 432)
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: 'island.size', value: 'm' })`)
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: 'island.place', value: 'bl' })`)
  await sleep(700)
  const bl = await skin()
  ok('place = 왼쪽 아래 moves the capsule to the left corner', bl[0] === 16 && bl[1] + bl[3] === ISL.h - 8, JSON.stringify(bl))
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: 'island.place', value: 'br' })`)
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: 'island.pet', value: 'cat' })`)
  await sleep(700)

  /* 9. 잠 (2분 → 시험은 짧게) · 멈춘 자세 */
  await isl.eval(`window.__heraSleepMs = 400`)
  await h.closePage('island')
  isl = await h.open('island', { init: 'window.__heraSleepMs = 600' })
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: 'chat.unread', value: 0 })`)
  ok('no events for the sleep time → the pet sleeps', await until(() => isl.eval(`document.querySelector('.isl .pet').dataset.s === 'sleep'`), 4000))
  ok('…and its animations pause (idle CPU ≈ 0)', await until(() => isl.eval(`document.querySelector('.isl').dataset.still === 'true' && getComputedStyle(document.querySelector('.isl .pbody')).animationPlayState === 'paused'`), 12000))
  await h.closePage('island')
  isl = await h.open('island')
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)
  await sleep(500)

  /* 10. 떼어내기 → 흡수 → 닫기: 캡슐이 계속 클릭된다 (버그 5) + 프레임 (버그 2 · 4) */
  await openView('todo')
  await isl.eval(`window.__heraFrames = []`)
  const n0 = h.calls.length
  await isl.clickSel('.view[data-k=todo] [data-detach]')
  ok('detach: the real window is created hidden first (float_prepare)', await until(() => h.calls.slice(n0).some((c) => c[1] === 'float_prepare' && c[2]?.f === 'todo')))
  const fit = h.calls.slice(n0).find((c) => c[1] === 'float_prepare')?.[2]?.fit
  ok('…sized to the measured view (no scroll in the window)', !!fit && fit[0] === 380 && fit[1] > 100 && fit[1] < 600, JSON.stringify(fit))
  ok('…window shown only after it painted', await until(() => h.pages.get('float-todo')?.shown) && h.pages.get('float-todo')?.ready === true)
  let wide = false
  for (let t = 0; t < 1200; t += 40) (wide ||= (await isl.eval('innerWidth')) !== ISL.w), await sleep(40)
  ok('…the Island window never resizes for a detach (no work-area surface)', !wide && !h.calls.slice(n0).some((c) => c[1] === 'island_tall'))
  const ft = h.pages.get('float-todo')
  ok('…window enters in place (transform/opacity, solid while entering)', await until(() => ft.eval(`document.querySelector('.win').dataset.enter === 'in'`), 2000))
  const fd = await frames()
  allFrames.push(['detach · island collapse', fd])
  ok('detach: island frames ≥95% ≤17ms', fd.within17 >= 0.95, JSON.stringify(fd))
  await sleep(500)
  const fe = await ft.eval(`(() => { const f = (window.__heraFrames || []).slice(2); return { n: f.length, within17: +(f.filter((x) => x <= 17).length / Math.max(1, f.length)).toFixed(3), max: +Math.max(0, ...f).toFixed(1) } })()`)
  allFrames.push(['detach · window entrance', fe])
  ok('detach: window entrance frames ≥95% ≤17ms', fe.n > 10 && fe.within17 >= 0.95, JSON.stringify(fe))
  ok('detached window content fits (no scrollbar)', await ft.eval(`(() => { const b = document.querySelector('.win .vbody'); return b.scrollHeight - b.clientHeight <= 1 })()`))
  const calls = h.calls.slice(n0).map((c) => c[1])
  ok('window creation never overlaps the motion (prepare → ready → move → show)', calls.indexOf('float_prepare') < calls.indexOf('float_show'))
  await until(() => isl.eval(`innerWidth === ${ISL.w}`), 3000)
  await hitOk('after detach')

  // 떠 있는 창: 'Island로' · 핀 · 닫기 (최소화 없음), 머리줄 두 번 누르기 = 아무 일 없음
  const fw = h.pages.get('float-todo')
  await until(() => fw.eval(`!!document.querySelector('.win .wbar')`), 5000)
  ok('window chrome = Island로 · pin · close (no minimise)', await fw.eval(`[...document.querySelectorAll('.wbar .act button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()).join('|')`) === 'Island로|항상 위|닫기')
  ok('no OS caption drag region anywhere', await fw.eval(`!document.querySelector('[data-tauri-drag-region]')`))
  const nd = h.calls.length
  await fw.click(120, 20, 2)
  await sleep(300)
  ok('double-clicking the header does not maximise', !h.calls.slice(nd).some((c) => /maxim|toggle/i.test(c[1])) && fw.geo.w === 380)

  // 'Island로' → 흡수 (단색 유령, transform/opacity 만)
  await isl.eval(`window.__heraFrames = []`)
  await fw.clickSel('[data-absorb]')
  ok('Island로: window destroyed', await until(() => !h.pages.has('float-todo'), 4000))
  ok('…genie into the capsule finished (gulp)', await until(() => isl.eval(`!document.querySelector('.ghost-win')`), 4000))
  const fa = await frames()
  allFrames.push(['absorb', fa])
  ok('absorb frames ≥95% ≤17ms', fa.within17 >= 0.95, JSON.stringify(fa))
  await until(() => isl.eval(`innerWidth === ${ISL.w}`), 3000)
  await sleep(500)
  // 흡수 직후 탭 = 그 화면
  await isl.click(...(await capsuleCenter()))
  ok('tap right after = the absorbed view', await until(() => isl.eval(`!!document.querySelector('.view[data-k=todo]')`)))
  await isl.key('Escape')
  await until(async () => !(await hubOpen()))
  await sleep(450)
  await hitOk('after absorb')

  // 머리줄 끌기 → 캡슐 위에 놓으면 흡수 (자석)
  await openView('calendar')
  await isl.clickSel('.view[data-k=calendar] [data-detach]')
  await until(() => h.pages.get('float-calendar')?.shown, 5000)
  await sleep(500)
  const fc = h.pages.get('float-calendar')
  await until(() => fc.eval(`!!document.querySelector('.wbar')`), 5000)
  const g0 = { ...fc.geo }
  h.setCursor(g0.x + 100, g0.y + 20)
  await fc.mouse('mouseMoved', 100, 20)
  await fc.mouse('mousePressed', 100, 20)
  const io = h.pages.get('island').geo, cap = (h.hits.get('island') ?? [])[0]
  const target = [io.x + cap[0] + cap[2] / 2, io.y + cap[1] + cap[3] / 2]
  for (let i = 1; i <= 12; i++) {
    const [x, y] = [g0.x + 100 + ((target[0] - g0.x - 100) * i) / 12, g0.y + 20 + ((target[1] - g0.y - 20) * i) / 12]
    h.setCursor(Math.round(x), Math.round(y))
    await fc.mouse('mouseMoved', 100 + (x - g0.x - 100), 20 + (y - g0.y - 20), { buttons: 1 })
    await sleep(20)
  }
  ok('own drag moves the window with the cursor (SetWindowPos path)', fc.geo.x !== g0.x && h.calls.some((c) => c[1] === 'float_drag' && c[2]?.phase === 'move'))
  ok('magnet: capsule swells near the corner', await until(() => isl.eval(`document.querySelector('.isl').dataset.magnet === 'hot'`), 2000))
  await fc.mouse('mouseReleased', 100 + (target[0] - g0.x - 100), 20 + (target[1] - g0.y - 20))
  ok('dropping on the capsule absorbs the window', await until(() => !h.pages.has('float-calendar'), 4000))
  await until(() => isl.eval(`!document.querySelector('.ghost-win') && innerWidth === ${ISL.w}`), 4000)
  await sleep(500)
  await hitOk('after drag-absorb')

  // 떼어낸 뒤 ✕ 로 닫기
  await openView('chat')
  await isl.eval(`window.__heraFrames = []`)
  await isl.clickSel('.view[data-k=chat] [data-detach]')
  await until(() => h.pages.get('float-chat')?.shown, 5000)
  await sleep(700)
  allFrames.push(['detach chat · island', await frames()])
  await h.pages.get('float-chat').clickSel('[data-wclose]')
  ok('✕ destroys the window', await until(() => !h.pages.has('float-chat'), 3000))
  await sleep(400)
  await hitOk('after close')

  ok('no page errors in the Island', isl.errors.length === 0, isl.errors.slice(0, 3).join(' | '))
  console.log('\nFRAMES', JSON.stringify(allFrames))
} catch (e) {
  ok('suite ran to the end', false, String(e?.stack ?? e))
} finally {
  await h.close()
}
process.exit(done() ? 1 : 0)
