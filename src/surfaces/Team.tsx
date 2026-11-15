import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react'

/* Hera Team 시안 (계획: .omc/plans/hera-team.md) — 동료 PC 와 달력·메모만 공유하는 '공유 그룹'.
   시안 전용 모듈 저장소: 그룹·숨긴 그룹(달력 필터)·열린 시트. 실제 통신(P2P·암호화·동기화)은 Hera Link 위에서 나중에. */

export type Member = { id: string; name: string; online: boolean; me?: boolean }
export type TeamGroup = { id: string; name: string; color: string; members: Member[]; alarms: boolean; news: boolean }
export type TeamNote = { id: string; group: string; text: string; by: string; ago: string }
type Sheet = { kind: 'invite' | 'board'; group: string } | { kind: 'join' | 'create' }
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

/* ── 패널 설정 → 팀 ── */
export function TeamSection() {
  const { groups, sheet } = useTeam()
  const patch = (id: string, p: Partial<TeamGroup>) => setTeam((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, ...p } : g)) }))
  useEffect(() => () => setTeam({ sheet: null }), []) // 다른 탭으로 가면 시트 닫기
  return (
    <>
      <h3>팀 <small>같은 사내망 동료와 달력·메모 공유</small></h3>
      {groups.map((g) => {
        const on = g.members.filter((m) => m.online && !m.me).length
        return (
          <div key={g.id} className="team-card" style={{ '--g': g.color } as CSSProperties}>
            <div className="team-top">
              <i className="gdot" />
              <span className="grow">
                <b>{g.name}</b>
                <small>{g.members.length}명 · 온라인 {on}명</small>
              </span>
              <Avatars members={g.members} color={g.color} />
            </div>
            <label className="team-tog"><span className="grow">팀 일정 알림</span><input type="checkbox" className="switch" checked={g.alarms} onChange={(e) => patch(g.id, { alarms: e.target.checked })} /></label>
            <label className="team-tog"><span className="grow">변경 소식 <small>누가 추가·수정하면 Island 에 짧게</small></span><input type="checkbox" className="switch" checked={g.news} onChange={(e) => patch(g.id, { news: e.target.checked })} /></label>
            <div className="team-acts">
              <button onClick={() => setTeam({ sheet: { kind: 'board', group: g.id } })}>공유 메모판 · {TEAM_NOTES.filter((n) => n.group === g.id).length}</button>
              <button onClick={() => setTeam({ sheet: { kind: 'invite', group: g.id } })}>초대</button>
            </div>
          </div>
        )
      })}
      <div className="team-new">
        <button onClick={() => setTeam({ sheet: { kind: 'create' } })}>그룹 만들기</button>
        <button onClick={() => setTeam({ sheet: { kind: 'join' } })}>코드로 참여</button>
      </div>
      {sheet && <TeamSheet sheet={sheet} />}
    </>
  )
}

/* 패널 안 시트 (패널 안쪽을 덮는 짙은 유리 판, 스프링으로 떠오름) */
function TeamSheet({ sheet }: { sheet: Sheet }) {
  const close = () => setTeam({ sheet: null })
  const g = 'group' in sheet ? groupOf(sheet.group) : undefined
  return (
    <div className="team-sheet" role="dialog" aria-label="팀" style={g ? ({ '--g': g.color } as CSSProperties) : undefined} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <header>
        {g && <i className="gdot" />}
        <b>{sheet.kind === 'invite' ? `${g?.name} 초대` : sheet.kind === 'board' ? `${g?.name} 공유 메모판` : sheet.kind === 'join' ? '코드로 참여' : '그룹 만들기'}</b>
        <button className="icon-btn" onClick={close} aria-label="닫기">×</button>
      </header>
      {sheet.kind === 'invite' && g && <Invite g={g} />}
      {sheet.kind === 'join' && <Join onDone={close} />}
      {sheet.kind === 'create' && <Create onDone={close} />}
      {sheet.kind === 'board' && g && <Board g={g} />}
    </div>
  )
}

function Invite({ g }: { g: TeamGroup }) {
  const code = g.id === 'tg-dev' ? '482913' : '730264'
  const link = `hera-team:${code}:${g.name}:k7Qm2xV9`
  const [copied, setCopied] = useState(false)
  const copy = () => (void navigator.clipboard?.writeText(link).catch(() => {}), setCopied(true))
  return (
    <div className="invite">
      <p>동료의 Hera 에서 <b>팀 → 코드로 참여</b>에 입력하면 들어와요.</p>
      <div className="code" aria-label={`초대 코드 ${code.split('').join(' ')}`}>
        {code.split('').map((c, i) => <span key={i}>{c}</span>)}
      </div>
      <small className="ttl">10분 동안 유효 · 이후 대화는 그룹 키로 암호화</small>
      <div className="invite-link">
        <input readOnly value={link} aria-label="초대 문자열" onFocus={(e) => e.currentTarget.select()} />
        <button className="primary" onClick={copy}>{copied ? '복사됨' : '복사'}</button>
      </div>
      <small>사내망 자동 발견이 막혀 있으면 상대가 내 IP(10.20.31.44)를 직접 입력할 수 있어요.</small>
    </div>
  )
}

