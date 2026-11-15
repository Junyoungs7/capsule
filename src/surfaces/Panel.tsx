import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import type { AppGroup, CalendarEvent, LpRecord, Todo } from '../data/types'
import { isTauri, startApps } from '../data/api'
import { Tile } from './Tile'
import { fmtWhen } from './Island'
import type { Weather } from './Fx'
import { useValue, type LinkCfg, type LinkStatus } from '../data/api'
import { AmbientControls, KeyMapEditor, MonitorCanvas } from './LinkExtras'

/** Hera Link 설정·상태 (Desktop 이 store·Rust 이벤트와 연결) */
export type LinkPanel = {
  on: boolean
  setOn: (v: boolean) => void
  cfg: LinkCfg | null
  setCfg: (c: LinkCfg) => void
  status: LinkStatus | null
  filesPeer: string | null
  pairedName: string | null
  pair: { code: string; name: string } | null
  onPair: (ok: boolean) => void
  onImport: () => Promise<unknown>
  onTrust: (fp: string) => void
  onUnpair: () => void
}
const LINK_DEFAULT: LinkCfg = { me: '', peer: 'MacBook', side: 'right', port: 24800, tls: true, doubleTap: false, filePort: 24810, keymap: 'habit', keyRows: [], ime: 'hera', autoSaverMin: 0, locator: true }
const LINK_STATE: Record<LinkStatus['state'], string> = { off: '꺼짐', starting: '시작하는 중', waiting: '맥 기다리는 중', connected: '연결됨', blocked: '대기 — Deskflow 실행 중', error: '문제 있음' }
import { moonName, moonPhase } from './Ascii'
import { McpSettings } from './Mcp' // AI 연결(MCP)
import { MonthCalendar } from './MonthCalendar'
import { SnippetTab } from './Snippets'
import { TeamSection } from './Team'

export type Tab = 'todo' | 'calendar' | 'library' | 'snippets' | 'settings'
const TABS: [Tab, string][] = [['todo', '할 일'], ['calendar', '달력'], ['library', '라이브러리'], ['snippets', '상용구'], ['settings', '설정']]

type Props = {
  open: boolean
  tab: Tab
  onTab: (t: Tab) => void
  onClose: () => void
  onClosed: () => void
  onAdded: () => void
  todos: Todo[]
  setTodos: Dispatch<SetStateAction<Todo[]>>
  events: CalendarEvent[]
  setEvents: Dispatch<SetStateAction<CalendarEvent[]>>
  records: LpRecord[]
  pinned: string[]
  onAddRecord: (target: string, title?: string) => void
  onRemoveRecord: (id: string) => void
  onTogglePin: (id: string) => void
  onAddSet: (title: string, ids: string[]) => void
  groups: AppGroup[]
  onSaveGroup: (g: AppGroup) => void
  onRemoveGroup: (id: string) => void
  fxOn: boolean
  setFxOn: (on: boolean) => void
  city: string
  setCity: (c: string) => void
  weather: Weather | null // 실제 앱: 받기 전·실패 = null
  idleMin: number
  setIdleMin: (m: number) => void
  onFxNow: () => void
  link?: LinkPanel
  sec?: string // 설정 탭 섹션 (허브 Team/Link → team | link)
}

// 열기: 마운트 → 강제 reflow → data-open=true (transition). 닫기: data-open=false → transitionend → 언마운트(파괴).
export function Panel(p: Props) {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const el = ref.current!
    el.getBoundingClientRect()
    el.dataset.open = String(p.open)
  }, [p.open])
  // 허브 Team · Link: 설정 탭의 그 섹션으로
  useEffect(() => {
    if (p.tab === 'settings' && p.sec) document.getElementById(`sec-${p.sec}`)?.scrollIntoView({ block: 'start' })
  }, [p.tab, p.sec])

  return (
    <section
      ref={ref}
      className="panel glass-card"
      aria-label="Hera 패널"
      onTransitionEnd={(e) => e.target === e.currentTarget && e.propertyName === 'opacity' && !p.open && p.onClosed()}
      onKeyDown={(e) => e.key === 'Escape' && p.onClose()}
    >
      <header className="panel-head">
        <div className="tabs" role="tablist" style={{ '--i': TABS.findIndex(([t]) => t === p.tab) } as CSSProperties}>
          <span className="tab-ind" />
          {TABS.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={p.tab === t} onClick={() => p.onTab(t)}>{label}</button>
          ))}
        </div>
        <button className="icon-btn" onClick={p.onClose} aria-label="패널 닫기">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M7 7l10 10M17 7L7 17" /></svg>
        </button>
      </header>
      <div className="panel-body">
        {p.tab === 'todo' && <TodoTab {...p} />}
        {p.tab === 'calendar' && <MonthCalendar {...p} />}
        {p.tab === 'library' && <LibraryTab {...p} />}
        {p.tab === 'snippets' && <SnippetTab />}
        {p.tab === 'settings' && <SettingsTab {...p} />}
      </div>
    </section>
  )
}

