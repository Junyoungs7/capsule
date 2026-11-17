import { isTauri, onEvent, setClip, useItems, teamCreate, teamFlags, type TeamGroupRaw, teamInvite, teamJoin, teamState } from '../data/api'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react'

/* Hera Team 시안 (계획: .omc/plans/hera-team.md) — 동료 PC 와 달력·메모만 공유하는 '공유 그룹'.
   시안 전용 모듈 저장소: 그룹·숨긴 그룹(달력 필터)·열린 시트. 실제 통신(P2P·암호화·동기화)은 Hera Link 위에서 나중에. */

export type Member = { id: string; name: string; online: boolean; me?: boolean }
export type TeamGroup = { id: string; name: string; color: string; members: Member[]; alarms: boolean; news: boolean }
export type TeamNote = { id: string; group: string; text: string; by: string; ago: string }
type Sheet = { kind: 'invite' | 'board'; group: string }
type TeamState = { groups: TeamGroup[]; hidden: string[]; sheet: Sheet | null }

export const GROUP_COLORS = ['#14b8a6', '#8b5cf6', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899', '#84cc16', '#06b6d4', '#f97316', '#a855f7', '#22c55e', '#e11d48']

let st: TeamState = {
  groups: [
    { id: 'tg-dev', name: '개발팀', color: '#14b8a6', alarms: true, news: true, members: [
      { id: 'me', name: '나', online: true, me: true },
      { id: 'minsu', name: '민수', online: true },
      { id: 'jieun', name: '지은', online: false },
    ] },
    { id: 'tg-banner', name: '배너 프로젝트', color: '#8b5cf6', alarms: true, news: false, members: [
      { id: 'me', name: '나', online: true, me: true },
      { id: 'seoyeon', name: '서연', online: true },
      { id: 'hyunwoo', name: '현우', online: false },
    ] },
  ],
  hidden: [],
  sheet: null,
}
const subs = new Set<() => void>()
export const setTeam = (p: Partial<TeamState> | ((s: TeamState) => Partial<TeamState>)) => (
  (st = { ...st, ...(typeof p === 'function' ? p(st) : p) }), subs.forEach((f) => f())
)
export const useTeam = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => st)
export const groupOf = (id?: string) => (id ? st.groups.find((g) => g.id === id) : undefined)

/* 실제 앱: 그룹은 Rust(team.rs). 그룹원 = 공개키, 온라인 = 연결된 그룹원. 시드(시안 그룹)는 쓰지 않는다. */
const online = new Set<string>()
let myPk = ''
const fromRaw = (g: TeamGroupRaw): TeamGroup => ({
  id: g.id, name: g.name, color: g.color, alarms: g.alarms, news: g.news,
  members: g.members.map((m) => ({ id: m.pk, name: m.name, online: m.pk === myPk || online.has(m.pk), me: m.pk === myPk })),
})
export const refreshTeam = () => teamState().then((t) => ((myPk = t.pk), t.online?.forEach((pk) => online.add(pk)), setTeam({ groups: t.groups.map(fromRaw) })), () => {})
export const myTeamPk = () => myPk
if (isTauri) {
  st = { ...st, groups: [] }
  void refreshTeam()
  onEvent<{ kind: string; pk?: string; online?: boolean }>('team', (e) => {
    if (e.kind === 'chatXfer' || e.kind === 'chatFile') return // 채팅 파일 진행 — 그룹 정보와 무관
    if (e.kind === 'online' && e.pk) e.online ? online.add(e.pk) : online.delete(e.pk)
    void refreshTeam()
  })
}