function Join({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('')
  const ok = /^\d{6}$/.test(code) || code.startsWith('hera-team:')
  return (
    <form className="join" onSubmit={(e) => (e.preventDefault(), ok && onDone())}>
      <p>초대받은 6자리 코드 또는 초대 문자열을 붙여 넣으세요.</p>
      <input className="join-code" value={code} onChange={(e) => setCode(e.target.value.trim())} inputMode="numeric" placeholder="000000" aria-label="초대 코드" autoFocus />
      <button className="primary" disabled={!ok}>참여</button>
    </form>
  )
}

function Create({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(GROUP_COLORS[2])
  const make = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setTeam((s) => ({ groups: [...s.groups, { id: crypto.randomUUID(), name: name.trim(), color, alarms: true, news: true, members: [{ id: 'me', name: '나', online: true, me: true }] }] }))
    onDone()
  }
  return (
    <form className="create" onSubmit={make}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="그룹 이름 (예: 디자인팀)" aria-label="그룹 이름" autoFocus />
      <div className="swatches" role="radiogroup" aria-label="그룹 색">
        {GROUP_COLORS.map((c) => <button type="button" key={c} role="radio" aria-checked={color === c} style={{ '--g': c } as CSSProperties} onClick={() => setColor(c)} aria-label={c} />)}
      </div>
      <button className="primary" disabled={!name.trim()}>만들기</button>
    </form>
  )
}

function Board({ g }: { g: TeamGroup }) {
  const notes = TEAM_NOTES.filter((n) => n.group === g.id)
  return (
    <div className="board">
      <div className="board-who"><Avatars members={g.members} color={g.color} /><small>모두 편집할 수 있어요 · 지운 메모는 7일간 휴지통</small></div>
      <div className="board-grid">
        {notes.map((n) => {
          const m = g.members.find((x) => x.name === n.by) ?? { name: n.by, online: false }
          return (
            <article key={n.id} className="board-note">
              <p>{n.text.split('\n').map((l, i) => <span key={i}>{l.replace(/^- \[( |x)\] /i, (s) => (/x/i.test(s) ? '☑ ' : '☐ '))}</span>)}</p>
              <footer><Avatar m={m} color={g.color} size={18} /><small>{n.by} · {n.ago}</small></footer>
            </article>
          )
        })}
        <button className="board-add">＋ 새 메모</button>
      </div>
    </div>
  )
}

type Cal = { id: string; name: string; color: string; members?: number }
const ME: Cal = { id: 'me', name: '내 일정', color: 'var(--accent)' }
const calsOf = (groups: TeamGroup[]): Cal[] => [ME, ...groups.map((g) => ({ id: g.id, name: g.name, color: g.color, members: g.members.length }))]
const SEARCH_FROM = 8 // 이보다 많으면 검색 칸

/** 그룹 목록 팝오버 (글라스). multi = 체크리스트(보이기/숨기기), 아니면 하나 고르기. 바깥 클릭·Esc 로 닫힘. */
function GroupMenu({ cals, checked, multi, up, end, onPick, onAll, onClose }: {
  cals: Cal[]
  checked: (id: string) => boolean
  multi?: boolean
  up?: boolean
  end?: boolean // 오른쪽 정렬 (알약이 오른쪽 끝에 있을 때)
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
  const list = q ? cals.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())) : cals
  return (
    <div ref={box} className="gp-pop" data-up={!!up} data-end={!!end} role={multi ? 'group' : 'listbox'} aria-label={multi ? '보이는 캘린더' : '캘린더 고르기'}>
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
          up
          end
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
export function CalendarSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { groups } = useTeam()
  const [open, setOpen] = useState(false)
  const cals = calsOf(groups)
  const cur = cals.find((c) => c.id === (value || 'me')) ?? ME
  return (
    <div className="gp-wrap">
      <button type="button" className="gp-cap gp-select" style={{ '--g': cur.color } as CSSProperties} aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen((o) => !o)} aria-label={`어느 캘린더에: ${cur.name}`}>
        <i className="gp-one" />
        <span className="gp-name">{cur.name}</span>
        <svg viewBox="0 0 12 12" aria-hidden><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && <GroupMenu up cals={cals} checked={(id) => id === cur.id} onPick={(id) => (onChange(id === 'me' ? '' : id), setOpen(false))} onClose={() => setOpen(false)} />}
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
