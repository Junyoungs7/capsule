import { useEffect, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import type { Clip, LpRecord, Notification, ShelfFile } from '../data/types'
import { useItems } from '../data/api'
import { seedClips, seedEvents, seedRecords, seedShelf, seedTodos } from '../data/mock'
import { SHELF_MAX } from '../surfaces/Shelf'
import { Island, type LinkView, type TeamNews } from '../surfaces/Island'
import { CalendarFilter, groupOf, TeamSection } from '../surfaces/Team'
import { Panel, type Tab } from '../surfaces/Panel'
import { Palette } from '../surfaces/Palette'
import { AsciiFull, pickScene, seasonOf, SCENES, type SceneId } from '../surfaces/Ascii'
import { ASCII_RECORDS } from '../surfaces/Lp'
import { newNote, setV3, useV3, V3Layer } from '../surfaces/Notes'
import { MonthCalendar } from '../surfaces/MonthCalendar'
import { useSnippets } from '../surfaces/Snippets'
import { Tile, usePresence } from '../surfaces/Dock'
import { GlassDefs } from '../surfaces/GlassDefs'
import { FX_LABEL, Fx, type FxKind } from '../surfaces/Fx'
import { ChatView, TermView, useChat, useTerm, type Msg } from './HubExtras'

/* 허브 시안 v2 (?surface=hub): 독 없음 · LP 없음 · 앱 격자 없음. 맨 위 가운데 얇은 노치(120×6) 하나.
   노치 = 글자 없음, 점만(읽지 않음·실행 중·선반). 알림·머묾(0.3초)·탭 때만 알약으로 커지고, 허브는 타일 6개짜리 작은 판.
   앱 실행·고정 = Windows 작업 표시줄·시작·Ctrl K 팔레트. */

type View = 'home' | 'notes' | 'plan' | 'chat' | 'term' | 'clips' | 'more' | 'snip' | 'team' | 'link' | 'fx' | 'shelf'
type Win = { id: string; rec: LpRecord; x: number; y: number; w: number; h: number; kind: 'browser' | 'app' | 'ara'; cwd?: string; cmd?: string }

const hm = (t: string | number | Date) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
const fname = (p: string) => p.split(/[\\/]/).pop()!
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : `${Math.floor(m / 60)}시간 전`
}
const shapeRect = () => document.querySelector('.island-shape')!.getBoundingClientRect()
const rec = (id: string) => seedRecords.find((r) => r.id === id)!
const RESERVE = 28 // 상단 공간 확보(AppBar) 높이

const Ico = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
const I = {
  notes: 'M6 4h9l3 3v13H6zM9 10h6M9 14h6',
  plan: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4M8 14l2 2 4-4',
  chat: 'M4 5h16v11H9l-5 4zM8 10h8M8 13h5',
  term: 'M4 5h16v14H4zM7 10l3 2-3 2M12 15h5',
  clips: 'M8 4h8v4H8zM6 6H5v14h14V6h-1M9 13h6M9 16h4',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  back: 'M15 5l-7 7 7 7',
}
const NEWS = [
  { who: '민수', group: 'tg-dev', what: '일정 추가', detail: '금 14:00 · 배포' },
  { who: '서연', group: 'tg-banner', what: '메모 수정', detail: '메인 배너 카피 A/B 안 정리' },
  { who: '지은', group: 'tg-dev', what: '일정 변경', detail: '코드 리뷰 데이 · 내일 10:00 → 11:00' },
]
const TABS0 = ['Hera 시안 리뷰', 'GitHub · tauri', 'Notion · 주간 보고', '배너 관리', 'Gmail', '사내 위키']
const PARENT: Partial<Record<View, View>> = { snip: 'more', team: 'more', link: 'more', fx: 'more' }
const TITLE: Record<View, string> = { home: '', notes: '메모', plan: '할 일 · 달력', chat: '채팅', term: '터미널', clips: '최근 복사', more: '더 보기', snip: '스니펫', team: 'Team', link: 'Hera Link', fx: '화면 효과', shelf: '선반' }