// 시안·QA: 그룹 수 바꾸기 (1·3·12). 앞의 두 그룹은 시드 그대로, 나머지는 이름·색을 만들어 붙인다.
const EXTRA = ['디자인팀', '운영', '마케팅', 'QA', '모바일', '데이터', '인프라', '고객지원', '기획', '보안 점검 TF', 'Global Partnerships & Long Name Team']
const SEED_GROUPS = st.groups
export function setGroupCount(n: number) {
  const extra = EXTRA.slice(0, Math.max(0, n - 2)).map((name, i): TeamGroup => ({
    id: `tg-x${i}`, name, color: GROUP_COLORS[(i + 2) % GROUP_COLORS.length], alarms: true, news: i % 2 === 0,
    members: [{ id: 'me', name: '나', online: true, me: true }, ...Array.from({ length: 1 + (i % 5) }, (_, j) => ({ id: `m${i}-${j}`, name: '가나다라마바사'[(i + j) % 7] + '원', online: j % 2 === 0 }))],
  }))
  setTeam({ groups: [...SEED_GROUPS.slice(0, Math.min(n, 2)), ...extra], hidden: [] })
}

// 공유 메모판 시드 (n5 는 바탕화면에도 떠 있는 그룹 메모)
export const TEAM_NOTES: TeamNote[] = [
  { id: 'n5', group: 'tg-dev', text: '배포 체크리스트\n- [x] QA 확인\n- [ ] 릴리즈 노트', by: '민수', ago: '5분 전' },
  { id: 'tn2', group: 'tg-dev', text: '스테이징 DB 비번 바뀜 → 1Password 개발 볼트', by: '지은', ago: '어제' },
  { id: 'tn3', group: 'tg-dev', text: '금요일 배포 후 회고 30분', by: '나', ago: '2일 전' },
  { id: 'tn4', group: 'tg-banner', text: '메인 배너 카피 A/B 안 정리\n- 가을 특가\n- 단풍 여행', by: '서연', ago: '1시간 전' },
  { id: 'tn5', group: 'tg-banner', text: '오픈 전 모바일 크롭 확인', by: '현우', ago: '3일 전' },
]

/** 동그란 이니셜 + 온라인 점. 겹쳐 쌓인 아바타 줄 */
export function Avatars({ members, color, max = 4 }: { members: Member[]; color: string; max?: number }) {
  return (
    <span className="avatars" aria-label={`그룹원 ${members.length}명 · 온라인 ${members.filter((m) => m.online).length}명`}>
      {members.slice(0, max).map((m) => <Avatar key={m.id} m={m} color={color} />)}
    </span>
  )
}
export function Avatar({ m, color, size }: { m: Pick<Member, 'name' | 'online' | 'me'>; color: string; size?: number }) {
  return (
    <span className="avatar" data-online={m.online} data-me={!!m.me} style={{ '--g': color, ...(size ? { width: size, height: size, fontSize: size * 0.46 } : {}) } as CSSProperties} title={`${m.name}${m.online ? ' · 온라인' : ' · 오프라인'}`}>
      {m.name.slice(0, 1)}
    </span>
  )
}

/* ── 팀 (아일랜드 'Team' 화면 · 설정 → 채팅 → 팀 그룹) ──
   (a8) 한 화면: 그룹 카드(초대 코드·공유 메모판은 카드 안에서 펼침) + 맨 아래 '새 그룹'(이름 · 색 · Enter) · '코드로 참여'(Enter).
   예전 시트(화면을 덮는 판 · 따로 뜨는 이름 칸)는 없앴다 — 그룹이 없으면 만들기 칸이 바로 보이고 커서가 그 안에 있다. */