const id = () => crypto.randomUUID()

export function TodoTab({ todos, setTodos, onAdded }: Pick<Props, 'todos' | 'setTodos' | 'onAdded'>) {
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setTodos((t) => [...t, { id: id(), title: title.trim(), due: due ? new Date(due).toISOString() : undefined, done: false, source: 'local' }])
    setTitle('')
    setDue('')
    onAdded()
  }
  const sorted = [...todos].sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? '9').localeCompare(b.due ?? '9'))
  return (
    <>
      <form className="add" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="할 일 추가" aria-label="할 일 제목" />
        <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-label="마감 시각" />
        <button className="primary" aria-label="추가">추가</button>
      </form>
      <ul className="list">
        {sorted.map((t) => (
          <li key={t.id} data-done={t.done}>
            <label className="check">
              <input type="checkbox" checked={t.done} onChange={() => setTodos((all) => all.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))} />
              <span />
            </label>
            <span className="grow">
              <b>{t.title}</b>
              <small>{fmtWhen(t.due)}</small>
            </span>
            <button className="icon-btn del" onClick={() => setTodos((all) => all.filter((x) => x.id !== t.id))} aria-label={`${t.title} 삭제`}>×</button>
          </li>
        ))}
      </ul>
    </>
  )
}

function LibraryTab({ records, pinned, onAddRecord, onRemoveRecord, onTogglePin, onAddSet, groups, onSaveGroup, onRemoveGroup }: Props) {
  const [title, setTitle] = useState('')
  const [target, setTarget] = useState('')
  // C2: 세트 만들기 = 단일 레코드를 고른 순서대로 묶기 (그 순서로 실행)
  // v2: 같은 고르기 화면으로 앱 묶음(독 폴더) 만들기·편집 (group = 편집 중인 묶음)
  const [pick, setPick] = useState<string[] | null>(null)
  const [mode, setMode] = useState<{ kind: 'set' | 'group'; group?: AppGroup }>({ kind: 'set' })
  const [setName, setSetName] = useState('')
  const startPick = (kind: 'set' | 'group', group?: AppGroup) => (setMode({ kind, group }), setSetName(group?.title ?? ''), setPick(group ? [...group.recordIds] : []))
  const makeSet = (e: FormEvent) => {
    e.preventDefault()
    if (!pick || pick.length < 2) return
    if (mode.kind === 'group') onSaveGroup({ id: mode.group?.id ?? id(), title: setName.trim() || '묶음', recordIds: pick })
    else onAddSet(setName.trim() || 'LP 세트', pick)
    setPick(null)
    setSetName('')
  }
  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!target.trim()) return
    onAddRecord(target.trim(), title.trim() || undefined)
    setTitle('')
    setTarget('')
  }
  // B0-4: 패널 = HTML5 드롭 (브라우저 주소창/링크 → text/uri-list). 붙여넣기 폼은 폴백.
  const drop = (e: DragEvent) => {
    e.preventDefault()
    const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).split(/\r?\n/).find((l) => /^https?:\/\//i.test(l))
    if (url) onAddRecord(url.trim())
  }
  return (
    <div onDragOver={(e) => e.preventDefault()} onDrop={drop}>
      <form className="add" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="이름 (선택)" aria-label="레코드 이름" />
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="URL 또는 .exe 경로 (URL 을 끌어다 놓아도 돼요)" aria-label="대상" />
        <button className="primary">추가</button>
      </form>
      {isTauri && !pick && <AppPicker onPick={onAddRecord} />}
      {pick ? (
        <form className="add" onSubmit={makeSet}>
          <input autoFocus value={setName} onChange={(e) => setSetName(e.target.value)} placeholder={`${mode.kind === 'group' ? '묶음' : '세트'} 이름 · ${pick.length}개 선택 (2개 이상)`} aria-label={mode.kind === 'group' ? '묶음 이름' : '세트 이름'} />
          <button type="button" className="picker-open" onClick={() => setPick(null)}>취소</button>
          <button className="primary" disabled={pick.length < 2}>{mode.group ? '저장' : '만들기'}</button>
        </form>
      ) : (
        <div className="lib-actions">
          <button className="picker-open" onClick={() => startPick('set')}>LP 세트 만들기…</button>
          <button className="picker-open" onClick={() => startPick('group')}>앱 묶음 만들기…</button>
        </div>
      )}
      {!pick && groups.length > 0 && (
        <ul className="list groups">
          {groups.map((g) => {
            const recs = g.recordIds.map((x) => records.find((r) => r.id === x)).filter((r): r is LpRecord => !!r)
            return (
              <li key={g.id}>
                <span className="tile folder-tile" style={{ width: 34, height: 34 }} aria-hidden>{recs.slice(0, 4).map((r) => <Tile key={r.id} rec={r} size={13} />)}</span>
                <span className="grow">
                  <b>{g.title}</b>
                  <small>앱 묶음 · {recs.map((r) => r.title).join(' · ')}</small>
                </span>
                <button className="icon-btn" onClick={() => startPick('group', g)} aria-label={`${g.title} 묶음 편집`} title="앱 넣고 빼기">✎</button>
                <button className="icon-btn del" onClick={() => onRemoveGroup(g.id)} aria-label={`${g.title} 묶음 삭제`}>×</button>
              </li>
            )
          })}
        </ul>
      )}
      <ul className="list">
        {[...records].sort((a, b) => a.title.localeCompare(b.title)).filter((r) => !pick || r.kind === 'single').map((r) => (
          <li key={r.id}>
            <Tile rec={r} size={34} />
            <span className="grow">
              <b>{r.title}</b>
              <small>{r.kind === 'set' ? `LP 세트 · ${r.targets?.map((id) => records.find((x) => x.id === id)?.title).filter(Boolean).join(' · ')}` : r.target}</small>
            </span>
            {pick ? (
              <label className="check">
                <input type="checkbox" checked={pick.includes(r.id)} onChange={() => setPick((p) => (p!.includes(r.id) ? p!.filter((x) => x !== r.id) : [...p!, r.id]))} aria-label={`${r.title} ${mode.kind === 'group' ? '묶음' : '세트'}에 넣기`} />
                <span />
              </label>
            ) : (<>
            <button className="icon-btn" onClick={() => onTogglePin(r.id)} aria-pressed={pinned.includes(r.id)} aria-label={`${r.title} 독에 고정`} title="독에 고정">
              {pinned.includes(r.id) ? '★' : '☆'}
            </button>
            <button className="icon-btn del" onClick={() => onRemoveRecord(r.id)} aria-label={`${r.title} 삭제`}>×</button>
            </>)}
          </li>
        ))}
      </ul>
    </div>
  )
}

