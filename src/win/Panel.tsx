import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { invoke } from '@tauri-apps/api/core'
import { boardOpen, isTauri, linkSend, onEvent, openCover, openFx, openPath, openSettings, pokeSend, shelfAdd, shelfFolder, talkOpen, useItems, useValue, type ShelfFile } from '../data/api'
import { NOTE_COLORS, enterCommits, freeSlot, nextColor, seedNotes, type Note } from '../surfaces/Notes'
import { FX_LABEL, fetchWeather, geocode, type FxKind, type Weather } from '../surfaces/Fx'
import { Ico } from './icons'
import { linkLook, useLink, useShare } from './link'
import { Sw } from './Settings'
import { UndoToast, deleteWithUndo } from '../surfaces/Undo'
import { colorFor, initial, isDev, peopleConfirm, peopleForget, peopleMyIp, peoplePair, peoplePairIp, sendTo, targets, usePeople } from './people'

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

/* 펫 오른쪽 클릭 = 빠른 톡 (시안 quick): 켜진 친한 친구(⭐)에게 한마디, Enter → 보내고 닫힘. 저장 안 함. ⋯ = 펫 메뉴 */
function QuickTalk({ hide }: { hide: () => void }) {
  const { people, online } = usePeople()
  const [text, setText] = useState('')
  const [more, setMore] = useState(false)
  const inp = useRef<HTMLInputElement>(null)
  const to = people.filter((p) => p.fav && online(p.id))
  useEffect(() => void window.setTimeout(() => inp.current?.focus(), 30), [])
  const send = () => {
    const t = text.trim()
    if (!t || !to.length) return
    void pokeSend(t).catch(() => {})
    setText('')
    hide()
  }
  return (
    <div className="sec qt" data-quick>
      <div className="to">
        {to.slice(0, 5).map((p) => <span key={p.id} className="av" style={{ '--c': colorFor(p.id) } as CSSProperties}>{initial(p.name)}</span>)}
        <span data-quick-to>{to.length ? `친한 친구 ${to.length}명에게` : people.some((p) => p.fav) ? '켜져 있는 친한 친구가 없어요' : '패널 보낼 사람에서 ⭐로 친한 친구를 정해 주세요'}</span>
        <button className="ib" data-quick-more aria-expanded={more} onClick={() => setMore(!more)} title="펫 메뉴" aria-label="펫 메뉴">⋯</button>
      </div>
      <input ref={inp} className="inp" data-quick-in value={text} maxLength={200} disabled={!to.length} placeholder="친한 친구에게 한마디 · Enter" aria-label="빠른 톡"
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && (e.preventDefault(), send())} />
      <small>저장되지 않아요 · 지금 켜진 친구 화면에 잠깐 떠요</small>
      {more && <FxMenu hide={hide} />}
    </div>
  )
}