export function TeamSection() {
  const { groups, sheet } = useTeam()
  const patch = (id: string, p: Partial<TeamGroup>) => {
    setTeam((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, ...p } : g)) }))
    const g = { ...groupOf(id)!, ...p }
    if (isTauri) void teamFlags(id, g.alarms, g.news)
  }
  useEffect(() => () => setTeam({ sheet: null }), []) // 다른 화면으로 가면 펼친 것 접기
  const toggle = (kind: Sheet['kind'], group: string) => setTeam((s) => ({ sheet: s.sheet?.kind === kind && s.sheet.group === group ? null : { kind, group } }))
  return (
    <div className="team" onKeyDown={(e) => e.key === 'Escape' && sheet && (e.stopPropagation(), setTeam({ sheet: null }))}>
      <h3>팀 <small>사내망 동료와 달력·메모를 함께 써요</small></h3>
      {groups.map((g) => {
        const on = g.members.filter((m) => m.online && !m.me).length
        const open = sheet?.group === g.id ? sheet.kind : null
        return (
          <div key={g.id} className="team-card" data-group={g.id} style={{ '--g': g.color } as CSSProperties}>
            <div className="team-top">
              <i className="gdot" />
              <span className="grow">
                <b>{g.name}</b>
                <small>{g.members.length}명 · 온라인 {on}명</small>
              </span>
              <Avatars members={g.members} color={g.color} />
            </div>
            <label className="team-tog"><span className="grow">팀 일정 알림</span><input type="checkbox" className="switch" checked={g.alarms} onChange={(e) => patch(g.id, { alarms: e.target.checked })} /></label>
            <label className="team-tog"><span className="grow">변경 소식 <small>누가 추가·수정하면 캡슐에 짧게 알려요</small></span><input type="checkbox" className="switch" checked={g.news} onChange={(e) => patch(g.id, { news: e.target.checked })} /></label>
            <div className="team-acts">
              <BoardButton g={g} on={open === 'board'} onClick={() => toggle('board', g.id)} />
              <button aria-expanded={open === 'invite'} data-invite onClick={() => toggle('invite', g.id)}>동료 초대</button>
            </div>
            {open === 'invite' && <Invite g={g} />}
            {open === 'board' && <Board g={g} />}
          </div>
        )
      })}
      <NewGroup first={groups.length === 0} />
    </div>
  )
}

/** 새 그룹 (이름 · 색 · Enter = 만들기) + 코드로 참여 (Enter) — 한 화면, 늘 보임. 만들면 그 카드의 초대 코드가 바로 펼쳐진다 */
function NewGroup({ first }: { first: boolean }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(GROUP_COLORS[2])
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const make = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    const done = (id: string) => (setName(''), setTeam({ sheet: { kind: 'invite', group: id } }))
    if (isTauri) void teamCreate(n, color).then((g) => refreshTeam().then(() => done(g.id)))
    else {
      const id = crypto.randomUUID()
      setTeam((s) => ({ groups: [...s.groups, { id, name: n, color, alarms: true, news: true, members: [{ id: 'me', name: '나', online: true, me: true }] }] }))
      done(id)
    }
  }
  const okCode = /^\d{6}(@[\d.]+)?$/.test(code) || code.startsWith('hera-team:')
  const join = (e: FormEvent) => {
    e.preventDefault()
    if (!okCode) return
    if (!isTauri) return setCode('')
    setBusy('찾는 중…')
    teamJoin(code).then(() => (setBusy(null), setCode(''), void refreshTeam()), (err) => setBusy(String(err)))
  }
  return (
    <div className="team-add" data-first={first}>
      {first && <p className="team-empty">아직 그룹이 없어요. 이름을 쓰고 Enter 를 누르면 바로 만들어져요.</p>}
      <form className="create" onSubmit={make}>
        <div className="team-row">
          <i className="gdot" style={{ '--g': color } as CSSProperties} />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="새 그룹 이름 (예: 디자인팀)" aria-label="새 그룹 이름" autoFocus={first} />
          <button className="primary" disabled={!name.trim()}>만들기</button>
        </div>
        <div className="swatches" role="radiogroup" aria-label="그룹 색">
          {GROUP_COLORS.map((c) => <button type="button" key={c} role="radio" aria-checked={color === c} style={{ '--g': c } as CSSProperties} onClick={() => setColor(c)} aria-label={c} />)}
        </div>
      </form>
      <form className="join" onSubmit={join}>
        <div className="team-row">
          <input value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder="받은 초대 코드 6자리 또는 초대 문자열" aria-label="초대 코드" />
          <button className="primary" disabled={!okCode}>참여</button>
        </div>
        {busy && <small>{busy}</small>}
      </form>
    </div>
  )
}

