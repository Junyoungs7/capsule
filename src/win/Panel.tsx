import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { invoke } from '@tauri-apps/api/core'
import { boardOpen, isTauri, linkSend, onEvent, openCover, openFx, openPath, openSettings, shelfAdd, useItems, useValue, type ShelfFile } from '../data/api'
import { NOTE_COLORS, enterCommits, freeSlot, nextColor, seedNotes, type Note } from '../surfaces/Notes'
import { FX_LABEL, fetchWeather, geocode, type FxKind, type Weather } from '../surfaces/Fx'
import { Ico } from './icons'
import { linkLook, useLink, useShare } from './link'
import { Sw } from './Settings'
import { UndoToast, deleteWithUndo } from '../surfaces/Undo'

/* 트레이 패널 (승인 시안 win-tray-v3 의 .panel). 창은 숨긴 채 살아 있다 — 트레이를 누르면 Rust 가 자리를 잡고 보인다.
   한 화면: 연결 · 타일 3개 · 선반 · 메모 · 꾸미기. 내용 높이가 바뀌면 panel_fit 으로 창 높이를 맞춘다 (모서리는 그대로). */
const COL: Record<string, string> = { xlsx: '#107c41', xls: '#107c41', csv: '#107c41', pdf: '#c42b1c', png: '#8764b8', jpg: '#8764b8', jpeg: '#8764b8', gif: '#8764b8', zip: '#986f0b', docx: '#185abd', doc: '#185abd', pptx: '#c43e1c', txt: '#5c5c5c', mp4: '#0078d4', mov: '#0078d4' }
export const extOf = (p: string) => (/\.([a-z0-9]{1,5})$/i.exec(p)?.[1] ?? '').toLowerCase()
export const nameOf = (p: string) => p.split(/[\\/]/).pop() ?? p
export const colorOf = (p: string) => COL[extOf(p)] ?? '#5c5c5c'
const when = (t: number) => {
  const d = new Date(t), now = new Date(), day = 86_400_000
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (d.toDateString() === now.toDateString()) return now.getTime() - t < 60_000 ? '방금' : `오늘 ${hm}`
  if (d.toDateString() === new Date(now.getTime() - day).toDateString()) return '어제'
  return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
}
const seedShelf: ShelfFile[] = [
  { id: 's1', path: 'C:\\Users\\me\\Desktop\\서버정보_20250721.xlsx', at: Date.now() - 90_000_000, from: 'pc' },
  { id: 's2', path: 'C:\\Users\\me\\Downloads\\Hera\\스크린샷 2026-11-18.png', at: Date.now() - 3_600_000, from: 'mac' },
]

/* 펫을 오른쪽 클릭하면 패널이 이 펫 메뉴로 열린다 (시안 pet-menu · people). 하나 누르면 바로 하고 닫힘. */
const FX_ICON: Record<FxKind, string> = { snow: '❄️', rain: '🌧️', leaves: '🍁', dawn: '🌅', sunset: '🌇', moon: '🌙' }
const ASCII: [string, string, string][] = [['xmas', '🎄', '성탄'], ['city', '🏙️', '도시'], ['autumn', '🍂', '가을'], ['calm', '🌊', '고요']]
function FxMenu({ hide }: { hide: () => void }) {
  const [weather] = useValue<Weather | null>('fx.weather', null)
  const [kind, setKind] = useValue('pet.kind', 'cat')
  const go = (f: () => Promise<unknown>) => (void f().catch(() => {}), hide())
  return (
    <div className="sec fxm">
      <h4>펫</h4>
      <div className="chips">
        <button data-pet-img onClick={() => go(() => openSettings('deco'))}><span>🖼️</span>이미지 바꾸기</button>
        {kind === 'custom' && <button data-pet-default onClick={() => (setKind('cat'), hide())}><span>🐱</span>기본 펫으로</button>}
        <button data-pet-home onClick={() => go(() => (isTauri ? invoke('pet_home') : Promise.resolve()))}><span>↘</span>제자리로</button>
      </div>
      <h4>날씨·계절 효과</h4>
      <div className="chips">{(Object.keys(FX_LABEL) as FxKind[]).map((k) => <button key={k} data-fx={k} onClick={() => go(() => openFx(k))}><span>{FX_ICON[k]}</span>{FX_LABEL[k]}</button>)}</div>
      <h4>아스키 화면 · 마우스를 움직이면 사라져요</h4>
      <div className="chips">{ASCII.map(([k, i, t]) => <button key={k} data-cover={k} onClick={() => go(() => openCover(k))}><span>{i}</span>{t}</button>)}</div>
      <div className="fxfoot"><span>{weather ? `지금 날씨: ${weather.text} ${weather.temp}°` : ''}</span><button className="link" data-deco-settings onClick={() => (void openSettings('deco'), hide())}>꾸미기 설정</button></div>
    </div>
  )
}