// v2 설정: 효과 이벤트 스위치(트레이에도 같은 스위치 — Rust), 도시(날씨), 지금 보기, 아스키 화면보호기 대기 시간
function SettingsTab({ fxOn, setFxOn, city, setCity, weather, idleMin, setIdleMin, onFxNow, link }: Props) {
  const [draft, setDraft] = useState(city)
  const f = moonPhase(new Date())
  const save = () => draft.trim() && setCity(draft.trim())
  return (
    <div className="settings">
      <div id="sec-team"><TeamSection /></div>
      <ChatSettings />
      <Reserve />
      <h3>날씨 · 계절 효과</h3>
      <label className="row">
        <span className="grow">
          <b>효과 이벤트</b>
          <small>눈·비 시작, 노을, 달 뜰 때 20~30초 동안</small>
        </span>
        <input type="checkbox" className="switch" checked={fxOn} onChange={(e) => setFxOn(e.target.checked)} />
      </label>
      <form className="row" onSubmit={(e) => (e.preventDefault(), save())}>
        <span className="grow">
          <b>도시</b>
          <small>{city} · {weather ? `${weather.text} ${weather.temp}°` : '날씨 정보 없음'} · 달 {moonName(f)}{isTauri ? '' : ' (시안: 가짜 날씨)'}</small>
        </span>
        <input className="city" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save} aria-label="도시 이름" />
      </form>
      <button className="primary now" onClick={onFxNow}>지금 보기</button>
      {link && <LinkSettings {...link} />}
      <McpSettings /> {/* AI 연결(MCP) — Mcp.tsx */}
      <h3>아스키 아트</h3>
      <label className="row">
        <span className="grow">
          <b>자리 비움 화면보호기</b>
          <small>입력이 없으면 장면을 전체화면으로 · 0 = 끄기</small>
        </span>
        <input className="mins" type="number" min={0} max={120} value={idleMin} onChange={(e) => setIdleMin(Math.max(0, Number(e.target.value) || 0))} aria-label="대기 시간(분)" />
        <small>분</small>
      </label>
    </div>
  )
}