export function Panel() {
  const [view, setView] = useState<'main' | 'fx' | 'quick'>('main')
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
  const { people, near, pair, online, toggleFav } = usePeople()
  const [unread] = useValue<number>('talk.unread', 0)
  const [myName, setMyName] = useValue('people.name', '')
  const [nameDraft, setNameDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [ip, setIp] = useState('')
  const [ipErr, setIpErr] = useState('')
  const [myIp, setMyIp] = useState<string | null>(null)
  useEffect(() => void (adding && isTauri && peopleMyIp().then(setMyIp, () => {})), [adding])
  const byIp = () => ip.trim() && (setIpErr(''), void peoplePairIp(ip.trim()).then(() => setIp(''), (e) => setIpErr(String(e))))
  const [overP, setOverP] = useState<string | null>(null)
  const tg = targets(link.devs, people, online)
  const tgNow = useRef(tg)
  tgNow.current = tg
  const hide = () => (isTauri ? void invoke('panel_hide') : undefined)

  // 내용 높이 → 창 높이 (바뀔 때만). 패널은 화면 높이까지만 → 안쪽(inner) 높이를 잰다 (넘치면 패널 안에서 스크롤)
  const inner = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!isTauri || !inner.current) return
    let last = 0
    const ro = new ResizeObserver(() => {
      const h = Math.ceil(inner.current!.getBoundingClientRect().height) + 2 // 테두리
      if (h > 2 && h !== last) (last = h), void invoke('panel_fit', { h })
    })
    ro.observe(inner.current)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (!isTauri) return
    const offs = [onEvent<string>('panel-show', (v) => {
        setView(v === 'fx' || v === 'quick' ? v : 'main')
        // 보일 때마다 등장 애니메이션 (요소는 그대로 — 높이 재기가 끊기지 않게)
        const el = box.current
        if (el) el.classList.remove('in'), void el.offsetWidth, el.classList.add('in')
      }), onEvent('panel-hide', () => setOver(false))]
    const key = (e: KeyboardEvent) => e.key === 'Escape' && hide()
    addEventListener('keydown', key)
    // 놓기 = 네이티브 드롭 (경로가 필요): 사람 위면 그 사람에게, 아니면 선반
    const who = (x: number, y: number) => {
      const id = document.elementFromPoint(x / devicePixelRatio, y / devicePixelRatio)?.closest<HTMLElement>('[data-person]')?.dataset.person
      return id && tgNow.current.some((t) => t.id === id && t.on) ? id : null
    }
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload
      if (p.type === 'enter' || p.type === 'over') return setOver(true), setOverP(who(p.position.x, p.position.y))
      setOver(false), setOverP(null)
      if (p.type !== 'drop' || !p.paths.length) return
      const id = who(p.position.x, p.position.y)
      if (id) sendTo(id, p.paths)
      else void shelfAdd(p.paths)
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
      <div ref={inner}>
      {view === 'quick' ? <QuickTalk hide={hide} /> : view === 'fx' ? <FxMenu hide={hide} /> : <>
      {/* 연결(마우스·키보드 · 클립보드 · 물결)은 설정에서 연결을 켠 사람에게만 */}
      {link.on && <div className="sec" data-link>
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
      </div>}

      <div className="sec" data-people>
        {!myName.trim() && (
          <div className="myname" data-myname>
            <span><b>내 이름을 정해 주세요</b>다른 사람 Hera에 보이는 이름이에요</span>
            <input className="inp" value={nameDraft} maxLength={20} placeholder="예: 김준영" aria-label="내 이름" onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && nameDraft.trim() && setMyName(nameDraft.trim())} />
            <button className="btn pri" data-myname-save disabled={!nameDraft.trim()} onClick={() => setMyName(nameDraft.trim())}>저장</button>
          </div>
        )}
        <div className="sh"><b>보낼 사람</b><span className="acts2">
          <button className="talkbtn" data-talk onClick={() => (void talkOpen().catch(() => {}), hide())} title="전체 톡"><Ico k="chat" />톡{unread > 0 && <span className="badge" data-unread>{unread > 99 ? '99+' : unread}</span>}</button>
          <button className="link" data-people-add aria-expanded={adding} onClick={() => setAdding(!adding)}>{adding ? '닫기' : '+ 사람 추가'}</button></span></div>
        {tg.length > 0 ? (
          <div className="ppl">
            {tg.map((t) => (
              <div key={t.id} className={`pp ${t.on ? '' : 'off'} ${t.os ?? ''} ${overP === t.id ? 'over' : ''}`} data-person={t.id} title={t.on ? `파일을 놓으면 ${t.name}${isDev(t.id) ? '(으)로' : '님에게'} 보내요` : `${t.name} · 지금 Hera가 꺼져 있거나 근처에 없어요`}>
                <span className="av" style={{ '--c': colorFor(t.id) } as CSSProperties}>{isDev(t.id) ? <Ico k="laptop" w={1.6} /> : initial(t.name)}</span>
                <span className="nm">{t.name}</span>
                {!isDev(t.id) && <button className="star" data-fav={t.id} aria-pressed={!!people.find((p) => p.id === t.id)?.fav} onClick={() => toggleFav(t.id)} aria-label={`${t.name} 친한 친구`} title="친한 친구 (빠른 톡을 받는 사람)"><Ico k="star" /></button>}
                {!isDev(t.id) && <button className="x" data-people-del={t.id} onClick={() => void peopleForget(t.id)} aria-label={`${t.name} 등록 지우기`} title="등록 지우기"><Ico k="x" /></button>}
              </div>
            ))}
          </div>
        ) : !adding && <p className="ppl-empty">같은 네트워크의 Hera를 추가하면 파일을 바로 보낼 수 있어요</p>}
        {pair && (
          <div className="pair" data-people-code={pair.code}>
            <span className="code">{pair.code}<small>{pair.name} 화면의 숫자와 같나요?</small></span>
            <button className="btn" data-people-pair="no" onClick={() => void peopleConfirm(false)}>아니요</button>
            <button className="btn pri" data-people-pair="ok" onClick={() => (void peopleConfirm(true), setAdding(false))}>같아요</button>
          </div>
        )}
        {adding && !pair && (
          <div className="near" data-near>
            <small>근처의 Hera · 눌러서 등록</small>
            {near.filter((n) => !n.known).map((n) => (
              <button key={n.pk} data-near-pk={n.pk} onClick={() => void peoplePair(n.pk).catch(() => {})}>
                <span className="av" style={{ '--c': colorFor(n.pk) } as CSSProperties}>{initial(n.name)}</span>{n.name}
              </button>
            ))}
            {!near.some((n) => !n.known) && <p className="ppl-empty">근처에 자동으로 보이는 Hera가 없어요 — 아래에 IP로 추가해 보세요</p>}
            <div className="byip">
              <input className="inp" data-ip value={ip} placeholder="IP로 추가 (예: 192.168.0.12)" aria-label="상대 IP 주소" spellCheck={false}
                onChange={(e) => (setIp(e.target.value), setIpErr(''))} onKeyDown={(e) => e.key === 'Enter' && byIp()} />
              <button className="btn" data-ip-go disabled={!ip.trim()} onClick={byIp}>추가</button>
            </div>
            {ipErr && <p className="ppl-err" data-ip-err>{ipErr}</p>}
            <small data-my-ip>{myIp ? `내 IP: ${myIp} — 상대가 이 주소로 추가할 수 있어요` : '내 IP를 찾지 못했어요'}</small>
          </div>
        )}
        {tg.length > 0 && <div className="hint">파일을 사람 위에 놓으면 그 사람 선반으로 · ⭐ 친한 친구 = 펫 빠른 톡을 받는 사람</div>}
      </div>

      <div className="sec">
        <div className="sh"><b>선반<small data-shelf-n>{files.length ? `${files.length}개` : '비어 있음'}</small></b><button className="link" data-shelf-folder title="받은 파일이 쌓이는 폴더 (다운로드\Hera)" onClick={() => (void shelfFolder().catch(() => {}), hide())}>더 보기</button></div>
        <div className={`drop ${over ? 'over' : ''}`} data-drop>파일을 여기에 놓으면 올려 둬요{mac ? ' · 맥으로 보낼 수 있어요' : ''}</div>
        {files.length > 0 && (
          <ul className="files">
            {files.map((f) => {
              const ext = extOf(f.path)
              return (
                <li key={f.id} data-file={f.id}>
                  <span className="fi" style={{ background: colorOf(f.path) }}>{ext.toUpperCase().slice(0, 4) || '파일'}</span>
                  <span className="nm"><b title={f.path}>{nameOf(f.path)}</b><small>{f.from === 'mac' ? '맥에서 받음' : f.from === 'pc' ? '이 PC' : `${f.from}님에게 받음`} · {when(f.at)}{f.sent && <span className="badge">맥에 보냄</span>}</small></span>
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
      </div>
      <UndoToast />
    </section>
  )
}