function Invite({ g }: { g: TeamGroup }) {
  // 실제 앱: Rust 가 6자리 코드(10분) + 초대 문자열(이 PC 사내망 주소 포함)을 만든다
  const [real, setReal] = useState<[string, string] | null>(null)
  useEffect(() => void (isTauri && teamInvite(g.id).then(setReal, () => {})), [g.id])
  const code = isTauri ? real?.[0] ?? '······' : g.id === 'tg-dev' ? '482913' : '730264'
  const link = isTauri ? real?.[1] ?? '' : `hera-team:${code}:${g.name}:k7Qm2xV9`
  const ip = isTauri ? (/"a":\["([\d.]+)/.exec(decodeHex(link))?.[1] ?? '이 PC') : '10.20.31.44'
  const [copied, setCopied] = useState(false)
  const copy = () => (isTauri ? void setClip(link) : void navigator.clipboard?.writeText(link).catch(() => {}), setCopied(true))
  return (
    <div className="invite">
      <p>동료가 Hera 의 <b>Team</b> 화면 맨 아래 초대 코드 칸에 이 숫자를 넣으면 들어와요.</p>
      <div className="code" aria-label={`초대 코드 ${code.split('').join(' ')}`}>
        {code.split('').map((c, i) => <span key={i}>{c}</span>)}
      </div>
      <small className="ttl">10분 동안 쓸 수 있어요 · 그 뒤 주고받는 내용은 그룹 키로 암호화돼요</small>
      <div className="invite-link">
        <input readOnly value={link} aria-label="초대 문자열" onFocus={(e) => e.currentTarget.select()} />
        <button className="primary" onClick={copy}>{copied ? '복사했어요' : '복사'}</button>
      </div>
      <small>같은 네트워크에서 자동으로 못 찾으면 코드 뒤에 내 IP 를 붙여 <b>{code}@{ip}</b> 처럼 넣으면 돼요.</small>
    </div>
  )
}

// 실제 앱: 그룹 메모 = store note:<id> 중 group 이 이 그룹인 것 (Hera Team 이 그룹원과 동기화)
type BoardNote = { id: string; text: string; group?: string; by?: string; color?: number; x?: number; y?: number; w?: number; h?: number; pinned?: boolean }
function useGroupNotes(group: string): [TeamNote[], (text: string) => void] {
  const [all, setAll] = useItems<BoardNote>('note', [])
  if (!isTauri) return [TEAM_NOTES.filter((n) => n.group === group), () => {}]
  const me = st.groups.find((x) => x.id === group)?.members.find((m) => m.me)?.name ?? '나'
  const add = (text: string) => setAll((ns) => [...ns, { id: crypto.randomUUID(), text, group, by: me, color: 3, x: 160, y: 160, w: 220, h: 140, pinned: false }])
  return [all.filter((n) => n.group === group).map((n) => ({ id: n.id, group, text: n.text, by: n.by ?? '?', ago: '' })), add]
}

function Board({ g }: { g: TeamGroup }) {
  const [notes, add] = useGroupNotes(g.id)
  return (
    <div className="tboard">
      <div className="board-who"><Avatars members={g.members} color={g.color} /><small>그룹원 모두 고칠 수 있어요 · 지운 메모는 7일 동안 휴지통에</small></div>
      <div className="board-grid">
        {notes.map((n) => {
          const m = g.members.find((x) => x.name === n.by) ?? { name: n.by, online: false }
          return (
            <article key={n.id} className="board-note">
              <p>{n.text.split('\n').map((l, i) => <span key={i}>{l.replace(/^- \[( |x)\] /i, (s) => (/x/i.test(s) ? '☑ ' : '☐ '))}</span>)}</p>
              <footer><Avatar m={m} color={g.color} size={18} /><small>{n.by}{n.ago ? ` · ${n.ago}` : ''}</small></footer>
            </article>
          )
        })}
        <button className="tboard-add" onClick={() => add('')}>＋ 새 메모</button>
      </div>
    </div>
  )
}

type Cal = { id: string; name: string; color: string; members?: number }
const ME: Cal = { id: 'me', name: '내 일정', color: 'var(--accent)' }
const calsOf = (groups: TeamGroup[]): Cal[] => [ME, ...groups.map((g) => ({ id: g.id, name: g.name, color: g.color, members: g.members.length }))]
const SEARCH_FROM = 8 // 이보다 많으면 검색 칸

/** 그룹 목록 팝오버 (글라스). multi = 체크리스트(보이기/숨기기), 아니면 하나 고르기. 바깥 클릭·Esc 로 닫힘. */
function GroupMenu({ cals, checked, multi, onPick, onAll, onClose }: {
  cals: Cal[]
  checked: (id: string) => boolean
  multi?: boolean
  onPick: (id: string) => void
  onAll?: (show: boolean) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    // 여는 클릭이 바로 닫지 않게 다음 틱부터
    const down = (e: PointerEvent) => !box.current?.parentElement?.contains(e.target as Node) && close.current()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), close.current())
    const t = setTimeout(() => addEventListener('pointerdown', down))
    addEventListener('keydown', key, true)
    return () => (clearTimeout(t), removeEventListener('pointerdown', down), removeEventListener('keydown', key, true))
  }, [])
  // (a7) 자리가 있는 쪽으로 연다: 위·아래 중 넓은 쪽, 그 높이로 줄임 — 보이는 틀(.vbody · 창) 안에서 잘리지 않게.
  // 네이티브 팝업 없음 = 아일랜드 히트 rect(화면 안) 밖으로 나가지 않는다 (a4 날짜 고르기 교훈)
  const [place, setPlace] = useState<{ up: boolean; end: boolean; max: number } | null>(null)
  useLayoutEffect(() => {
    const wrap = box.current?.parentElement
    if (!wrap) return
    const frame = wrap.closest('.vbody, .wbody, .swin') ?? document.documentElement
    const f = frame === document.documentElement ? new DOMRect(0, 0, innerWidth, innerHeight) : frame.getBoundingClientRect()
    const w = wrap.getBoundingClientRect(), GAP = 6, PAD = 8
    const below = f.bottom - w.bottom - GAP - PAD, above = w.top - f.top - GAP - PAD
    const need = Math.min(320, box.current!.scrollHeight)
    const up = below < need && above > below
    setPlace({ up, end: w.left + 248 > f.right - PAD, max: Math.max(96, Math.min(320, up ? above : below)) })
  }, [])
  const list = q ? cals.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())) : cals
  return (
    <div ref={box} className="gp-pop" data-up={!!place?.up} data-end={!!place?.end} style={{ maxHeight: place?.max, visibility: place ? undefined : 'hidden' }} role={multi ? 'group' : 'listbox'} aria-label={multi ? '보이는 캘린더' : '캘린더 고르기'}>
      {cals.length > SEARCH_FROM && <input className="gp-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`캘린더 검색 (${cals.length}개)`} aria-label="캘린더 검색" autoFocus />}
      {multi && onAll && (
        <div className="gp-actions">
          <button onClick={() => onAll(true)}>모두 보기</button>
          <button onClick={() => onAll(false)}>모두 숨기기</button>
        </div>
      )}
      <div className="gp-list">
        {list.map((c) => (
          <button key={c.id} className="gp-item" role={multi ? 'checkbox' : 'option'} aria-checked={checked(c.id)} aria-selected={multi ? undefined : checked(c.id)} style={{ '--g': c.color } as CSSProperties} onClick={() => onPick(c.id)}>
            <i className="gp-check" />
            <span className="gp-name">{c.name}</span>
            {c.members && <small>{c.members}명</small>}
          </button>
        ))}
        {list.length === 0 && <p className="gp-empty">“{q}” 캘린더가 없어요</p>}
      </div>
    </div>
  )
}

