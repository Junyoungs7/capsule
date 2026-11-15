import { useEffect, useRef, useState, type DragEvent } from 'react'
import { CalendarSelect, groupOf } from '../surfaces/Team'

/* 허브 시안 추가분: 팀 채팅(공유 그룹마다 방 1개) · 미니 터미널(+ 아라에서 이어서 하기). 전부 가짜 데이터. */

/* ── 팀 채팅 ── */
export type Msg = {
  id: string
  group: string
  who: string
  me?: boolean
  kind: 'text' | 'image' | 'file'
  text?: string
  img?: string
  name?: string
  size?: number
  prog?: number // 0..1 받는/보내는 중, undefined = 끝
  offline?: boolean // 보낸 사람이 오프라인 → 파일은 저장 안 됨
  at: number
}
// 가짜 사진: 그라데이션 + 산 실루엣 SVG
const pic = (a: string, b: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="320" height="200" fill="url(#g)"/><circle cx="240" cy="60" r="22" fill="#fde68a" opacity=".9"/><path d="M0 200 L80 110 L140 160 L210 90 L320 190 L320 200Z" fill="#0f766e" opacity=".85"/><rect x="24" y="24" width="110" height="18" rx="9" fill="#fff" opacity=".8"/></svg>`)}`
const min = (m: number) => Date.now() - m * 60_000
const SEED: Msg[] = [
  { id: 'm1', group: 'tg-dev', who: '민수', kind: 'text', text: '배포 브랜치 정리했어요. 금요일 2시 그대로 가요', at: min(42) },
  { id: 'm2', group: 'tg-dev', who: '나', me: true, kind: 'text', text: '넵 확인했어요 👍', at: min(40) },
  { id: 'm3', group: 'tg-dev', who: '지은', kind: 'file', name: '릴리즈노트_초안.docx', size: 2_400_000, offline: true, at: min(31) },
  { id: 'm4', group: 'tg-dev', who: '민수', kind: 'image', img: pic('#38bdf8', '#e0f2fe'), name: '에러화면.png', size: 380_000, at: min(12) },
  { id: 'm5', group: 'tg-banner', who: '서연', kind: 'text', text: '메인 배너 카피 A/B 안 메모에 올렸어요', at: min(25) },
  { id: 'm6', group: 'tg-banner', who: '서연', kind: 'image', img: pic('#f472b6', '#fde68a'), name: '배너_시안_B.png', size: 1_200_000, at: min(24) },
]
const INCOMING: Omit<Msg, 'id' | 'at'>[] = [
  { group: 'tg-dev', who: '민수', kind: 'text', text: '내일 3시 회의 어때요? 배포 체크리스트 같이 봐요' },
  { group: 'tg-banner', who: '서연', kind: 'image', img: pic('#a78bfa', '#fbcfe8'), name: '겨울배너_최종.png', size: 860_000 },
  { group: 'tg-dev', who: '민수', kind: 'file', name: '빌드로그_1115.zip', size: 18_400_000 },
]
export const fmtSize = (b = 0) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1e3))}KB`)

/** '내일 3시', '금요일 2시', '오후 2시 반', '모레 10시 30분' → 날짜 (없으면 null). 오전/오후 없이 1~7시는 오후로 본다. */
export function parseWhen(t: string, now = new Date()): Date | null {
  const m = /(오늘|내일|모레|[일월화수목금토]요일)?\s*(오전|오후)?\s*(\d{1,2})시\s*(?:(\d{1,2})분|(반))?/.exec(t)
  if (!m) return null
  let h = Number(m[3])
  if ((m[2] === '오후' && h < 12) || (!m[2] && h >= 1 && h <= 7)) h += 12
  const d = new Date(now)
  const wd = m[1]?.endsWith('요일') ? '일월화수목금토'.indexOf(m[1][0]) : -1
  d.setDate(d.getDate() + (wd >= 0 ? (wd - d.getDay() + 7) % 7 || 7 : ({ 오늘: 0, 내일: 1, 모레: 2 } as Record<string, number>)[m[1] ?? '오늘']))
  d.setHours(h, m[4] ? Number(m[4]) : m[5] ? 30 : 0, 0, 0)
  return d
}

export function useChat() {
  const [msgs, setMsgs] = useState<Msg[]>(SEED)
  const [group, setGroup] = useState('tg-dev')
  const [unread, setUnread] = useState(0)
  const n = useRef(0)
  // 진행 흉내: prog 를 0→1 로 (2~3초)
  const progress = (id: string) => {
    const t = window.setInterval(() => {
      let done = false
      setMsgs((all) => all.map((m) => (m.id === id ? ((done = (m.prog ?? 1) + 0.09 >= 1), { ...m, prog: done ? undefined : (m.prog ?? 0) + 0.09 }) : m)))
      if (done) clearInterval(t)
    }, 180)
  }
  const push = (m: Omit<Msg, 'id' | 'at'>) => {
    const id = crypto.randomUUID()
    setMsgs((all) => [...all, { ...m, id, at: Date.now() }])
    if (m.prog !== undefined) progress(id)
    return id
  }
  const send = (text: string, g = group) => push({ group: g, who: '나', me: true, kind: 'text', text })
  const attach = (files: { name: string; size?: number; url?: string }[]) =>
    files.forEach((f) => push({ group, who: '나', me: true, kind: f.url || /\.(png|jpe?g|gif|webp)$/i.test(f.name) ? 'image' : 'file', name: f.name, size: f.size ?? 1_500_000, img: f.url ?? (/\.(png|jpe?g|gif|webp)$/i.test(f.name) ? pic('#34d399', '#d1fae5') : undefined), prog: 0 }))
  const receive = () => {
    const m = INCOMING[n.current++ % INCOMING.length]
    push({ ...m, prog: m.kind === 'text' ? undefined : 0 })
    return m
  }
  return { msgs, group, setGroup, unread, setUnread, send, attach, receive }
}
export type Chat = ReturnType<typeof useChat>

export type ChatActions = {
  copy: (m: Msg) => void
  open: (m: Msg) => void
  shelve: (m: Msg) => void
  note: (m: Msg) => void
  event: (m: Msg, when: Date) => void
}

export function ChatView({ chat, act }: { chat: Chat; act: ChatActions }) {
  const list = chat.msgs.filter((m) => m.group === chat.group)
  const g = groupOf(chat.group)
  const [text, setText] = useState('')
  const [over, setOver] = useState(false)
  const [big, setBig] = useState<Msg | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => void (end.current && (end.current.scrollTop = 1e9)), [list.length, chat.group])
  const files = (fl: FileList) => chat.attach([...fl].map((f) => ({ name: f.name, size: f.size, url: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined })))
  return (
    <section className="chat">
      <div className="chat-head">
        <h4>채팅 <small>{g?.members.filter((m) => m.online).length ?? 0}명 온라인 · 공유 그룹 = 달력·메모와 같은 방</small></h4>
        <CalendarSelect groupsOnly value={chat.group} onChange={chat.setGroup} />
      </div>
      <div className="chat-list" ref={end}>
        {list.map((m) => {
          const when = m.kind === 'text' && !m.me ? parseWhen(m.text!) : null
          return (
            <div key={m.id} className="chat-msg" data-me={!!m.me} style={{ '--g': g?.color } as React.CSSProperties}
              draggable={!m.me && !m.offline && m.prog === undefined}
              onDragStart={(e) => e.dataTransfer.setData('text/x-hera-chat', m.name ?? m.text ?? '')}>
              {!m.me && <b className="chat-who"><i />{m.who} <small>{new Date(m.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</small></b>}
              {m.kind === 'text' && <p className="chat-bubble">{m.text}</p>}
              {m.kind === 'image' && (
                <button className="chat-img" onClick={() => setBig(m)} aria-label={`${m.name} 크게 보기`}>
                  <img src={m.img} alt={m.name} draggable={false} />
                  {m.prog !== undefined && <Ring p={m.prog} />}
                </button>
              )}
              {m.kind === 'file' && (
                <span className="chat-file" data-off={!!m.offline}>
                  <i className="chat-ext">{/\.([a-z0-9]{1,4})$/i.exec(m.name!)?.[1]}</i>
                  <span><b>{m.name}</b><small>{m.offline ? '보낸 사람이 온라인일 때 받기' : m.prog !== undefined ? `${m.me ? '보내는' : '받는'} 중 · ${fmtSize(m.size)}` : fmtSize(m.size)}</small></span>
                  {m.prog !== undefined && <Ring p={m.prog} />}
                </span>
              )}
              {!m.me && !m.offline && m.prog === undefined && (
                <span className="chat-acts" aria-label="바로 사용">
                  <button onClick={() => act.copy(m)}>복사</button>
                  {m.kind !== 'text' && <button onClick={() => act.open(m)}>열기</button>}
                  {m.kind !== 'text' && <button onClick={() => act.shelve(m)}>선반에</button>}
                  {m.kind === 'text' && <button onClick={() => act.note(m)}>메모로</button>}
                  {when && <button className="chat-when" onClick={() => act.event(m, when)}>＋ 일정 추가 · {when.toLocaleDateString('ko-KR', { weekday: 'short' })} {when.getHours()}:{String(when.getMinutes()).padStart(2, '0')}</button>}
                  <small>끌어서 창·바탕화면에 복사</small>
                </span>
              )}
            </div>
          )
        })}
      </div>
      <form className="chat-input" data-over={over}
        onDragOver={(e: DragEvent) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)}
        onDrop={(e: DragEvent) => (e.preventDefault(), setOver(false), files(e.dataTransfer.files))}
        onSubmit={(e) => (e.preventDefault(), text.trim() && (chat.send(text.trim()), setText('')))}>
        <button type="button" className="chat-plus" aria-label="파일·사진 첨부" onClick={() => file.current?.click()}>＋</button>
        <input type="file" ref={file} multiple hidden onChange={(e) => e.target.files && files(e.target.files)} />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={over ? '놓으면 보내요' : `${g?.name ?? ''}에 메시지 · 파일은 여기나 알약에 놓기`} />
        <button className="primary">보내기</button>
      </form>
      <p className="hub-legend">제안 기본값(확정 전): 같은 사내망 P2P · Team 종단간 암호화 그대로 · 기록은 link_sync 로 맞춤(늦게 켠 사람은 온라인 그룹원에게서 따라잡기) · 이 PC 에 30일 보관 · 파일 최대 100MB, P2P 직접 전송이라 오프라인 멤버용으로 저장 안 함</p>
      {big && (
        <div className="chat-big" onClick={() => setBig(null)} role="dialog" aria-label={big.name}>
          <img src={big.img} alt={big.name} />
          <small>{big.name} · {fmtSize(big.size)} · 누르면 닫기</small>
        </div>
      )}
    </section>
  )
}

function Ring({ p }: { p: number }) {
  return (
    <svg className="ring" viewBox="0 0 24 24" aria-label={`${Math.round(p * 100)}%`}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="9" style={{ strokeDasharray: `${p * 56.5} 56.5` }} />
    </svg>
  )
}

/* ── 미니 터미널 (가짜 출력) ── */
type Line = { k: 'in' | 'out' | 'err' | 'ok'; s: string }
const DIRS: Record<string, string[]> = {
  'D:\\AI\\hera': ['src', 'src-tauri', 'scripts', 'package.json', 'vite.config.ts', 'README.md'],
  'D:\\AI\\hera\\src': ['mockup', 'surfaces', 'styles', 'data', 'main.tsx'],
  'D:\\AI\\hera\\src-tauri': ['src', 'capabilities', 'Cargo.toml', 'tauri.conf.json'],
  'D:\\AI\\hera\\scripts': ['inline-hub.mjs'],
}
const BUILD = ['> hera@0.1.0 build', '> tsc && vite build', '', 'vite v5.4.21 building for production...']

export function useTerm(onDone: (ok: boolean, cmd: string) => void) {
  const [lines, setLines] = useState<Line[]>([{ k: 'out', s: 'Windows PowerShell (시안 · 가짜 출력)  —  help 로 명령 보기' }])
  const [cwd, setCwd] = useState('D:\\AI\\hera')
  const [running, setRunning] = useState<string | null>(null)
  const [hist, setHist] = useState<string[]>([])
  const done = useRef(onDone)
  done.current = onDone
  const out = (...ls: Line[]) => setLines((all) => [...all, ...ls].slice(-200))
  // 오래 걸리는 명령: 줄을 시간차로 찍고 끝에 성공/실패 → 허브가 접혀 있어도 계속
  const stream = (cmd: string, steps: [number, Line][], ok: boolean) => {
    setRunning(cmd)
    let t = 0
    steps.forEach(([ms, l]) => ((t += ms), setTimeout(() => out(l), t)))
    setTimeout(() => (setRunning(null), done.current(ok, cmd)), t + 200)
  }
  const run = (raw: string) => {
    const cmd = raw.trim()
    out({ k: 'in', s: `PS ${cwd}> ${cmd}` })
    if (!cmd) return
    setHist((h) => [...h.filter((x) => x !== cmd), cmd])
    const [c, arg] = cmd.split(/\s+/, 2)
    if (c === 'clear' || c === 'cls') return setLines([])
    if (c === 'help') return out({ k: 'out', s: 'dir · cd <폴더> · git status · npm run build (오래 걸림) · npm test (실패 예시) · echo · cls' })
    if (c === 'dir' || c === 'ls') return out(...(DIRS[cwd] ?? []).map((f) => ({ k: 'out' as const, s: `${/\./.test(f) ? '-a---' : 'd----'}   2026-11-15  21:${String(10 + f.length).padStart(2, '0')}   ${f}` })))
    if (c === 'cd') {
      const next = !arg || arg === '..' ? cwd.split('\\').slice(0, -1).join('\\') || cwd : `${cwd}\\${arg}`
      return DIRS[next] ? setCwd(next) : out({ k: 'err', s: `cd: '${arg}' 경로를 찾을 수 없어요` })
    }
    if (c === 'echo') return out({ k: 'out', s: cmd.slice(5) })
    if (cmd === 'git status') return out(...['On branch island-hub', 'Changes not staged for commit:', '  modified:   src/mockup/Hub.tsx', '  modified:   src/styles/hub.css', 'Untracked files:', '  src/mockup/HubExtras.tsx'].map((s) => ({ k: (s.startsWith('  ') ? 'err' : 'out') as Line['k'], s })))
    if (cmd === 'npm run build')
      return stream(cmd, [
        ...BUILD.map((s) => [120, { k: 'out', s }] as [number, Line]),
        ...[18, 37, 61, 84, 100].map((p) => [700, { k: 'out', s: `transforming… ${'█'.repeat(p / 10)}${'░'.repeat(10 - p / 10)} ${p}%` }] as [number, Line]),
        [500, { k: 'out', s: '✓ 312 modules transformed.' }],
        [300, { k: 'out', s: 'dist/index.html            0.52 kB' }],
        [200, { k: 'out', s: 'dist/assets/index.js     431.20 kB │ gzip: 128.40 kB' }],
        [300, { k: 'ok', s: '✓ built in 4.82s' }],
      ], true)
    if (cmd === 'npm test')
      return stream(cmd, [
        [300, { k: 'out', s: '> hera@0.1.0 test' }],
        [900, { k: 'out', s: ' ✓ holidays 2026–2030 (12)' }],
        [900, { k: 'err', s: ' ✕ shelf › 5번째 파일이면 가장 오래된 것부터 빼기' }],
        [400, { k: 'err', s: 'Tests: 1 failed, 12 passed' }],
      ], false)
    out({ k: 'err', s: `'${c}' — 시안에서는 지원하지 않는 명령이에요 (help)` })
  }
  return { lines, cwd, running, hist, run }
}
export type Term = ReturnType<typeof useTerm>

export function TermView({ term, onAra }: { term: Term; onAra: (pane: HTMLElement) => void }) {
  const [v, setV] = useState('')
  const [hi, setHi] = useState(-1)
  const pane = useRef<HTMLElement>(null)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => void (end.current && (end.current.scrollTop = 1e9)), [term.lines.length])
  const crumbs = term.cwd.split('\\')
  return (
    <section ref={pane} className="term">
      <div className="term-head">
        <span className="term-crumbs">{crumbs.map((c, i) => <span key={i}>{c}</span>)}</span>
        {term.running && <span className="term-run"><i className="hub-spin" />{term.running}</span>}
        <button className="term-ara" onClick={() => onAra(pane.current!)}>아라에서 이어서 하기 ↗</button>
      </div>
      <div className="term-out" ref={end} onClick={() => pane.current?.querySelector('input')?.focus()}>
        {term.lines.map((l, i) => <div key={i} data-k={l.k}>{l.s || ' '}</div>)}
        <form onSubmit={(e) => (e.preventDefault(), term.run(v), setV(''), setHi(-1))}>
          <span>PS {term.cwd}&gt;</span>
          <input value={v} onChange={(e) => setV(e.target.value)} spellCheck={false} autoComplete="off" aria-label="명령"
            placeholder={term.lines.length < 2 ? 'npm run build · git status · dir  (↑ 기록)' : ''}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
              e.preventDefault()
              const h = term.hist
              const i = e.key === 'ArrowUp' ? (hi < 0 ? h.length - 1 : Math.max(0, hi - 1)) : hi < 0 ? -1 : hi + 1 >= h.length ? -1 : hi + 1
              setHi(i)
              setV(i < 0 ? '' : h[i])
            }} />
        </form>
      </div>
      <p className="hub-legend">시안: 실제 실행 없음. 실제 앱 = ConPTY(Rust PTY) + xterm.js, 터미널을 열 때만 로드(평소 메모리 영향 없음), 기본 PowerShell. 아라 넘기기 = 공식 CLI 만 사용: <code>ara status</code> → 꺼져 있으면 <code>ara open</code> → 이 폴더를 cwd 로 <code>ara terminal create --title "Hera에서" [--command 마지막 명령]</code>. 새 셸이라 스크롤 기록은 안 넘어가고 폴더(+마지막 명령)만 이어져요.</p>
    </section>
  )
}