export function HubDesktop() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme)
  const [records] = useItems<LpRecord>('record', seedRecords)
  const [todos, setTodos] = useItems('todo', seedTodos)
  const [events, setEvents] = useItems('event', seedEvents)
  const [shelf, setShelf] = useItems<ShelfFile>('shelf', seedShelf)
  const [clips, setClips] = useState<Clip[]>(seedClips)
  const [snippets] = useSnippets()
  useState(() => setV3({ notes: false })) // 시작은 포스트잇 접힘
  const { notes: notesShown } = useV3()
  const [reserve, setReserve] = useState(false) // 상단 공간 확보 (맥 메뉴막대처럼) — 기본 끔
  const top = reserve ? RESERVE : 0

  const [clock, setClock] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 15_000)
    return () => clearInterval(t)
  }, [])

  /* ── 가짜 창: 탭이 맨 위에 붙은 브라우저(노치 바로 아래까지) + VS Code ── */
  const [wins, setWins] = useState<Win[]>(() => [
    { id: 'w-chrome', rec: rec('chrome'), x: 100, y: 0, w: 1000, h: 540, kind: 'browser' },
    { id: 'w-vscode', rec: rec('vscode'), x: 760, y: 230, w: 420, h: 330, kind: 'app' },
  ])
  const [order, setOrder] = useState(['w-chrome', 'w-vscode'])
  const front = wins.find((w) => w.id === order[order.length - 1])
  const toFront = (id: string) => setOrder((o) => (o[o.length - 1] === id ? o : [...o.filter((x) => x !== id), id]))
  const openWin = (r: LpRecord, extra?: Partial<Win>) => {
    const have = !extra && wins.find((w) => w.rec.id === r.id)
    if (have) return toFront(have.id)
    const n = wins.length, id = 'w-' + r.id + Date.now()
    setWins((ws) => [...ws, { id, rec: r, x: 300 + (n % 4) * 60, y: 140 + (n % 4) * 36, w: 520, h: 340, kind: 'app', ...extra }])
    toFront(id)
  }
  const closeWin = (id: string) => (setWins((ws) => ws.filter((w) => w.id !== id)), setOrder((o) => o.filter((x) => x !== id)))
  const [tabs, setTabs] = useState({ list: TABS0, on: 0, clicks: 0 })

  /* ── 허브: 노치 탭/0.3초 머묾 → 알약 + 허브 ── */
  const [hub, setHub] = useState(false)
  const [view, setView] = useState<View>('home')
  const [dir, setDir] = useState(1) // 화면 넘김 방향 (들어가기 1, 뒤로 -1)
  const go = (v: View) => (setDir(v === 'home' || PARENT[view] === v ? -1 : 1), setView(v))
  const [fs, setFs] = useState(false)
  const dwell = useRef(0)
  const close = () => setHub(false)
  const onHover = (on: boolean, type: string) => {
    clearTimeout(dwell.current)
    if (on && type === 'mouse') dwell.current = window.setTimeout(() => setHub(true), 300)
  }
  useEffect(() => {
    if (!hub) return void setTimeout(() => setView('home'), 300)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close()
    const down = (e: PointerEvent) => !(e.target as Element).closest?.('.hub, .island-shape, .panel, .gp-menu, .chat-big, .team-sheet') && close()
    addEventListener('keydown', key)
    addEventListener('pointerdown', down, true)
    return () => (removeEventListener('keydown', key), removeEventListener('pointerdown', down, true))
  }, [hub])

  /* ── Island 한 줄 알림 ── */
  const [flash, setFlash] = useState<{ text: string; n: number; icon?: 'ok' | 'fail' | 'spin' } | null>(null)
  const flashT = useRef(0)
  const say = (text: string, ms = 1500, icon?: 'ok' | 'fail' | 'spin') => {
    setFlash((f) => ({ text, n: (f?.n ?? 0) + 1, icon }))
    clearTimeout(flashT.current)
    flashT.current = window.setTimeout(() => setFlash(null), ms)
  }

  /* ── 선반: 파일을 끄는 동안에만 노치가 드롭존으로 ── */
  const shelve = (paths: string[]) =>
    setShelf((fs) => [...fs.filter((f) => !paths.includes(f.path)), ...paths.map((path, i) => ({ id: crypto.randomUUID(), path, at: Date.now() + i }))].sort((a, b) => a.at - b.at).slice(-SHELF_MAX))
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    const on = (e: globalThis.DragEvent) => e.dataTransfer?.types.includes('Files') && setDragging(true)
    const off = (e: globalThis.DragEvent) => (e.type !== 'dragleave' || !e.relatedTarget) && setDragging(false)
    addEventListener('dragenter', on)
    addEventListener('dragleave', off)
    addEventListener('drop', off)
    addEventListener('dragend', off)
    return () => (removeEventListener('dragenter', on), removeEventListener('dragleave', off), removeEventListener('drop', off), removeEventListener('dragend', off))
  }, [])
  const [dropDemo, setDropDemo] = useState(false)
  const fakeDrop = () => {
    close()
    setDropDemo(true)
    setTimeout(() => (setDropDemo(false), shelve([`C:\\Users\\me\\Downloads\\견적서_${Math.floor(Math.random() * 90 + 10)}.xlsx`]), say('선반에 담았어요')), 1100)
  }
  const openShelf = () => (setHub(true), setDir(1), setView('shelf'))

  /* ── Hera Link (시안: 연결된 척) ── */
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

  /* ── 알림 · 팀 소식 · 한/A ── */
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

  /* ── 화면 효과 · 아스키 장면 · 설정 패널 · Ctrl K ── */
  const [fxOn, setFxOn] = useState(true)
  const [fx, setFx] = useState<{ kind: FxKind; n: number } | null>(null)
  const [ascii, setAscii] = useState<{ open: boolean; from: DOMRect | null; scene: SceneId; name: string }>({ open: false, from: null, scene: 'calm', name: '' })
  const playScene = (r: LpRecord) => {
    close()
    const scene = !r.scene || r.scene === 'auto' ? pickScene(clock) : r.scene
    setAscii({ open: true, from: shapeRect(), scene, name: `${SCENES[scene].name}${r.scene === 'auto' ? ' · 자동' : ''}` })
  }
  const [panel, setPanel] = useState<{ open: boolean; tab: Tab } | null>(null)
  const [palette, setPalette] = useState(false)
  useEffect(() => {
    const k = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && (e.preventDefault(), close(), setPalette((p) => !p))
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [])

  /* ── 팀 채팅 ── */
  const chat = useChat()
  const [msg, setMsg] = useState<{ who: string; group: string; color: string; text: string; n: number; gid: string } | null>(null)
  const msgT = useRef(0)
  const hideMsg = () => {
    clearTimeout(msgT.current)
    msgT.current = window.setTimeout(() => (document.activeElement?.closest('.hubmsg') ? hideMsg() : setMsg(null)), 7000) // 답장 입력 중이면 기다림
  }
  const receive = () => {
    const m = chat.receive()
    if (hub && view === 'chat' && chat.group === m.group) return
    const g = groupOf(m.group)
    chat.setUnread((u) => u + 1)
    setMsg((x) => ({ who: m.who, group: g?.name ?? '', color: g?.color ?? '#64748b', gid: m.group, text: m.kind === 'text' ? m.text! : m.kind === 'image' ? `사진 · ${m.name}` : `파일 · ${m.name}`, n: (x?.n ?? 0) + 1 }))
    hideMsg()
  }
  const label = (m: Msg) => m.name ?? (m.text ?? '').slice(0, 24)
  const chatAct = {
    copy: (m: Msg) => (m.kind === 'text' && void navigator.clipboard?.writeText(m.text!).catch(() => {}), close(), say(m.kind === 'image' ? '사진 복사됨' : '복사됨')),
    open: (m: Msg) => (close(), say(`열기 · ${label(m)}`)),
    shelve: (m: Msg) => (shelve([`C:\\Users\\me\\Downloads\\${m.name}`]), close(), say('선반에 담았어요')),
    note: (m: Msg) => (close(), setV3({ notes: true }), setTimeout(() => newNote(undefined, m.text, m.group, m.who), 60), say('그룹 메모로 만들었어요')),
    event: (m: Msg, when: Date) => (
      setEvents((all) => [...all, { id: crypto.randomUUID(), title: (m.text ?? '').replace(/(오늘|내일|모레|[일월화수목금토]요일)?\s*(오전|오후)?\s*\d{1,2}시\s*(\d{1,2}분|반)?/, '').split(/[?.!]/)[0].trim().slice(0, 30) || '회의', start: when.toISOString(), end: new Date(when.getTime() + 3_600_000).toISOString(), source: 'local' as const, group: m.group, by: m.who }]),
      close(), say(`일정 추가 · ${when.toLocaleDateString('ko-KR', { weekday: 'short' })} ${hm(when)}`)
    ),
  }
  const chatDrop = (e: DragEvent, where: string) => {
    const name = e.dataTransfer.getData('text/x-hera-chat')
    if (!name) return
    e.preventDefault()
    say(`${where}에 복사 · ${name.slice(0, 18)}`)
  }

  /* ── 터미널: 접어도 계속 → 노치 점 / 알약 '실행 중' → 완료·실패 ── */
  const hubRef = useRef({ hub, view })
  hubRef.current = { hub, view }
  const term = useTerm((ok, cmd) => {
    if (hubRef.current.hub && hubRef.current.view === 'term') return
    say(`${ok ? '완료' : '실패'} · ${cmd}`, 2600, ok ? 'ok' : 'fail')
  })
  const toAra = (pane: HTMLElement) => {
    pane.dataset.handoff = 'true'
    const last = term.hist[term.hist.length - 1]
    setTimeout(() => (close(), say('아라로 넘기는 중 → 아라', 1500, 'spin')), 420)
    setTimeout(() => openWin({ id: 'ara', title: 'ARA', target: 'ara', kind: 'single', cover: '#111827', glyph: 'text' }, { x: 380, y: 170, w: 640, h: 360, kind: 'ara', cwd: term.cwd, cmd: last }), 1900)
  }

  // 다음 일정
  const nowIso = clock.toISOString()
  const nextEv = events.filter((e) => e.start > nowIso).sort((a, b) => a.start.localeCompare(b.start))[0]
  const nextLabel = nextEv ? `${new Date(nextEv.start).toDateString() === clock.toDateString() ? hm(nextEv.start) : new Date(nextEv.start).toLocaleDateString('ko-KR', { weekday: 'short' }) + ' ' + hm(nextEv.start)} ${nextEv.title}` : undefined
  const [todoText, setTodoText] = useState('')
  const [planTab, setPlanTab] = useState<'todo' | 'cal'>('todo')
  const hubP = usePresence<HTMLDivElement>(hub && !fs)
  const fgRec = front?.rec
  const open = todos.filter((t) => !t.done).length

  const tiles: [View, string, string, ReactNode, number?][] = [
    ['notes', '메모', I.notes, notesShown ? '펼쳐 둠 · 탭해서 접기' : '접힘 · 새 메모 · 앱 메모'],
    ['plan', '할 일 · 달력', I.plan, nextLabel ?? `할 일 ${open}개`],
    ['chat', '채팅', I.chat, chat.unread ? `읽지 않음 ${chat.unread}` : '새 메시지 없음', chat.unread],
    ['term', '터미널', I.term, term.running ? <span className="tile-run"><i className="hub-spin" />{term.running}</span> : term.cwd],
    ['clips', '최근 복사', I.clips, clips[0]?.text],
    ['more', '더 보기', I.more, '글자 복사 · 스니펫 · Team · Link · 효과 · 설정'],
  ]
  const row = (t: string, sub: string | undefined, onClick: () => void, chev = false) => (
    <button key={t} className="hub-item" onClick={onClick}>
      <span><b>{t}</b>{sub && <small>{sub}</small>}</span>
      {chev && <i className="chev" aria-hidden>›</i>}
    </button>
  )

  return (
    <div className="desktop hub-desk" data-only="all" data-hub data-fs={fs} data-ascii={ascii.open} data-reserve={reserve} style={{ '--reserve': `${top}px` } as React.CSSProperties}>
      <GlassDefs />
      <div className="wallpaper" aria-hidden onDragOver={(e) => e.dataTransfer.types.includes('text/x-hera-chat') && e.preventDefault()} onDrop={(e) => chatDrop(e, '바탕화면')} />
      {reserve && <div className="appbar" aria-hidden />}

      {wins.map((w) => (
        <FakeWin key={w.id} w={{ ...w, y: w.y + top }} z={3 + order.indexOf(w.id)} front={w === front} onFront={() => toFront(w.id)} onClose={() => closeWin(w.id)}
          onMove={(x, y) => setWins((ws) => ws.map((o) => (o.id === w.id ? { ...o, x, y: y - top } : o)))} onChatDrop={(e) => chatDrop(e, w.rec.title)}>
          {w.kind === 'ara' ? (
            <div className="ara">
              <div className="ara-tabs"><span>PowerShell</span><span data-on>Hera에서</span><span className="ara-plus">+</span></div>
              <div className="ara-body">
                <div className="ara-dim">새 셸 · 폴더(+마지막 명령)만 이어짐 · Hera 스크롤 기록은 안 넘어와요</div>
                <div>PS {w.cwd}&gt; <b>{w.cmd ?? ''}</b><i className="ara-caret" /></div>
              </div>
            </div>
          ) : w.kind === 'browser' ? (
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
                <p>탭 클릭 {tabs.clicks}회 — 노치(가운데 맨 위 120×6) 밖은 전부 창으로 가요. 가운데 탭도 눌려요.</p>
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

      <V3Layer records={records} fgId={fgRec?.id} anchor={front ? new DOMRect(front.x, front.y + top, front.w, front.h) : undefined} />

      {fs && (
        <div className="hub-fs" onClick={() => setFs(false)}>
          <b>전체화면 앱 (영상·게임·발표)</b>
          <small>노치·허브 숨김 · 알림은 끝난 뒤에 · 누르면 끝내기</small>
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
          onOpen={() => setHub((h) => !h)}
          onDropFiles={(paths) => (hub && view === 'chat' ? chat.attach(paths.map((name) => ({ name }))) : (shelve(paths), say('선반에 담았어요')))}
          news={news}
          ascii={ascii.open ? ascii.name : null}
          onAsciiStop={() => setAscii((a) => ({ ...a, open: false }))}
          link={linkView}
          onSendFiles={(paths) => paths.forEach(send)}
          onPair={() => setPair(null)}
          ime={ime}
          pill={{ clock: hm(clock), next: nextLabel, notch: !hub, badge: chat.unread, busy: term.running && !(hub && view === 'term') ? '터미널 · 실행 중' : undefined, shelf: shelf.length, onShelf: openShelf }}
          onHover={onHover}
          flash={flash}
          forceDrop={dropDemo || dragging}
          msg={msg}
          onReply={(t) => (chat.send(t, msg?.gid), setMsg(null), chat.setUnread((u) => Math.max(0, u - 1)), say('보냄'))}
          onMsgOpen={() => (msg && chat.setGroup(msg.gid), setMsg(null), chat.setUnread(0), setDir(1), setView('chat'), setHub(true))}
        />
      )}

      {/* ── 허브: 타일 6개 (Control Center 처럼), 누르면 그 자리에서 화면 넘김 ── */}
      {hubP.mounted && (
        <div ref={hubP.ref} className="hub" data-view={view} onTransitionEnd={hubP.onTransitionEnd} role="dialog" aria-label="Hera 허브">
          {view !== 'home' && (
            <header className="hub-nav">
              <button onClick={() => go(PARENT[view] ?? 'home')} aria-label="뒤로"><Ico d={I.back} /></button>
              <b>{TITLE[view]}</b>
            </header>
          )}
          <div className="hub-body" key={view} data-dir={dir}>
            {view === 'home' && (
              <>
                <div className="hub-tiles">
                  {tiles.map(([v, t, d, sub, badge]) => (
                    <button key={v} className="hub-tile" data-v={v} onClick={() => (v === 'chat' && chat.setUnread(0), go(v))}>
                      <span className="tile-ico"><Ico d={d} />{!!badge && <em>{badge}</em>}</span>
                      <b>{t}</b>
                      <small>{sub}</small>
                    </button>
                  ))}
                </div>
                <button className="hub-k" onClick={() => (close(), setPalette(true))}>
                  <span>앱 실행 · 나머지 전부</span><kbd>Ctrl K</kbd>
                </button>
              </>
            )}

            {view === 'notes' && (
              <div className="hub-list">
                {row(notesShown ? '포스트잇 접기' : '포스트잇 펼치기', '바탕화면 메모 전체 · 노치로 빨려 들어가요', () => (close(), setV3({ notes: !notesShown })))}
                {row('새 메모', '바로 입력', () => (close(), setV3({ notes: true }), setTimeout(() => newNote(), 60)))}
                {row(`앱 메모 · ${fgRec?.title ?? '앞 창'}`, '그 창 옆에 붙고, 그 앱이 앞에 올 때만 보여요', () => (close(), setTimeout(() => newNote(fgRec?.id), 60)))}
              </div>
            )}

            {view === 'plan' && (
              <>
                <div className="hub-seg" role="tablist">
                  <button role="tab" aria-selected={planTab === 'todo'} onClick={() => setPlanTab('todo')}>할 일 {open}</button>
                  <button role="tab" aria-selected={planTab === 'cal'} onClick={() => setPlanTab('cal')}>달력</button>
                </div>
                {planTab === 'todo' ? (
                  <div className="hub-list">
                    <form className="hub-add" onSubmit={(e) => (e.preventDefault(), todoText.trim() && (setTodos((all) => [{ id: crypto.randomUUID(), title: todoText.trim(), done: false, source: 'local' }, ...all]), setTodoText('')))}>
                      <input value={todoText} onChange={(e) => setTodoText(e.target.value)} placeholder="할 일 추가…" />
                    </form>
                    {todos.map((t) => (
                      <label key={t.id} className="hub-todo" data-done={t.done}>
                        <input type="checkbox" checked={t.done} onChange={() => setTodos((all) => all.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))} />
                        <span>{t.title}</span>
                        {t.due && <small>{hm(t.due)}</small>}
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="hub-cal">
                    <div className="hub-cal-head"><CalendarFilter /></div>
                    <MonthCalendar events={events} setEvents={setEvents} todos={todos} onAdded={() => say('일정 추가됨')} />
                  </div>
                )}
              </>
            )}

            {view === 'chat' && <ChatView chat={chat} act={chatAct} />}
            {view === 'term' && <TermView term={term} onAra={toAra} />}

            {view === 'clips' && (
              <div className="hub-list">
                {clips.map((c) => (
                  <button key={c.id} className="hub-item" onClick={() => (void navigator.clipboard?.writeText(c.text).catch(() => {}), setClips((cs) => [{ ...c, at: Date.now() }, ...cs.filter((x) => x.id !== c.id)]), close(), say('복사됨'))}>
                    <span><b>{c.text}</b><small>{ago(c.at)} · 메모리에만</small></span>
                  </button>
                ))}
              </div>
            )}

            {view === 'more' && (
              <>
                <div className="hub-list">
                  {row('화면 글자 복사', 'OCR · Ctrl Alt T', () => (close(), setV3({ ocr: true })))}
                  {row('스니펫', `${snippets.length}개 · ;로 바로 쓰기`, () => go('snip'), true)}
                  {row('Team', '공유 그룹 · 달력 · 메모', () => go('team'), true)}
                  {row('Hera Link', 'MacBook · 화면 넘기기 · 파일 보내기', () => go('link'), true)}
                  {row('화면 효과', `${fxOn ? '켬' : '끔'} · 날씨 · 계절 · 아스키 장면`, () => go('fx'), true)}
                  {row('설정', undefined, () => (close(), setPanel({ open: true, tab: 'settings' })), true)}
                </div>
                <label className="hub-switch">
                  <span><b>상단 공간 확보</b><small>맥 메뉴막대처럼 · 기본 끔</small></span>
                  <input type="checkbox" role="switch" checked={reserve} onChange={(e) => setReserve(e.target.checked)} />
                </label>
                <p className="hub-legend">켜면 화면 맨 위 {RESERVE}px 를 Windows AppBar 로 예약해요 → 최대화한 창이 그 아래에서 시작해 노치·알약이 앱을 절대 가리지 않아요. 대신 화면이 {RESERVE}px 줄어요. 끄면(기본) 노치 120×6 만 가리고 나머지는 클릭이 그대로 통과해요.</p>
              </>
            )}

            {view === 'snip' && (
              <div className="hub-list">
                {snippets.map((s) => row(s.title, s.body.split('\n')[0], () => (close(), say(`붙여넣음 · ${s.title}`))))}
                {row('스니펫 편집…', undefined, () => (close(), setPanel({ open: true, tab: 'snippets' })))}
              </div>
            )}

            {view === 'team' && <div className="hub-team"><TeamSection /></div>}

            {view === 'link' && (
              <div className="hub-list">
                {row(swap?.onPeer ? '← Windows 로 돌아오기' : 'Mac 화면으로 →', '마우스·키보드를 넘겨요', toMac)}
                {shelf.map((f) => row(`맥으로 보내기 · ${fname(f.path)}`, '선반 파일', () => send(fname(f.path))))}
                {row('새 기기 페어링…', undefined, () => (close(), setPair({ code: '482913', name: 'MacBook' })))}
              </div>
            )}

            {view === 'fx' && (
              <>
                <label className="hub-switch">
                  <span><b>자동 효과</b><small>날씨 · 계절 · 시간대가 바뀔 때 잠깐</small></span>
                  <input type="checkbox" role="switch" checked={fxOn} onChange={(e) => setFxOn(e.target.checked)} />
                </label>
                <h4>지금 보기</h4>
                <div className="hub-chips">
                  {(Object.keys(FX_LABEL) as FxKind[]).map((k) => (
                    <button key={k} onClick={() => (close(), setFx((f) => ({ kind: k, n: (f?.n ?? 0) + 1 })))}>{FX_LABEL[k]}</button>
                  ))}
                </div>
                <h4>아스키 장면 <small>전체화면 · 클릭이나 Esc 로 닫기</small></h4>
                <div className="hub-list">
                  {ASCII_RECORDS.map((r) => row(r.title.replace('아스키 · ', ''), r.scene === 'auto' ? '계절·시간대에 맞춰' : undefined, () => playScene(r)))}
                </div>
              </>
            )}

            {view === 'shelf' && (
              <div className="hub-list">
                {shelf.length === 0 && <p className="hub-legend">비어 있어요. 파일을 끌면 노치가 놓을 자리로 커져요.</p>}
                {shelf.map((f) => (
                  <button key={f.id} className="hub-item hub-file" draggable title="끌기: 밖으로 복사 · 우클릭: 빼기"
                    onClick={() => (close(), say(`열기 · ${fname(f.path)}`))}
                    onContextMenu={(e) => (e.preventDefault(), setShelf((all) => all.filter((x) => x.id !== f.id)))}>
                    <i>{/\.([a-z0-9]{1,4})$/i.exec(f.path)?.[1] ?? '폴더'}</i>
                    <span><b>{fname(f.path)}</b><small>누르면 열기 · 끌어서 복사 · 우클릭 빼기</small></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 데모 컨트롤 */}
      <aside className="hub-demo glass-card" aria-label="데모 컨트롤">
        <header><b>Island 허브 v2</b><small>노치 · 타일 6개</small></header>
        <p>맨 위 가운데 얇은 노치를 누르세요 (마우스는 0.3초 올려 두기). 휴대폰은 아래 '허브 열기'.</p>
        <div className="demo-btns">
          <button onClick={() => setHub((h) => !h)}>허브 열기</button>
          <button onClick={() => setPalette(true)}>Ctrl K</button>
          <button onClick={receive}>메시지 받기</button>
          <button onClick={() => setNews((n) => ({ ...NEWS[(n?.n ?? 0) % NEWS.length], n: (n?.n ?? 0) + 1 }))}>팀 소식</button>
          <button onClick={() => pushAlert({ title: '디자인 리뷰 10분 전', body: '회의실 B · 16:00', key: 'event:e1' })}>일정 알림</button>
          <button onClick={() => pushAlert({ title: '배포', body: '금 14:00 시작 · 민수님이 추가한 일정', key: 'event:t1', group: 'tg-dev' })}>팀 일정 알림</button>
          <button onClick={fakeDrop}>파일 놓기</button>
          <button onClick={() => send('회의록 최종.pdf')}>맥으로 전송</button>
          <button onClick={flipIme}>한/A</button>
          <button onClick={() => setPair((p) => (p ? null : { code: '482913', name: 'MacBook' }))}>페어링</button>
          <button aria-pressed={reserve} onClick={() => setReserve((v) => !v)}>상단 확보 {reserve ? '켬' : '끔'}</button>
          <button aria-pressed={fs} onClick={() => (close(), setFs((v) => !v))}>전체화면 앱</button>
          <button onClick={() => { const t = theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; setTheme(t) }}>{theme === 'dark' ? '라이트' : '다크'}</button>
          <button onClick={() => { localStorage.clear(); location.reload() }}>처음부터</button>
        </div>
      </aside>

      <Taskbar wins={wins} front={front?.id} onPick={toFront} clock={clock} />

      {palette && (
        <Palette
          records={records.filter((r) => r.kind !== 'ascii')}
          todos={todos}
          apps={[]}
          onRun={(r) => (setPalette(false), say(`실행 중 · ${r.title}`), setTimeout(() => openWin(r), 700))}
          onLaunch={(t) => (setPalette(false), say(`실행 · ${t}`))}
          onOpenTodo={() => (setPalette(false), setHub(true), setDir(1), setView('plan'))}
          onClose={() => setPalette(false)}
          clips={clips}
          onCopy={() => say('복사됨')}
          cmds={[
            { key: 'c-ocr', title: '화면 글자 복사', sub: 'OCR', run: () => (setPalette(false), setV3({ ocr: true })) },
            { key: 'c-mac', title: 'Mac 화면으로', sub: 'Hera Link', run: () => (setPalette(false), toMac()) },
            { key: 'c-snow', title: '화면 효과 · 눈', sub: '화면 효과', run: () => (setPalette(false), setFx((f) => ({ kind: 'snow', n: (f?.n ?? 0) + 1 }))) },
            { key: 'c-xmas', title: '아스키 · 크리스마스', sub: '화면 효과', run: () => (setPalette(false), playScene(ASCII_RECORDS[1])) },
            { key: 'c-set', title: '설정', sub: 'Hera', run: () => (setPalette(false), setPanel({ open: true, tab: 'settings' })) },
          ]}
        />
      )}
      {panel && (
        <Panel
          open={panel.open} tab={panel.tab} onTab={(tab) => setPanel({ open: true, tab })}
          onClose={() => setPanel((p) => p && { ...p, open: false })} onClosed={() => setPanel(null)} onAdded={() => {}}
          todos={todos} setTodos={setTodos} events={events} setEvents={setEvents}
          records={records} pinned={[]} onAddRecord={() => {}} onRemoveRecord={() => {}} onTogglePin={() => {}} onAddSet={() => {}}
          groups={[]} onSaveGroup={() => {}} onRemoveGroup={() => {}}
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

/** 가짜 앱 창: 제목줄 끌기 · 누르면 앞으로 · 열릴 때 노치 쪽에서 스프링 */
function FakeWin({ w, z, front, onFront, onClose, onMove, onChatDrop, children }: { w: Win; z: number; front: boolean; onFront: () => void; onClose: () => void; onMove: (x: number, y: number) => void; onChatDrop: (e: DragEvent) => void; children: ReactNode }) {
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
    <div className="fake-win" data-front={front} data-kind={w.kind} style={{ left: w.x, top: w.y, width: w.w, height: w.h, zIndex: z, transformOrigin: `${720 - w.x}px ${-w.y}px` }} onPointerDown={onFront}
      onDragOver={(e) => e.dataTransfer.types.includes('text/x-hera-chat') && e.preventDefault()} onDrop={onChatDrop}>
      {w.kind !== 'browser' && (
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

/** Windows 11 작업 표시줄 (그대로 보임): 실행 중인 창·고정 앱·시작 = 여기서 */
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