/** 달력 필터: '캘린더 ▾' 알약 하나 (켜진 캘린더 색 점 ●●● +N) → 체크리스트 팝오버. 그룹이 많아도 한 줄. */
export function CalendarFilter() {
  const { groups, hidden } = useTeam()
  const [open, setOpen] = useState(false)
  const cals = calsOf(groups)
  const on = cals.filter((c) => !hidden.includes(c.id))
  const toggle = (id: string) => setTeam((s) => ({ hidden: s.hidden.includes(id) ? s.hidden.filter((x) => x !== id) : [...s.hidden, id] }))
  return (
    <div className="gp-wrap">
      <button className="gp-cap" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)} aria-label={`보이는 캘린더 ${on.length}/${cals.length}`}>
        <span className="gp-dots">
          {on.slice(0, 3).map((c) => <i key={c.id} style={{ '--g': c.color } as CSSProperties} />)}
          {on.length > 3 && <em>+{on.length - 3}</em>}
          {on.length === 0 && <em>없음</em>}
        </span>
        캘린더
        <svg viewBox="0 0 12 12" aria-hidden><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <GroupMenu
          multi
          cals={cals}
          checked={(id) => !hidden.includes(id)}
          onPick={toggle}
          onAll={(show) => setTeam({ hidden: show ? [] : cals.map((c) => c.id) })}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