export function Panel() {
  const [view, setView] = useState<'main' | 'fx'>('main')
  const link = useLink()
  const look = linkLook(link)
  const [getShare, setShare] = useShare()
  const [ripple, setRipple] = useValue('ripple.enabled', true)
  const [locator, setLocator] = useValue('locator.enabled', true)
  const [deco, setDeco] = useValue('deco.enabled', false)
  const [shelf, setShelf] = useItems<ShelfFile>('shelf', seedShelf)
  const [notes, setNotes] = useItems<Note>('note', seedNotes)
  const [memo, setMemo] = useState('')
  const [over, setOver] = useState(false)
  const box = useRef<HTMLElement>(null)
  const mac = !!link.filesPeer
  const hide = () => (isTauri ? void invoke('panel_hide') : undefined)

  // 내용 높이 → 창 높이 (바뀔 때만)
  useLayoutEffect(() => {
    if (!isTauri || !box.current) return
    let last = 0
    const ro = new ResizeObserver(() => {
      const h = Math.ceil(box.current!.getBoundingClientRect().height)
      if (h && h !== last) (last = h), void invoke('panel_fit', { h })
    })
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (!isTauri) return
    const offs = [onEvent<string>('panel-show', (v) => {
        setView(v === 'fx' ? 'fx' : 'main')
        // 보일 때마다 등장 애니메이션 (요소는 그대로 — 높이 재기가 끊기지 않게)
        const el = box.current
        if (el) el.classList.remove('in'), void el.offsetWidth, el.classList.add('in')
      }), onEvent('panel-hide', () => setOver(false))]
    const key = (e: KeyboardEvent) => e.key === 'Escape' && hide()
    addEventListener('keydown', key)
    // 선반 놓기 = 네이티브 드롭 (경로가 필요)
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload
      if (p.type === 'enter' || p.type === 'over') return setOver(true)
      setOver(false)
      if (p.type === 'drop' && p.paths.length) void shelfAdd(p.paths)
    })
    return () => (offs.forEach((f) => f()), removeEventListener('keydown', key), void off.then((f) => f()))
  }, [])
  // 꾸미기가 켜져 있을 때만: 날씨(30분마다) → fx.weather · fx.coords (Rust 가 비·눈 시작에 효과를 띄운다)
  const [city] = useValue('fx.city', '서울')
  const [, setWeather] = useValue<Weather | null>('fx.weather', null)
  const [coords, setCoords] = useValue<[number, number] | null>('fx.coords', null)
  const coordsNow = useRef(coords)
  coordsNow.current = coords
  useEffect(() => {
    if (!isTauri || !deco) return
    let live = true, t = 0
    const tick = () => {
      geocode(city)
        .then((c) => (live && String(c) !== String(coordsNow.current) && setCoords(c), fetchWeather(c)))
        .then((w) => live && setWeather(w), () => {})
      t = window.setTimeout(tick, 30 * 60_000)
    }
    tick()
    return () => ((live = false), clearTimeout(t))
  }, [deco, city])

  const files = [...shelf].sort((a, b) => b.at - a.at)
  const recent = [...notes].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 3)
  const save = () => {
    const t = memo.trim()
    if (!t) return
    setNotes((all) => [...all, { id: crypto.randomUUID(), text: t, color: nextColor(all), ...freeSlot(all), w: 210, h: 140, at: Date.now() }])
    setMemo('')
  }
  const send = (f: ShelfFile) => void linkSend(f.path).then(() => setShelf((all) => all.map((x) => (x.id === f.id ? { ...x, sent: true } : x))), () => {})
  const tiles: [string, 'clip' | 'ripple' | 'cursor', string, boolean, (v: boolean) => void][] = [
    ['clip', 'clip', '클립보드 공유', getShare('clip'), (v) => setShare('clip', v)],
    ['ripple', 'ripple', '넘어갈 때 물결', ripple, setRipple],
    ['locator', 'cursor', '흔들어 커서 찾기', locator, setLocator],
  ]
  return (
    <section className="pn" ref={box} role="dialog" aria-label="Hera">
      {view === 'fx' ? <FxMenu hide={hide} /> : <>
      <div className="sec">
        <div className="peer" data-st={look.st}>
          <span className="dev"><Ico k="laptop" w={1.6} /><i /></span>
          <span className="tx"><b data-peer>{look.title}</b><small>{look.sub}</small></span>
          <Sw on={link.on} set={link.setOn} label="연결" />
        </div>
        {link.pair && (
          <div className="pair" data-code={link.pair.code}>
            <span className="code">{link.pair.code.slice(0, 3)} {link.pair.code.slice(3)}<small>{link.pair.name} 화면의 숫자와 같나요?</small></span>
            <button className="btn" data-pair="no" onClick={() => link.onPair(false)}>아니요</button>
            <button className="btn pri" data-pair="ok" onClick={() => link.onPair(true)}>같아요</button>
          </div>
        )}
        <div className="tiles">
          {tiles.map(([k, ic, l, on, set]) => (
            <button key={k} className="tile" data-tile={k} aria-pressed={on} onClick={() => set(!on)}><span className="bt"><Ico k={ic} w={1.6} /></span><small>{l}</small></button>
          ))}
        </div>
      </div>

      <div className="sec">
        <div className="sh"><b>선반</b><small data-shelf-n>{files.length ? `${files.length}개` : '비어 있음'}</small></div>
        <div className={`drop ${over ? 'over' : ''}`} data-drop>파일을 여기에 놓으면 올려 둬요{mac ? ' · 맥으로 보낼 수 있어요' : ''}</div>
        {files.length > 0 && (
          <ul className="files">
            {files.map((f) => {
              const ext = extOf(f.path)
              return (
                <li key={f.id} data-file={f.id}>
                  <span className="fi" style={{ background: colorOf(f.path) }}>{ext.toUpperCase().slice(0, 4) || '파일'}</span>
                  <span className="nm"><b title={f.path}>{nameOf(f.path)}</b><small>{f.from === 'mac' ? '맥에서 받음' : '이 PC'} · {when(f.at)}{f.sent && <span className="badge">맥에 보냄</span>}</small></span>
                  <span className="acts">
                    <button className="ib go" data-send={f.id} disabled={!mac} onClick={() => send(f)} aria-label="맥으로 보내기" title={mac ? '맥으로 보내기' : '맥 Hera 연결 필요'}><Ico k="send" /></button>
                    <button className="ib" data-open={f.id} onClick={() => void openPath(f.path).catch(() => {})} aria-label="열기" title="열기"><Ico k="open" /></button>
                    <button className="ib" data-del={f.id} onClick={() => setShelf((all) => all.filter((x) => x.id !== f.id))} aria-label="선반에서 빼기" title="선반에서 빼기"><Ico k="x" /></button>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="sec">
        <div className="sh"><b>메모</b><button className="link" data-board onClick={() => (void boardOpen(), hide())}>모두 보기</button></div>
        <textarea className="inp memo-in" value={memo} rows={1} onChange={(e) => setMemo(e.target.value)} placeholder="메모 쓰고 Enter · 줄바꿈은 Shift+Enter" aria-label="메모"
          style={{ height: Math.min(96, 34 + 20 * (memo.split('\n').length - 1)) }}
          onKeyDown={(e) => enterCommits(e) && (e.preventDefault(), save())} />
        {recent.length > 0 && (
          <ul className="memos">
            {recent.map((n) => <li key={n.id} data-memo={n.id}><i style={{ background: NOTE_COLORS[n.color ?? 0] } as CSSProperties} /><span>{n.text || '(빈 메모)'}</span><small>{n.at ? when(n.at) : ''}</small>
              <button className="ib del" data-memo-del={n.id} onClick={() => deleteWithUndo('메모를 지웠어요', setNotes, n)} aria-label="메모 지우기" title="지우기"><Ico k="x" /></button></li>)}
          </ul>
        )}
      </div>

      <div className="foot">
        <span className="lbl">꾸미기<small>날씨·계절 효과 · 자리 비움 화면 · 펫</small></span>
        <Sw on={deco} set={setDeco} label="꾸미기" />
        <button className="ib" data-settings onClick={() => (void openSettings('general'), hide())} aria-label="설정" title="설정"><Ico k="gear" /></button>
      </div>
      </>}
      <UndoToast />
    </section>
  )
}
