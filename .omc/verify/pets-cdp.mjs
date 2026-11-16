// (a3) Pets suite — HEADLESS only (headless.mjs). 19 built-in pets × 8 states, pose from events, reduced motion,
// custom pet import (one image · folder + pet.json · sprite sheet · rename · delete · .herapet.zip import/export) through the real UI.
// Image files are generated here into a temp folder (no user files, nothing lands in the repo).
//   node .omc/verify/pets-cdp.mjs
import { start, sleep, suite } from './headless.mjs'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'

const { ok, until, done } = suite('pets')
const dir = mkdtempSync(join(tmpdir(), 'hera-pets-'))
function png(w, h, rgba) {
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length)
    b.writeUInt32BE(data.length, 0)
    b.write(type, 4, 'ascii')
    data.copy(b, 8)
    b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 8 + data.length)
    return b
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba(x, y).forEach((v, i) => (raw[y * (w * 4 + 1) + 1 + x * 4 + i] = v))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const file = (name, buf) => (writeFileSync(join(dir, name), buf), join(dir, name))
const blob = (x, y) => (Math.hypot(x - 8, y - 7) < 6 ? [255, 214, 77, 255] : [0, 0, 0, 0])
const PIX = file('mochi_idle.png', png(16, 14, blob))
const sub = join(dir, 'pack')
rmSync(sub, { recursive: true, force: true })
mkdirSync(sub)
writeFileSync(join(sub, 'idle.png'), png(16, 14, blob))
writeFileSync(join(sub, 'done.png'), png(16, 14, (x, y) => (blob(x, y)[3] ? [120, 220, 120, 255] : [0, 0, 0, 0])))
writeFileSync(join(sub, 'pet.json'), JSON.stringify({ version: 1, name: '말랑이', style: 'pixel' }))
const FOLDER = [sub] // 폴더 고르기 (webkitdirectory) = 폴더 경로
const SHEET = file('sheet_idle.png', png(64, 14, (x, y) => blob(x % 16, y)))
const ZIP = file('펭펭.herapet.zip', Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary'))

const h = await start()
let isl
let chooser = null // 다음 파일 고르기 창에 넣을 파일 (헤드리스 페이지 안에서만)
const pickNext = (files) => new Promise((r) => (chooser = { files, r }))
const skinOpen = () => isl.eval(`document.querySelector('.isl').dataset.open === 'true'`)
const settings = async () => {
  await until(() => isl.eval(`!document.querySelector('.view[data-k=petimport]')`), 1500) // 저장 뒤 설정으로 넘어가는 중
  if (!(await skinOpen())) await isl.clickSel('.isl .petbox')
  if (!(await isl.eval(`!!document.querySelector('.view[data-k=settings]')`))) {
    if (await isl.eval(`!!document.querySelector('.isl .view')`)) await isl.clickSel('.isl .view [data-back]')
    await until(() => isl.eval(`document.querySelector('.isl .skin').offsetWidth === 432 && !!document.querySelector('.hub .app')`))
    await sleep(250)
    await isl.clickSel('.hub .app[data-go=settings]')
  }
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=settings] .petpick')`))
  await sleep(500)
}
const tab = (name) => isl.eval(`[...document.querySelectorAll('.pettabs button')].find((b) => b.textContent === ${JSON.stringify(name)})?.click()`)

