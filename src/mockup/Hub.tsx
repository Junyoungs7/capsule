import { useEffect, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from 'react'
import type { AppGroup, Clip, LpRecord, Notification, ShelfFile } from '../data/types'
import { useItems } from '../data/api'
import { seedClips, seedEvents, seedGroups, seedRecords, seedShelf, seedTodos } from '../data/mock'
import { SHELF_MAX } from '../surfaces/Shelf'
import { Island, type LinkView, type TeamNews } from '../surfaces/Island'
import { CalendarFilter, TeamSection } from '../surfaces/Team'
import { Panel, type Tab } from '../surfaces/Panel'
import { AsciiFull, pickScene, seasonOf, SCENES, type SceneId } from '../surfaces/Ascii'
import { ASCII_RECORDS, Disc } from '../surfaces/Lp'
import { newNote, setV3, useV3, V3Layer } from '../surfaces/Notes'
import { MonthCalendar } from '../surfaces/MonthCalendar'
import { useSnippets } from '../surfaces/Snippets'
import { Tile, usePresence } from '../surfaces/Dock'
import { GlassDefs } from '../surfaces/GlassDefs'
import { FX_LABEL, Fx, type FxKind } from '../surfaces/Fx'

/* 허브 시안 (?surface=hub): 독을 없애고 모든 기능을 위쪽 Island 로. Windows 작업 표시줄은 그대로 보인다.
   알약 = 시계 · 다음 일정 · 재생 중 LP. 알약 클릭(또는 마우스 0.3초 머묾) → 허브가 아래로 스프링으로 펼쳐짐. */

type View = 'home' | 'notes' | 'clips' | 'todo' | 'cal' | 'snip' | 'team' | 'link' | 'fx'
type Win = { id: string; rec: LpRecord; x: number; y: number; w: number; h: number; kind: 'browser' | 'app' }

const hm = (t: string | number | Date) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
const fname = (p: string) => p.split(/[\\/]/).pop()!
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : `${Math.floor(m / 60)}시간 전`
}
const pillRect = () => document.querySelector('.island-shape')!.getBoundingClientRect()
const rec = (id: string) => seedRecords.find((r) => r.id === id)!