/** 일정 추가 폼의 '어느 캘린더에' 고르기: 알약 → 하나 고르기 팝오버 (그룹이 많으면 검색) */
export function CalendarSelect({ value, onChange, groupsOnly }: { value: string; onChange: (id: string) => void; groupsOnly?: boolean }) {
  const { groups } = useTeam()
  const [open, setOpen] = useState(false)
  const cals = groupsOnly ? calsOf(groups).slice(1) : calsOf(groups) // groupsOnly: 채팅방 고르기 (내 일정 없음)
  const cur = cals.find((c) => c.id === (value || 'me')) ?? ME
  return (
    <div className="gp-wrap">
      <button type="button" className="gp-cap gp-select" style={{ '--g': cur.color } as CSSProperties} aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen((o) => !o)} aria-label={`어느 캘린더에: ${cur.name}`}>
        <i className="gp-one" />
        <span className="gp-name">{cur.name}</span>
        <svg viewBox="0 0 12 12" aria-hidden><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && <GroupMenu cals={cals} checked={(id) => id === cur.id} onPick={(id) => (onChange(id === 'me' ? '' : id), setOpen(false))} onClose={() => setOpen(false)} />}
    </div>
  )
}

/* ── 데모 바 '팀' 묶음 (시안 전용) ── */
export function TeamDemo({ onSettings, onCalendar, onNews, onAlarm }: { onSettings: () => void; onCalendar: () => void; onNews: () => void; onAlarm: () => void }) {
  const { groups } = useTeam()
  return (
    <>
      <header className="demo-sub">
        <b>팀</b>
        <small>동료와 달력·메모 공유</small>
      </header>
      <div className="demo-btns v3">
        <button onClick={onSettings}>팀 설정</button>
        <button onClick={() => (onSettings(), setTeam({ sheet: { kind: 'invite', group: 'tg-dev' } }))}>초대 코드</button>
        <button onClick={onCalendar}>그룹 달력</button>
        <button onClick={() => (onSettings(), setTeam({ sheet: { kind: 'board', group: 'tg-dev' } }))}>공유 메모판</button>
        <button onClick={onNews}>변경 소식</button>
        <button onClick={onAlarm}>팀 일정 알림</button>
      </div>
      <div className="demo-seg" role="group" aria-label="그룹 수 (QA)">
        {[1, 3, 12].map((n) => <button key={n} aria-pressed={groups.length === n} onClick={() => setGroupCount(n)}>그룹 {n}</button>)}
      </div>
    </>
  )
}

// 초대 문자열(hera-team:<hex JSON>) 풀기 — IP 안내용
function decodeHex(s: string) {
  const h = s.replace(/^hera-team:/, '')
  try {
    return new TextDecoder().decode(new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16))))
  } catch {
    return ''
  }
}

function BoardButton({ g, on, onClick }: { g: TeamGroup; on: boolean; onClick: () => void }) {
  const [notes] = useGroupNotes(g.id)
  return <button aria-expanded={on} data-board onClick={onClick}>공유 메모판 · {notes.length}</button>
}