// 시작 메뉴 앱 목록 (Get-StartApps — Rust 가 1회 실행 후 캐시). 검색해서 추가.
function AppPicker({ onPick }: { onPick: (target: string, title: string) => void }) {
  const [apps, setApps] = useState<[string, string][] | null>(null)
  const [q, setQ] = useState('')
  const [failed, setFailed] = useState(false)
  if (!apps)
    return (
      // 실패하면 버튼을 그대로 두고 다시 누르면 재시도
      <button className="picker-open" onClick={() => void startApps().then(setApps, () => setFailed(true))}>
        {failed ? '불러오지 못했어요 — 다시 시도' : '시작 메뉴에서 앱 추가…'}
      </button>
    )
  const hits = apps.filter(([n]) => n.toLowerCase().includes(q.toLowerCase())).slice(0, 30)
  return (
    <div className="picker">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`앱 검색 (${apps.length}개)`} aria-label="앱 검색" />
      <ul className="list">
        {hits.map(([name, target]) => (
          <li key={target}>
            <span className="grow"><b>{name}</b></span>
            <button className="icon-btn" onClick={() => onPick(target, name)} aria-label={`${name} 추가`}>＋</button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Hera Link: 켜기 · 이름 · 맥 위치(이 PC 화면 기준 상하좌우) · 포트 · TLS · Deskflow 설정 가져오기 · 상태/지문/페어링
function LinkSettings({ on, setOn, cfg, setCfg, status, filesPeer, pairedName, pair, onPair, onImport, onTrust, onUnpair }: LinkPanel) {
  const c = { ...LINK_DEFAULT, ...cfg }
  const [locator, setLocator] = useValue('locator.enabled', true)
  const [msg, setMsg] = useState('')
  const put = (patch: Partial<LinkCfg>) => setCfg({ ...c, ...patch })
  const st = status?.state ?? 'off'
  return (
    <>
      <h3 id="sec-link">연결 · Hera Link</h3>
      <label className="row">
        <span className="grow">
          <b>맥과 마우스·키보드·파일 함께 쓰기</b>
          <small>{on ? `${LINK_STATE[st]}${status?.peer && st === 'connected' ? ` · ${status.peer}` : ''}` : '내장 입력 엔진 꺼짐'}</small>
        </span>
        <input type="checkbox" className="switch" checked={on} onChange={(e) => setOn(e.target.checked)} />
      </label>
      {on && status?.detail && <p className="link-note" data-state={st}>{status.detail}</p>}
      {status?.fingerprint && (
        <div className="row">
          <span className="grow">
            <b>새 맥 지문</b>
            <small className="mono">{status.fingerprint.match(/.{1,4}/g)?.slice(0, 8).join(' ')}…</small>
          </span>
          <button className="primary" onClick={() => onTrust(status.fingerprint)}>신뢰</button>
        </div>
      )}
      {pair && (
        <div className="row pair-row">
          <span className="grow">
            <b>{pair.name} 페어링 코드</b>
            <small className="code">{pair.code.slice(0, 3)} {pair.code.slice(3)}</small>
          </span>
          <button onClick={() => onPair(false)}>취소</button>
          <button className="primary" onClick={() => onPair(true)}>같아요</button>
        </div>
      )}
      <div className="row link-layout">
        <span className="grow">
          <b>모니터 배치</b>
          <small>모니터마다 끌어서 어디로 넘어갈지 정해요</small>
        </span>
      </div>
      <MonitorCanvas connected={!!filesPeer} />
      <div className="row link-fields">
        <label>이 PC<input value={c.me} placeholder="이 PC 이름" onChange={(e) => put({ me: e.target.value.trim() })} /></label>
        <label>맥<input value={c.peer} onChange={(e) => put({ peer: e.target.value.trim() })} /></label>
        <label>포트<input className="mins" type="number" value={c.port} onChange={(e) => put({ port: Number(e.target.value) || 24800 })} /></label>
      </div>
      <label className="row">
        <span className="grow">
          <b>TLS 암호화</b>
          <small>{c.doubleTap ? '가장자리 두 번 치기로 넘어감 · ' : ''}끄면 같은 네트워크의 누구나 입력을 볼 수 있어요</small>
        </span>
        <input type="checkbox" className="switch" checked={c.tls} onChange={(e) => put({ tls: e.target.checked })} />
      </label>
      <div className="row">
        <span className="grow">
          <b>파일 채널</b>
          <small>{filesPeer ? `${filesPeer} 연결됨` : pairedName ? `${pairedName} 와 페어링됨 · 연결 대기` : '페어링 전 — 맥 Hera 에서 연결하면 코드가 떠요'}</small>
        </span>
        {pairedName && <button onClick={onUnpair}>페어링 해제</button>}
      </div>
      <h3>키 매핑</h3>
      <KeyMapEditor c={c} put={put} />
      {filesPeer && (
        <>
          <h3>{c.peer} 화면</h3>
          <AmbientControls peer={c.peer || 'Mac'} autoMin={c.autoSaverMin} setAutoMin={(n) => put({ autoSaverMin: n })} />
        </>
      )}
      <label className="row">
        <span className="grow">
          <b>마우스 흔들어 커서 찾기</b>
          <small>빠르게 좌우로 흔들면 커서 둘레에 파란 물결</small>
        </span>
        <input type="checkbox" className="switch" checked={locator} onChange={(e) => setLocator(e.target.checked)} />
      </label>
      <div className="link-actions">
        <button onClick={() => onImport().then(() => setMsg('Deskflow 설정을 가져왔어요 (이름·배치·인증서)'), (e) => setMsg(String(e)))}>Deskflow 설정 가져오기</button>
        {msg && <small>{msg}</small>}
      </div>
    </>
  )
}

/** '상단 공간 확보' (기본 끔): store `appbar.on` → Rust 가 AppBar 로 맨 위 28px 예약/해제 */
function Reserve() {
  const [on, setOn] = useValue('appbar.on', false)
  return (
    <>
      <h3>상단 공간 확보</h3>
      <label className="row">
        <span className="grow">
          <b>맥 메뉴막대처럼 위쪽 28px 비우기</b>
          <small>켜면 최대화한 창이 그 아래에서 시작해 노치·알림이 앱을 가리지 않아요. 대신 화면이 28px 줄어요. 끄면(기본) 노치 120×6 만 가리고 나머지 클릭은 그대로 통과해요.</small>
        </span>
        <input type="checkbox" className="switch" checked={on} onChange={(e) => setOn(e.target.checked)} />
      </label>
    </>
  )
}

/** 팀 채팅 기본값 (제안 — 사용자 확정 전): 보관 기간 · 파일 크기 상한. 전송은 Team 과 같은 사내망 P2P · 같은 암호화 */
function ChatSettings() {
  const [days, setDays] = useValue('chat.retentionDays', 30)
  const [mb, setMb] = useValue('chat.maxMB', 100)
  return (
    <>
      <h3 id="sec-chat">팀 채팅</h3>
      <label className="row">
        <span className="grow"><b>이 PC 에 보관</b><small>지난 메시지는 이 PC 에서만 지워요 (다른 그룹원 기록은 그대로)</small></span>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="채팅 보관 기간">
          {[7, 30, 90, 365].map((d) => <option key={d} value={d}>{d}일</option>)}
        </select>
      </label>
      <label className="row">
        <span className="grow"><b>파일·사진 최대</b><small>보낸 사람 PC 에서 직접 받아요 — 보낸 사람이 오프라인이면 다시 켜질 때까지 못 받아요</small></span>
        <select value={mb} onChange={(e) => setMb(Number(e.target.value))} aria-label="파일 크기 상한">
          {[25, 100, 500].map((m) => <option key={m} value={m}>{m}MB</option>)}
        </select>
      </label>
      <p className="hint">공유 그룹마다 방 1개 · 같은 사내망 P2P · Team 과 같은 종단간 암호화 · 늦게 켠 그룹원은 온라인 그룹원에게서 따라잡아요.</p>
    </>
  )
}