const QUICK: [View | 'ocr' | 'settings', string, string][] = [
  ['notes', '메모', 'M6 4h9l3 3v13H6zM9 10h6M9 14h6'],
  ['clips', '최근 복사', 'M8 4h8v4H8zM6 6H5v14h14V6h-1M9 13h6M9 16h4'],
  ['todo', '할 일', 'M4 12.5l3 3 6-6M14 7h6M14 12h6M14 17h6'],
  ['cal', '달력', 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4'],
  ['ocr', 'OCR', 'M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M8 10h8M8 14h5'],
  ['snip', '스니펫', 'M8 7l-5 5 5 5M16 7l5 5-5 5'],
  ['team', 'Team', 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 0 1 0 6M18 15c2 .5 3 2.5 3 5'],
  ['link', 'Link', 'M4 6h11v8H4zM8 18h3M17 9h4v10h-4z'],
  ['fx', '화면 효과', 'M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2'],
  ['settings', '설정', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .3-1.5-1.5L17 5l-3-1-1 2h-2L10 4 7 5l.5 2.3L6 8.8 4 8.5l-1 3 2 1v1l-2 1 1 3 2-.3 1.5 1.5L7 19.9l3 1 1-2h2l1 2 3-1-.5-2.3 1.5-1.5 2 .3 1-3-2-1z'],
]
const Ico = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>

const NEWS = [
  { who: '민수', group: 'tg-dev', what: '일정 추가', detail: '금 14:00 · 배포' },
  { who: '서연', group: 'tg-banner', what: '메모 수정', detail: '메인 배너 카피 A/B 안 정리' },
  { who: '지은', group: 'tg-dev', what: '일정 변경', detail: '코드 리뷰 데이 · 내일 10:00 → 11:00' },
]
const TABS0 = ['Hera 시안 리뷰', 'GitHub · tauri', 'Notion · 주간 보고', '배너 관리']

export function HubDesktop() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme)
  const [records] = useItems<LpRecord>('record', seedRecords)
  const [todos, setTodos] = useItems('todo', seedTodos)
  const [events, setEvents] = useItems('event', seedEvents)
  const [groups, setGroups] = useItems<AppGroup>('group', seedGroups)
  const [shelf, setShelf] = useItems<ShelfFile>('shelf', seedShelf)
  const [clips, setClips] = useState<Clip[]>(seedClips)
  const [snippets] = useSnippets()
  useState(() => setV3({ notes: false })) // 시작은 포스트잇 접힘 (허브 '메모'에서 펼치기)
  const { notes: notesShown } = useV3()

  const [clock, setClock] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 15_000)
    return () => clearInterval(t)
  }, [])

  /* ── 가짜 창 (브라우저 + VS Code) · 앞 창 = 앱 메모 기준 ── */
  const [wins, setWins] = useState<Win[]>(() => [
    { id: 'w-chrome', rec: rec('chrome'), x: 28, y: 0, w: 700, h: 520, kind: 'browser' },
    { id: 'w-vscode', rec: rec('vscode'), x: 752, y: 140, w: 400, h: 340, kind: 'app' },
  ])
  // 창 순서(z)는 따로: 배열을 재정렬하면 DOM 이 옮겨져 클릭·애니메이션이 끊긴다
  const [order, setOrder] = useState(['w-chrome', 'w-vscode'])
  const front = wins.find((w) => w.id === order[order.length - 1])
  const toFront = (id: string) => setOrder((o) => (o[o.length - 1] === id ? o : [...o.filter((x) => x !== id), id]))
  const openWin = (r: LpRecord) => {
    const have = wins.find((w) => w.rec.id === r.id)
    if (have) return toFront(have.id)
    const n = wins.length, id = 'w-' + r.id + Date.now()
    setWins((ws) => [...ws, { id, rec: r, x: 300 + (n % 4) * 60, y: 120 + (n % 4) * 40, w: 520, h: 360, kind: r.id === 'chrome' ? 'browser' : 'app' }])
    toFront(id)
  }
  const closeWin = (id: string) => (setWins((ws) => ws.filter((w) => w.id !== id)), setOrder((o) => o.filter((x) => x !== id)))
  const [tabs, setTabs] = useState({ list: TABS0, on: 0, clicks: 0 })

  /* ── 허브 열기/닫기 ── */
  const [hub, setHub] = useState(false)
  const [view, setView] = useState<View>('home')
  const [fs, setFs] = useState(false) // 전체화면 앱 (허브·Island 숨김)
  const dwell = useRef(0)
  const lpRef = useRef('off')
  const dropped = useRef(0) // LP 를 알약에 놓은 시각: 뒤따르는 click·hover 가 허브를 다시 열지 않게
  const close = () => setHub(false)
  const onHover = (on: boolean, type: string) => {
    clearTimeout(dwell.current)
    if (on && type === 'mouse' && lpRef.current === 'off' && Date.now() - dropped.current > 800) dwell.current = window.setTimeout(() => setHub(true), 300)
  }
  useEffect(() => {
    if (!hub) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close()
    const down = (e: PointerEvent) => {
      const t = e.target as Element
      if (!t.closest?.('.hub, .island-shape, .panel, .run-menu, .team-sheet, .group-menu')) close()
    }
    addEventListener('keydown', key)
    addEventListener('pointerdown', down, true)
    return () => (removeEventListener('keydown', key), removeEventListener('pointerdown', down, true))
  }, [hub])
  useEffect(() => void (!hub && setTimeout(() => (setGroupOpen(null), setView('home')), 300)), [hub])

  /* ── Island 한 줄 알림 (실행 중 · 복사됨 …) ── */
  const [flash, setFlash] = useState<{ text: string; rec?: LpRecord; n: number } | null>(null)
  const flashT = useRef(0)
  const say = (text: string, r?: LpRecord, ms = 1500) => {
    setFlash((f) => ({ text, rec: r, n: (f?.n ?? 0) + 1 }))
    clearTimeout(flashT.current)
    flashT.current = window.setTimeout(() => setFlash(null), ms)
  }

  /* (a) 앱 실행: 허브 접힘 → 아이콘이 알약으로 날아감 → '실행 중 · 앱' → 가짜 창 */
  const launch = (r: LpRecord, from: HTMLElement) => {
    const a = from.getBoundingClientRect()
    const p = pillRect()
    close()
    const ghost = document.createElement('div')
    ghost.className = 'hub-ghost'
    ghost.append(from.cloneNode(true))
    Object.assign(ghost.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` })
    document.body.append(ghost)
    const dx = p.left + p.width / 2 - (a.left + a.width / 2), dy = p.top + p.height / 2 - (a.top + a.height / 2)
    ghost.animate(
      [{ transform: 'none', opacity: 1 }, { transform: `translate(${dx * 0.55}px, ${dy * 0.7}px) scale(0.8)`, opacity: 1, offset: 0.6 }, { transform: `translate(${dx}px, ${dy}px) scale(0.3)`, opacity: 0 }],
      { duration: 560, easing: 'cubic-bezier(0.45, 0, 0.2, 1)' },
    ).onfinish = () => ghost.remove()
    const members = r.kind === 'set' ? (r.targets ?? []).map((id) => records.find((x) => x.id === id)).filter((x): x is LpRecord => !!x) : [r]
    setTimeout(() => say(`실행 중 · ${r.title}`, r, 1300), 420)
    members.forEach((m, i) => setTimeout(() => openWin(m), 1250 + i * 180))
  }
  const [groupOpen, setGroupOpen] = useState<string | null>(null)

  /* (c) LP: 끌어서 알약에 놓기(또는 탭) = 재생. 아스키 LP = 전체화면 아스키 */
  const [playing, setPlaying] = useState<LpRecord | null>(null)
  const [lp, setLp] = useState<'off' | 'drag' | 'over'>('off')
  lpRef.current = lp
  const [ascii, setAscii] = useState<{ open: boolean; from: DOMRect | null; scene: SceneId; name: string }>({ open: false, from: null, scene: 'calm', name: '' })
  const play = (r: LpRecord) => {
    close()
    clearTimeout(dwell.current)
    if (r.kind === 'ascii') {
      const scene = !r.scene || r.scene === 'auto' ? pickScene(clock) : r.scene
      return setAscii({ open: true, from: pillRect(), scene, name: `${SCENES[scene].name}${r.scene === 'auto' ? ' · 자동' : ''}` })
    }
    setPlaying(r)
    if (r.kind === 'single') setTimeout(() => openWin(r), 500)
  }
  const lpDown = (r: LpRecord, e: RPointerEvent<HTMLButtonElement>) => {
    const el = e.currentTarget
    const [x0, y0] = [e.clientX, e.clientY]
    let ghost: HTMLElement | null = null
    let over = false
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return
      if (!ghost) {
        ghost = document.createElement('div')
        ghost.className = 'hub-lp-ghost'
        ghost.append(el.querySelector('.lp')!.cloneNode(true))
        document.body.append(ghost)
      }
      ghost.style.transform = `translate(${ev.clientX - 32}px, ${ev.clientY - 32}px)`
      const p = pillRect()
      over = ev.clientX > p.left - 30 && ev.clientX < p.right + 30 && ev.clientY < p.bottom + 24
      setLp(over ? 'over' : 'drag')
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setLp('off')
      if (!ghost) return play(r) // 탭 = 재생 (휴대폰)
      ghost.remove()
      dropped.current = Date.now()
      if (over) play(r)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  /* 선반 · (f) 파일 놓기 */
  const shelve = (paths: string[]) =>
    setShelf((fs) => [...fs.filter((f) => !paths.includes(f.path)), ...paths.map((path, i) => ({ id: crypto.randomUUID(), path, at: Date.now() + i }))].sort((a, b) => a.at - b.at).slice(-SHELF_MAX))
  const [dropDemo, setDropDemo] = useState(false)
  const fakeDrop = () => {
    close()
    setDropDemo(true)
    setTimeout(() => (setDropDemo(false), shelve([`C:\\Users\\me\\Downloads\\견적서_${Math.floor(Math.random() * 90 + 10)}.xlsx`]), say('선반에 담았어요')), 1100)
  }

  /* Hera Link (시안: 연결된 척) — 화면 전환 · 페어링 · 전송 */
  const [swap, setSwap] = useState<LinkView['swap']>(null)
  const [pair, setPair] = useState<LinkView['pair']>(null)
  const [xfer, setXfer] = useState<LinkView['xfer']>(null)
  const linkView: LinkView | null = pair || xfer || swap ? { connected: true, peer: 'MacBook', files: true, swap, pair, xfer } : null
  const toMac = () => (close(), setSwap((s) => ({ onPeer: !s?.onPeer, n: (s?.n ?? 0) + 1 })), setTimeout(() => setSwap(null), 1600))
  const send = (name: string) => {
    close()
    const size = 4_200_000
    let b = 0
    const t = window.setInterval(() => {
      b = Math.min(size, b + size / 12)
      setXfer({ dir: 'out', name, bytes: b, size, done: b >= size })
      if (b >= size) (clearInterval(t), setTimeout(() => setXfer(null), 1400))
    }, 160)
  }

  /* (g) 알림 · 팀 소식 · 한/A */
  const [alerts, setAlerts] = useState<Notification[]>([])
  const pushAlert = (a: Omit<Notification, 'id'>) => setAlerts((q) => [...q, { id: crypto.randomUUID(), ...a }])
  const ack = (done: boolean) => {
    const [kind, id] = alerts[0]?.key?.split(/:(.*)/) ?? []
    if (done && kind === 'todo') setTodos((all) => all.map((t) => (t.id === id ? { ...t, done: true } : t)))
    setAlerts((q) => q.slice(1))
  }
  const [news, setNews] = useState<TeamNews | null>(null)
  useEffect(() => {
    if (!news) return
    const t = setTimeout(() => setNews(null), 4200)
    return () => clearTimeout(t)
  }, [news?.n])
  const [ime, setIme] = useState<{ source: 'ko' | 'en'; n: number } | null>(null)
  const imeT = useRef(0)
  const flipIme = () => (setIme((s) => ({ source: s?.source === 'ko' ? 'en' : 'ko', n: (s?.n ?? 0) + 1 })), clearTimeout(imeT.current), (imeT.current = window.setTimeout(() => setIme(null), 800)))

  /* 화면 효과 · 설정 패널 */
  const [fxOn, setFxOn] = useState(true)
  const [fx, setFx] = useState<{ kind: FxKind; n: number } | null>(null)
  const [panel, setPanel] = useState<{ open: boolean; tab: Tab } | null>(null)
  const quick = (k: View | 'ocr' | 'settings') => {
    if (k === 'ocr') return close(), setV3({ ocr: true })
    if (k === 'settings') return close(), setPanel({ open: true, tab: 'settings' })
    setView((v) => (v === k ? 'home' : k))
  }

  // 다음 일정 (알약)
  const nowIso = clock.toISOString()
  const nextEv = events.filter((e) => e.start > nowIso).sort((a, b) => a.start.localeCompare(b.start))[0]
  const nextLabel = nextEv ? `${new Date(nextEv.start).toDateString() === clock.toDateString() ? hm(nextEv.start) : new Date(nextEv.start).toLocaleDateString('ko-KR', { weekday: 'short' }) + ' ' + hm(nextEv.start)} ${nextEv.title}` : undefined

  const [todoText, setTodoText] = useState('')
  const hubP = usePresence<HTMLDivElement>(hub && !fs)
  const pinnedRecs = records.filter((r) => r.kind !== 'ascii')
  const appRecs = pinnedRecs.filter((r) => r.kind === 'single')
  const fgRec = front?.rec

  return (
    <div className="desktop hub-desk" data-only="all" data-hub data-fs={fs} data-ascii={ascii.open}>
      <GlassDefs />
      <div className="wallpaper" aria-hidden />

      {/* 가짜 창 */}
      {wins.map((w) => (
        <FakeWin key={w.id} w={w} z={3 + order.indexOf(w.id)} front={w === front} onFront={() => toFront(w.id)} onClose={() => closeWin(w.id)}
          onMove={(x, y) => setWins((ws) => ws.map((o) => (o.id === w.id ? { ...o, x, y } : o)))}>
          {w.kind === 'browser' ? (
            <div className="fb">
              <div className="fb-tabs" role="tablist">
                {tabs.list.map((t, j) => (
                  <button key={t + j} role="tab" aria-selected={tabs.on === j} onClick={(e) => (e.stopPropagation(), toFront(w.id), setTabs((s) => ({ ...s, on: j, clicks: s.clicks + 1 })))}>
                    <i />{t}
                  </button>
                ))}
                <button className="fb-plus" aria-label="새 탭" onClick={(e) => (e.stopPropagation(), setTabs((s) => ({ list: [...s.list, '새 탭'], on: s.list.length, clicks: s.clicks + 1 })))}>+</button>
              </div>
              <div className="fb-url"><span>https://example.com/{tabs.list[tabs.on]?.replace(/\s/g, '-').toLowerCase()}</span></div>
              <div className="fb-page">
                <b>{tabs.list[tabs.on]}</b>
                <p>탭 클릭 {tabs.clicks}회 — 알약(가운데 위) 밖은 클릭이 그대로 창으로 가요.</p>
                {Array.from({ length: 9 }, (_, k) => <span key={k} style={{ width: `${40 + ((k * 29) % 50)}%` }} />)}
              </div>
            </div>
          ) : (
            <div className="mock-body">
              {Array.from({ length: 12 }, (_, k) => <span key={k} style={{ width: `${30 + ((k * 37) % 55)}%`, marginLeft: `${(k % 4) * 4}%` }} />)}
            </div>
          )}
        </FakeWin>
      ))}

      <V3Layer records={records} fgId={fgRec?.id} anchor={front ? new DOMRect(front.x, front.y, front.w, front.h) : undefined} />

      {/* 전체화면 앱 (데모): Island·허브 숨김 */}
      {fs && (
        <div className="hub-fs" onClick={() => setFs(false)}>
          <b>전체화면 앱 (영상·게임·발표)</b>
          <small>Island 와 허브는 숨어요 · 알림은 끝난 뒤에 · 누르면 끝내기</small>
        </div>
      )}

      {!fs && (
        <Island
          alert={alerts[0] ?? null}
          next={null}
          playing={null}
          peek={false}
          onDone={() => ack(true)}
          onSnooze={() => ack(false)}
          onOpen={() => Date.now() - dropped.current > 500 && setHub((h) => !h)}
          onDropFiles={(paths) => (shelve(paths), say('선반에 담았어요'))}
          lp={lp}
          news={news}
          ascii={ascii.open ? ascii.name : null}
          onAsciiStop={() => setAscii((a) => ({ ...a, open: false }))}
          link={linkView}
          onSendFiles={(paths) => paths.forEach(send)}
          onPair={() => setPair(null)}
          ime={ime}
          pill={{ clock: hm(clock), next: nextLabel, rec: playing ?? undefined, onStop: () => setPlaying(null) }}
          onHover={onHover}
          flash={flash}
          forceDrop={dropDemo}
        />
      )}

      {/* ── 허브 ── */}
      {hubP.mounted && (
        <div ref={hubP.ref} className="hub" onTransitionEnd={hubP.onTransitionEnd} role="dialog" aria-label="Hera 허브">
          <nav className="hub-quick">
            {QUICK.map(([k, label, d]) => (
              <button key={k} aria-pressed={view === k || (k === 'notes' && notesShown && view === 'home') || (k === 'fx' && fxOn && view === 'home')} data-cur={view === k} onClick={() => quick(k)}>
                <Ico d={d} />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="hub-body" key={view}>
            {view === 'home' && (
              <>
                <section>
                  <h4>앱 <small>누르면 실행 · 묶음은 펼쳐짐</small></h4>
                  <div className="hub-apps">
                    {pinnedRecs.map((r) => (
                      <button key={r.id} className="hub-app" onClick={(e) => launch(r, e.currentTarget.querySelector('.tile') as HTMLElement)}>
                        <Tile rec={r} size={44} />
                        <span>{r.title}</span>
                      </button>
                    ))}
                    {groups.map((g) => (
                      <button key={g.id} className="hub-app" aria-expanded={groupOpen === g.id} onClick={() => setGroupOpen((o) => (o === g.id ? null : g.id))}>
                        <span className="hub-group">
                          {g.recordIds.slice(0, 4).map((id) => records.find((r) => r.id === id)).filter((r): r is LpRecord => !!r).map((r) => <Tile key={r.id} rec={r} size={18} />)}
                        </span>
                        <span>{g.title}</span>
                      </button>
                    ))}
                  </div>
                  {groupOpen && (
                    <div className="hub-pop">
                      <b>{groups.find((g) => g.id === groupOpen)?.title}</b>
                      <div className="hub-apps">
                        {groups.find((g) => g.id === groupOpen)!.recordIds.map((id) => records.find((r) => r.id === id)).filter((r): r is LpRecord => !!r).map((r) => (
                          <button key={r.id} className="hub-app" onClick={(e) => launch(r, e.currentTarget.querySelector('.tile') as HTMLElement)}>
                            <Tile rec={r} size={40} />
                            <span>{r.title}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </section>

                <section className="hub-row2">
                  <div className="hub-shelf" onDragOver={(e: DragEvent) => e.preventDefault()} onDrop={(e: DragEvent) => (e.preventDefault(), shelve([...e.dataTransfer.files].map((f) => f.name)))}>
                    <h4>선반 <small>알약에 놓은 파일 · 우클릭 = 빼기</small></h4>
                    <div className="hub-files">
                      {shelf.length === 0 && <small className="hub-empty">비어 있어요</small>}
                      {shelf.map((f) => (
                        <button key={f.id} className="hub-file" draggable title={`${fname(f.path)}\n끌기: 밖으로 복사 · 우클릭: 빼기`}
                          onClick={() => (close(), say(`열기 · ${fname(f.path)}`))}
                          onContextMenu={(e) => (e.preventDefault(), setShelf((all) => all.filter((x) => x.id !== f.id)))}>
                          <i>{/\.([a-z0-9]{1,4})$/i.exec(f.path)?.[1] ?? '폴더'}</i>
                          <span>{fname(f.path)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="hub-crate">
                    <h4>LP <small>알약으로 끌어 놓기 = 재생 (탭도 돼요)</small></h4>
                    <div className="hub-lps">
                      {[...appRecs.slice(0, 4), ...ASCII_RECORDS.slice(0, 3)].map((r) => (
                        <button key={r.id} className="hub-lp" onPointerDown={(e) => lpDown(r, e)} title={r.title} aria-label={`${r.title} 재생`}>
                          <Disc rec={r} size={52} />
                          <span>{r.kind === 'ascii' ? r.title.replace('아스키 · ', 'ASCII ') : r.title}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </section>
                <p className="hub-legend">실행 중인 앱 · 창 미리보기 · 알림 깜빡임 · 시작 · 트레이는 <b>Windows 작업 표시줄</b>이 맡아요 (독 없음)</p>
              </>
            )}

            {view === 'notes' && (
              <section className="hub-list">
                <h4>메모</h4>
                <button className="hub-item" onClick={() => (close(), setV3({ notes: !notesShown }))}><b>{notesShown ? '포스트잇 숨기기' : '포스트잇 보이기'}</b><small>바탕화면 메모 전체 · Island 로 빨려 들어가요</small></button>
                <button className="hub-item" onClick={() => (close(), setV3({ notes: true }), setTimeout(() => newNote(), 60))}><b>새 메모</b><small>바로 입력할 수 있어요</small></button>
                <button className="hub-item" onClick={() => (close(), setTimeout(() => newNote(fgRec?.id), 60))}><b>앱 메모 · {fgRec?.title ?? '앞 창'}</b><small>지금 앞에 있는 창 옆에 붙어요 · 그 앱이 앞에 올 때만 보여요</small></button>
              </section>
            )}

            {view === 'clips' && (
              <section className="hub-list">
                <h4>최근 복사 <small>메모리에만 · 누르면 다시 복사</small></h4>
                {clips.map((c) => (
                  <button key={c.id} className="hub-item" onClick={() => (void navigator.clipboard?.writeText(c.text).catch(() => {}), setClips((cs) => [{ ...c, at: Date.now() }, ...cs.filter((x) => x.id !== c.id)]), close(), say('복사됨'))}>
                    <b>{c.text}</b><small>{ago(c.at)}</small>
                  </button>
                ))}
              </section>
            )}

            {view === 'todo' && (
              <section className="hub-list">
                <h4>할 일</h4>
                <form className="hub-add" onSubmit={(e) => (e.preventDefault(), todoText.trim() && (setTodos((all) => [{ id: crypto.randomUUID(), title: todoText.trim(), done: false, source: 'local' }, ...all]), setTodoText('')))}>
                  <input value={todoText} onChange={(e) => setTodoText(e.target.value)} placeholder="할 일 추가…" />
                  <button className="primary">추가</button>
                </form>
                {todos.map((t) => (
                  <label key={t.id} className="hub-todo" data-done={t.done}>
                    <input type="checkbox" checked={t.done} onChange={() => setTodos((all) => all.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))} />
                    <span>{t.title}</span>
                    {t.due && <small>{new Date(t.due).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })} {hm(t.due)}</small>}
                  </label>
                ))}
              </section>
            )}

            {view === 'cal' && (
              <section className="hub-cal">
                <div className="hub-cal-head"><h4>달력 <small>공휴일 · 그룹 색 · 날짜 누르면 일정</small></h4><CalendarFilter /></div>
                <MonthCalendar events={events} setEvents={setEvents} todos={todos} onAdded={() => say('일정 추가됨')} />
              </section>
            )}

            {view === 'snip' && (
              <section className="hub-list">
                <h4>스니펫 <small>누르면 앞 창에 붙여넣기</small></h4>
                {snippets.map((s) => (
                  <button key={s.id} className="hub-item" onClick={() => (close(), say(`붙여넣음 · ${s.title}`))}><b>{s.title}</b><small>{s.body.split('\n')[0]}</small></button>
                ))}
                <button className="hub-item ghost" onClick={() => (close(), setPanel({ open: true, tab: 'snippets' }))}><b>스니펫 편집…</b></button>
              </section>
            )}

            {view === 'team' && (
              <section className="hub-team"><TeamSection /></section>
            )}

            {view === 'link' && (
              <section className="hub-list">
                <h4>Hera Link <small>MacBook · 연결됨 (시안)</small></h4>
                <button className="hub-item" onClick={toMac}><b>{swap?.onPeer ? '← Windows 로 돌아오기' : 'Mac 화면으로 →'}</b><small>마우스·키보드를 Mac 으로 넘겨요</small></button>
                {shelf.map((f) => (
                  <button key={f.id} className="hub-item" onClick={() => send(fname(f.path))}><b>맥으로 보내기 · {fname(f.path)}</b><small>선반 파일</small></button>
                ))}
                <button className="hub-item ghost" onClick={() => (close(), setPair({ code: '482913', name: 'MacBook' }))}><b>새 기기 페어링…</b></button>
              </section>
            )}

            {view === 'fx' && (
              <section className="hub-list">
                <h4>화면 효과 <small>날씨 · 계절 · 시간대 이벤트</small></h4>
                <label className="hub-switch"><span>자동 효과</span><input type="checkbox" role="switch" checked={fxOn} onChange={(e) => setFxOn(e.target.checked)} /></label>
                <div className="hub-chips">
                  {(Object.keys(FX_LABEL) as FxKind[]).map((k) => (
                    <button key={k} onClick={() => (close(), setFx((f) => ({ kind: k, n: (f?.n ?? 0) + 1 })))}>{FX_LABEL[k]}</button>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      )}

      {/* 데모 컨트롤 */}
      <aside className="hub-demo glass-card" aria-label="데모 컨트롤">
        <header><b>Island 허브</b><small>독 없음 시안</small></header>
        <p>가운데 위 알약을 누르세요 (마우스는 0.3초 올려 두기).</p>
        <div className="demo-btns">
          <button onClick={() => setNews((n) => ({ ...NEWS[(n?.n ?? 0) % NEWS.length], n: (n?.n ?? 0) + 1 }))}>팀 소식</button>
          <button onClick={() => pushAlert({ title: '디자인 리뷰 10분 전', body: '회의실 B · 16:00', key: 'event:e1' })}>일정 알림</button>
          <button onClick={() => { const t = todos.find((x) => !x.done); if (t) pushAlert({ title: t.title, body: '마감 시각이 되었어요', key: `todo:${t.id}` }) }}>할 일 알림</button>
          <button onClick={() => pushAlert({ title: '배포', body: '금 14:00 시작 · 민수님이 추가한 일정', key: 'event:t1', group: 'tg-dev' })}>팀 일정 알림</button>
          <button onClick={fakeDrop}>파일 놓기</button>
          <button onClick={flipIme}>한/A</button>
          <button onClick={() => setPair((p) => (p ? null : { code: '482913', name: 'MacBook' }))}>페어링</button>
          <button aria-pressed={fs} onClick={() => (close(), setFs((v) => !v))}>전체화면 앱</button>
          <button onClick={() => { const t = theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; setTheme(t) }}>{theme === 'dark' ? '라이트' : '다크'}</button>
          <button onClick={() => { localStorage.clear(); location.reload() }}>처음부터</button>
        </div>
      </aside>

      <Taskbar wins={wins} front={front?.id} onPick={toFront} clock={clock} />

      {panel && (
        <Panel
          open={panel.open} tab={panel.tab} onTab={(tab) => setPanel({ open: true, tab })}
          onClose={() => setPanel((p) => p && { ...p, open: false })} onClosed={() => setPanel(null)} onAdded={() => {}}
          todos={todos} setTodos={setTodos} events={events} setEvents={setEvents}
          records={records} pinned={records.map((r) => r.id)} onAddRecord={() => {}} onRemoveRecord={() => {}} onTogglePin={() => {}} onAddSet={() => {}}
          groups={groups} onSaveGroup={(g) => setGroups((gs) => (gs.some((x) => x.id === g.id) ? gs.map((x) => (x.id === g.id ? g : x)) : [...gs, g]))} onRemoveGroup={(id) => setGroups((gs) => gs.filter((g) => g.id !== id))}
          fxOn={fxOn} setFxOn={setFxOn} city="서울" setCity={() => {}} weather={null} idleMin={10} setIdleMin={() => {}}
          onFxNow={() => setFx((f) => ({ kind: 'snow', n: (f?.n ?? 0) + 1 }))}
        />
      )}
      <AsciiFull open={ascii.open} id={ascii.scene} from={ascii.from} saver={false}
        caption={`${clock.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} · ${seasonOf(clock)}`}
        onClose={() => setAscii((a) => ({ ...a, open: false }))} />
      {fx && <Fx key={fx.n} kind={fx.kind} onDone={() => setFx(null)} />}
    </div>
  )
}

/** 가짜 앱 창: 제목줄 끌기 · 누르면 앞으로 · 열릴 때 알약 쪽에서 스프링 */
function FakeWin({ w, z, front, onFront, onClose, onMove, children }: { w: Win; z: number; front: boolean; onFront: () => void; onClose: () => void; onMove: (x: number, y: number) => void; children: React.ReactNode }) {
  const drag = (e: RPointerEvent<HTMLElement>) => {
    if ((e.target as Element).closest('button')) return
    const [x0, y0, wx, wy] = [e.clientX, e.clientY, w.x, w.y]
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const mv = (ev: PointerEvent) => onMove(Math.max(-w.w + 80, wx + ev.clientX - x0), Math.max(0, wy + ev.clientY - y0))
    const up = () => (el.removeEventListener('pointermove', mv), el.removeEventListener('pointerup', up))
    el.addEventListener('pointermove', mv)
    el.addEventListener('pointerup', up)
  }
  return (
    <div className="fake-win" data-front={front} data-kind={w.kind} style={{ left: w.x, top: w.y, width: w.w, height: w.h, zIndex: z, transformOrigin: `${720 - w.x}px ${-w.y}px` }} onPointerDown={onFront}>
      {w.kind === 'app' && (
        <header onPointerDown={drag}>
          <Tile rec={w.rec} size={16} />
          <b>{w.rec.title}</b>
          <span className="mock-ctl"><i /><i /><i onClick={onClose} /></span>
        </header>
      )}
      {children}
    </div>
  )
}

/** Windows 11 작업 표시줄 (그대로 보임): 실행 중인 창 아이콘 = 여기서 관리 */
function Taskbar({ wins, front, onPick, clock }: { wins: Win[]; front?: string; onPick: (id: string) => void; clock: Date }) {
  return (
    <div className="taskbar hub-tb">
      <span className="tb-apps">
        <i className="tb-start" />
        <i className="tb-search" />
        {wins.map((w) => (
          <button key={w.id} className="tb-win" data-front={w.id === front} onClick={() => onPick(w.id)} aria-label={w.rec.title}>
            <Tile rec={w.rec} size={22} />
          </button>
        ))}
      </span>
      <span className="tb-tray">
        <span>{hm(clock)}</span>
        <span>{clock.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })}</span>
      </span>
    </div>
  )
}
