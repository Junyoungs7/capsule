import { useEffect, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react'

/* Hera Team 시안 (계획: .omc/plans/hera-team.md) — 동료 PC 와 달력·메모만 공유하는 '공유 그룹'.
   시안 전용 모듈 저장소: 그룹·숨긴 그룹(달력 필터)·열린 시트. 실제 통신(P2P·암호화·동기화)은 Hera Link 위에서 나중에. */

export type Member = { id: string; name: string; online: boolean; me?: boolean }
export type TeamGroup = { id: string; name: string; color: string; members: Member[]; alarms: boolean; news: boolean }
export type TeamNote = { id: string; group: string; text: string; by: string; ago: string }
type Sheet = { kind: 'invite' | 'board'; group: string } | { kind: 'join' | 'create' }
type TeamState = { groups: TeamGroup[]; hidden: string[]; sheet: Sheet | null }

export const GROUP_COLORS = ['#14b8a6', '#8b5cf6', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899']

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

/** 달력 필터 칩: 내 일정 + 그룹들 (눌러서 숨기기/보이기) */
export function GroupChips() {
  const { groups, hidden } = useTeam()
  const toggle = (id: string) => setTeam((s) => ({ hidden: s.hidden.includes(id) ? s.hidden.filter((x) => x !== id) : [...s.hidden, id] }))
  return (
    <div className="gchips" role="group" aria-label="보이는 달력">
      {[{ id: 'me', name: '내 일정', color: 'var(--accent)' }, ...groups].map((g) => (
        <button key={g.id} aria-pressed={!hidden.includes(g.id)} style={{ '--g': g.color } as CSSProperties} onClick={() => toggle(g.id)}>
          <i />{g.name}
        </button>
      ))}
    </div>
  )
}

/* ── 데모 바 '팀' 묶음 (시안 전용) ── */
export function TeamDemo({ onSettings, onCalendar, onNews, onAlarm }: { onSettings: () => void; onCalendar: () => void; onNews: () => void; onAlarm: () => void }) {
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
    </>
  )
}