try {
  isl = await h.open('island')
  await isl.send('Page.setInterceptFileChooserDialog', { enabled: true })
  isl.on('Page.fileChooserOpened', async (e) => {
    const c = chooser
    chooser = null
    if (c) await isl.send('DOM.setFileInputFiles', { files: c.files, backendNodeId: e.backendNodeId }), c.r()
  })
  await until(() => isl.eval(`!!document.querySelector('.isl .pet')`), 8000)

  /* 1. 19 펫 · 4 스타일 */
  await settings()
  const counts = {}
  for (const [k, l] of [['pixel', '픽셀'], ['flat', '플랫'], ['clay', '클레이'], ['line', '라인']]) {
    await tab(l)
    await sleep(120)
    counts[k] = await isl.eval(`document.querySelectorAll('.petpick button[data-pet-set]').length`)
  }
  ok('19 built-in pets in 4 styles (5 pixel · 6 flat · 4 clay · 4 line)', JSON.stringify(counts) === '{"pixel":5,"flat":6,"clay":4,"line":4}', JSON.stringify(counts))
  const keys = ['pxcat', 'penguin', 'frog', 'slime', 'dragon', 'cat', 'dog', 'fox', 'rabbit', 'bird', 'ghost', 'duck', 'robot', 'blob', 'hamster', 'kitty', 'bear', 'bot', 'octo']
  await tab('픽셀')
  await sleep(100)
  await isl.clickSel('.petpick button[data-pet-set=penguin]')
  ok('picking a pet stores island.pet and the capsule changes', await until(() => h.store.get('island.pet') === 'penguin' && isl.eval(`document.querySelector('.isl .petbox .pet').dataset.pet === 'penguin'`)))
  await isl.key('Escape')
  await until(async () => !(await skinOpen()))

  /* 2. 19 × 8 자세가 모두 그려지고 상태 소품이 보인다 */
  const ACC = { idle: null, sleep: '.acc.z', chat: '.acc.bubble', event: '.acc.bell', typing: '.acc.laptop', done: '.acc.stars', fail: '.acc.bang', shelf: '.acc.box' }
  let bad = []
  for (const k of keys) {
    await isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: 'island.pet', value: '${k}' })`)
    await until(() => isl.eval(`document.querySelector('.isl .petbox .pet')?.dataset.pet === '${k}'`))
    for (const [st, acc] of Object.entries(ACC)) {
      const r = await isl.eval(`(() => { const p = document.querySelector('.isl .petbox .pet'); p.dataset.s = '${st}'; const body = p.querySelector('.pbody svg, .pbody .asc'); const a = ${acc ? `p.querySelector('${acc}')` : 'null'}; return { body: !!body && body.getBoundingClientRect().width > 0, acc: a ? (getComputedStyle(a).opacity !== '0' || getComputedStyle(a).animationName !== 'none' ? '1' : '0') : '1' } })()`)
      if (!r.body || r.acc === '0') bad.push(`${k}:${st}`)
    }
  }
  ok('all 19 pets render all 8 states with their overlays', bad.length === 0, bad.slice(0, 8).join(' '))

  /* 3. 이벤트가 자세를 정한다 (일정 · 선반) · 펫 누르기 = 허브 */
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: 'island.pet', value: 'cat' })`)
  await sleep(300)
  await h.emit('hera-alert', { title: '디자인 리뷰', body: '16:00 · 10분 후', key: 'event:x' })
  ok('event alert → bell pose + pill with actions', await until(() => isl.eval(`document.querySelector('.isl .pet').dataset.s === 'event' && /디자인 리뷰/.test(document.querySelector('.isl .ptext').textContent) && document.querySelectorAll('.isl .ptext:not(.measure) .chp').length === 2`)))
  await isl.eval(`[...document.querySelectorAll('.isl .ptext .chp')].find((b) => b.textContent === '완료').click()`)
  await until(() => isl.eval(`document.querySelector('.isl').dataset.mode === 'idle'`))
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: 'shelf:a', value: { id: 'a', path: 'C:\\\\x\\\\a.pdf', at: 1 } })`)
  ok('shelf has items → holding a box (persistent)', await until(() => isl.eval(`document.querySelector('.isl .pet').dataset.s === 'shelf'`), 9000))
  await isl.clickSel('.isl .petbox')
  ok('tapping the pet opens the hub', await until(skinOpen))
  await isl.key('Escape')
  await until(async () => !(await skinOpen()))

  /* 4. 움직임 줄이기 = 정지 자세 */
  const rm = await h.open('island', { label: 'island-rm', reduced: true })
  await until(() => rm.eval(`!!document.querySelector('.isl .pet')`), 8000)
  ok('reduced motion → static poses (no animation)', await rm.eval(`getComputedStyle(document.querySelector('.isl .pbody')).animationName === 'none' && getComputedStyle(document.querySelector('.isl .eye')).animationName === 'none'`))
  await h.closePage('island-rm')

  /* 5. 펫 추가: 이미지 1장 → 평소, 나머지는 소품 · 픽셀 자동 감지 · 정수 배율 */
  await settings()
  await tab('내 펫')
  await sleep(150)
  await isl.clickSel('.petpick [data-cpet=add]')
  ok('펫 추가 opens the import editor (440×640)', await until(() => isl.eval(`!!document.querySelector('.view[data-k=petimport]') && document.querySelector('.isl .skin').offsetWidth === 440`), 3000))
  ok('save disabled until there is an image', await isl.eval(`document.querySelector('[data-imp=save]').disabled`))
  let picked = pickNext([PIX])
  await isl.clickSel('[data-imp=pick]')
  await picked
  ok('one image → idle slot, name from the file, auto = 픽셀', await until(() => isl.eval(`!!document.querySelector('.slot[data-slot=idle] img') && document.querySelector('.view[data-k=petimport] .field input').value === 'mochi' && /자동 \\(픽셀\\)/.test(document.querySelector('.view[data-k=petimport] .seg').textContent)`)))
  ok('live preview capsule shows the image', await isl.eval(`!!document.querySelector('.imp-prev .cimg.px img')`))
  await isl.eval(`[...document.querySelectorAll('.imp-states button')].find((b) => b.textContent === '완료').click()`)
  ok('empty states fall back to idle + overlay (done = sparkles)', await until(() => isl.eval(`(() => { const p = document.querySelector('.imp-prev .pet'); return p.dataset.s === 'done' && p.querySelector('.cimg').dataset.st === 'idle' && getComputedStyle(p.querySelector('.acc.stars')).opacity === '1' })()`)))
  await isl.clickSel('[data-imp=save]')
  ok('save → pet_save (raw bytes) → selected as custom:<id>', await until(() => String(h.store.get('island.pet')).startsWith('custom:') && h.pets.size === 1))
  const pid = String(h.store.get('island.pet')).slice(7)
  ok('capsule shows the custom pet, pixelated', await until(() => isl.eval(`(() => { const i = document.querySelector('.isl .petbox .cimg.px img'); return !!i && getComputedStyle(i).imageRendering === 'pixelated' })()`)))
  const px = await isl.eval(`(() => { const i = document.querySelector('.isl .petbox .cimg img'); const pk = parseFloat(getComputedStyle(document.querySelector('.isl')).getPropertyValue('--pk')); return parseFloat(i.style.width) * pk * devicePixelRatio / 16 })()`)
  ok('pixel style: integer device pixels per art pixel', Math.abs(px - Math.round(px)) < 1e-6 && px >= 1, String(px))

  /* 6. 폴더 (+ pet.json) · 시트 */
  await settings()
  await tab('내 펫')
  await sleep(150)
  await isl.clickSel('.petpick [data-cpet=add]')
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=petimport]')`))
  picked = pickNext(FOLDER)
  await isl.clickSel('[data-imp=folder]')
  await picked
  ok('folder: <state>.png fills its slot, pet.json pre-fills the name', await until(() => isl.eval(`!!document.querySelector('.slot[data-slot=idle] img') && !!document.querySelector('.slot[data-slot=done] img') && document.querySelector('.view[data-k=petimport] .field input').value === '말랑이'`)))
  await isl.clickSel('[data-imp=save]')
  ok('saved as a second pack', await until(() => h.pets.size === 2 && h.pets.get(String(h.store.get('island.pet')).slice(7))?.files?.done))
  await settings()
  await tab('내 펫')
  await isl.clickSel('.petpick [data-cpet=add]')
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=petimport]')`))
  picked = pickNext([SHEET])
  await isl.clickSel('[data-imp=pick]')
  await picked
  await until(() => isl.eval(`!!document.querySelector('.slot[data-slot=idle] img')`))
  await isl.clickSel('.imp-sheet .sw')
  ok('sprite sheet toggle → preview animates a strip (steps)', await until(() => isl.eval(`(() => { const i = document.querySelector('.imp-prev .strip img'); return !!i && /steps/.test(getComputedStyle(i).animationTimingFunction) })()`)))
  await isl.clickSel('[data-imp=cancel]')
  await until(() => isl.eval(`!!document.querySelector('.view[data-k=settings]')`))

  /* 7. 이름 바꾸기 · 삭제 · zip */
  await tab('내 펫')
  await sleep(200)
  await isl.eval(`document.querySelector('.ctile button[data-pet-set="custom:${pid}"]').parentElement.querySelector('[aria-label$="편집·이름 바꾸기"]').click()`)
  await until(() => isl.eval(`document.querySelector('.view[data-k=petimport] .field input')?.value === 'mochi'`))
  await isl.eval(`(() => { const i = document.querySelector('.view[data-k=petimport] .field input'); i.select() })()`)
  await isl.clickSel('.view[data-k=petimport] .field input')
  await isl.eval(`(() => { const i = document.querySelector('.view[data-k=petimport] .field input'); i.setSelectionRange(0, i.value.length) })()`)
  await isl.type('모찌')
  await isl.clickSel('[data-imp=save]')
  ok('rename (edit) keeps the id', await until(() => h.pets.get(pid)?.name === '모찌' && h.pets.size === 2))
  await settings()
  await tab('내 펫')
  await sleep(200)
  h.handlers.pet_export = (p, a) => `C:\\Users\\me\\Downloads\\${h.pets.get(a.id).name}.herapet.zip`
  await isl.eval(`document.querySelector('.ctile button[data-pet-set="custom:${pid}"]').parentElement.querySelector('[aria-label$="내보내기"]').click()`)
  ok('export → pet_export + toast with the path', await until(() => h.calls.some((c) => c[1] === 'pet_export' && c[2].id === pid) && isl.eval(`/모찌\\.herapet\\.zip/.test(document.querySelector('.vtoast')?.textContent ?? '')`)))
  h.handlers.pet_import = (p, a, raw) => ((h.pets.set('zipid1', { ...h.pets.get(pid), id: 'zipid1', name: '펭펭' })), raw ? 'zipid1' : (() => { throw new Error('no bytes') })())
  picked = pickNext([ZIP])
  await isl.eval(`[...document.querySelectorAll('.petpick .cadd')].find((b) => /zip/.test(b.textContent)).click()`)
  await picked
  ok('.herapet.zip import → pet_import (raw bytes) → selected', await until(() => h.store.get('island.pet') === 'custom:zipid1'))
  await isl.eval(`window.__TAURI_INTERNALS__.invoke('plugin:store|set', { rid: 1, key: 'island.pet', value: 'custom:${pid}' })`)
  await sleep(300)
  await isl.eval(`document.querySelector('[data-cpet-del="${pid}"]').click()`)
  ok('delete removes the pack; deleting the selected pet falls back to the default', await until(() => !h.pets.has(pid) && h.store.get('island.pet') === 'cat'))
  ok('no page errors', isl.errors.length === 0, isl.errors.slice(0, 2).join(' | '))
} catch (e) {
  ok('suite ran to the end', false, String(e?.stack ?? e))
} finally {
  await h.close()
  rmSync(dir, { recursive: true, force: true })
}
process.exit(done() ? 1 : 0)
