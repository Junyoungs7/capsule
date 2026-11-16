import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { CalendarEvent } from '../data/types'
import { chatAttach, chatSendPaths, clipFiles, dragOut, fileSrc, isTauri, islandOpen, launch, onEvent, setClip, shelfAdd, storeSet, teamState, useItems, usePrefix, useValue } from '../data/api'
import { CalendarSelect, refreshTeam, useTeam } from './Team'

/* 팀 채팅 (떠 있는 창 · 허브 '채팅'): 공유 그룹마다 방 1개 — 달력·메모와 같은 그룹.
   메시지 = store `chat:<id>` {group, by, byPk, kind, text | name·size·fid·from, at} → Hera Team 동기화(늦게 켠 사람도 따라잡기).
   파일·사진 = 보낸 사람 PC 에서 직접(P2P) — 보낸 사람이 오프라인이면 '온라인일 때 받기'. 받은 파일 경로 = `chatin:<fid>`. */

export type Msg = {
  id: string
  group: string
  by: string
  byPk?: string
  kind: 'text' | 'image' | 'file'
  text?: string
  name?: string
  size?: number
  fid?: string
  from?: string
  img?: string // 시안: 그림 data URI
  at: number
}

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
export const fmtSize = (b = 0) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1e3))}KB`)
const hm = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })

// 시안 대화 (브라우저 미리보기)
const pic = (a: string, b: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="320" height="200" fill="url(#g)"/><circle cx="240" cy="60" r="22" fill="#fde68a" opacity=".9"/><path d="M0 200 L80 110 L140 160 L210 90 L320 190 L320 200Z" fill="#0f766e" opacity=".85"/></svg>`)}`
const ago = (m: number) => Date.now() - m * 60_000
const SEED: Msg[] = isTauri ? [] : [
  { id: 'm1', group: 'tg-dev', by: '민수', byPk: 'minsu', kind: 'text', text: '배포 브랜치 정리했어요. 금요일 2시 그대로 가요', at: ago(42) },
  { id: 'm2', group: 'tg-dev', by: '나', byPk: 'me', kind: 'text', text: '넵 확인했어요', at: ago(40) },
  { id: 'm3', group: 'tg-dev', by: '지은', byPk: 'jieun', kind: 'file', name: '릴리즈노트_초안.docx', size: 2_400_000, fid: 'f3', from: 'jieun', at: ago(31) },
  { id: 'm4', group: 'tg-dev', by: '민수', byPk: 'minsu', kind: 'image', name: '에러화면.png', size: 380_000, fid: 'f4', from: 'minsu', img: pic('#38bdf8', '#e0f2fe'), at: ago(12) },
  { id: 'm5', group: 'tg-dev', by: '민수', byPk: 'minsu', kind: 'text', text: '내일 3시 회의 어때요? 배포 체크리스트 같이 봐요', at: ago(3) },
  { id: 'm6', group: 'tg-banner', by: '서연', byPk: 'seoyeon', kind: 'text', text: '메인 배너 카피 A/B 안 메모에 올렸어요', at: ago(25) },
]

type Props = {
  setEvents: (f: (all: CalendarEvent[]) => CalendarEvent[]) => void
  onToast?: (msg: string) => void
  onTeam?: () => void // 그룹이 없을 때: 아일랜드 안 Team 화면으로
}

export function ChatWindow({ setEvents, onToast, onTeam }: Props) {
  const { groups } = useTeam()
  const [msgs, setMsgs] = useItems<Msg>('chat', SEED)
  const [gid, setGid] = useValue<string>('chat.group', '')
  const group = groups.find((g) => g.id === gid) ?? groups[0]
  useEffect(() => void (group && group.id !== gid && setGid(group.id)), [group?.id]) // 아일랜드 '채팅에 보내기'가 같은 방을 쓰게
  const [, setUnread] = useValue('chat.unread', 0)
  const paths = usePrefix<string>('chatin:')
  const [prog, setProg] = useState<Record<string, number>>({})
  const [me, setMe] = useState<{ name: string; pk: string }>({ name: '나', pk: 'me' })
  const [text, setText] = useState('')
  const [over, setOver] = useState(false)
  const [big, setBig] = useState<Msg | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const say = (t: string) => (onToast ? onToast(t) : (setToast(t), setTimeout(() => setToast(null), 1600)))

  useEffect(() => {
    if (!isTauri) return
    void refreshTeam()
    void teamState().then((t) => setMe({ name: t.name, pk: t.pk }))
    // 파일 전송 진행 (Rust 'team' 이벤트의 chatXfer)
    return onEvent<{ kind: string; fid?: string; bytes?: number; size?: number }>('team', (e) => {
      if (e.kind === 'chatXfer' && e.fid) setProg((p) => ({ ...p, [e.fid!]: (e.bytes ?? 0) / Math.max(1, e.size ?? 1) }))
    })
  }, [])
  // 창을 보고 있으면 읽음
  useEffect(() => {
    setUnread(0)
    const f = () => setUnread(0)
    addEventListener('focus', f)
    return () => removeEventListener('focus', f)
  }, [])
  const room = msgs.filter((m) => m.group === group?.id).sort((a, b) => a.at - b.at)
  useEffect(() => void (list.current && (list.current.scrollTop = 1e9)), [room.length, group?.id])

  // 네이티브 드롭(파일 경로) = 첨부 — 채팅 창만 드롭 처리기를 켠다
  const gref = useRef(group?.id)
  gref.current = group?.id
  useEffect(() => {
    if (!isTauri) return
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload
      if (p.type === 'enter' || p.type === 'over') return setOver(true)
      setOver(false)
      if (p.type === 'drop' && p.paths.length && gref.current) void chatSendPaths(gref.current, p.paths).catch((err) => say(String(err)))
    })
    return () => void off.then((f) => f())
  }, [])

  const send = () => {
    const t = text.trim()
    if (!t || !group) return
    const id = crypto.randomUUID()
    setMsgs((all) => [...all, { id, group: group.id, by: me.name, byPk: me.pk, kind: 'text', text: t, at: Date.now() }])
    setText('')
  }
  const attach = (fl: FileList) => {
    if (!group) return
    for (const f of [...fl]) {
      if (!isTauri) {
        const id = crypto.randomUUID()
        setMsgs((all) => [...all, { id, group: group.id, by: me.name, byPk: me.pk, kind: f.type.startsWith('image/') ? 'image' : 'file', name: f.name, size: f.size, img: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined, at: Date.now() }])
        continue
      }
      void chatAttach(group.id, f).catch((err) => say(String(err)))
    }
  }
  const pathOf = (m: Msg) => (m.fid ? paths[m.fid] : undefined)
  const online = (pk?: string) => !pk || pk === me.pk || !!group?.members.find((x) => x.id === pk)?.online
  // 바로 사용
  const act = {
    copy: (m: Msg) => {
      const p = pathOf(m)
      if (m.kind === 'text') return void (isTauri ? setClip(m.text!) : navigator.clipboard?.writeText(m.text!)).then(() => say('복사됨'), (e) => say(String(e)))
      if (p) void clipFiles([p]).then(() => say(m.kind === 'image' ? '사진 복사됨 (붙여넣기 = 파일)' : '파일 복사됨'), (e) => say(String(e)))
    },
    open: (m: Msg) => {
      const p = pathOf(m)
      if (p) void launch(p).catch((e) => say(String(e)))
      else say('아직 받지 못했어요')
    },
    shelve: (m: Msg) => {
      const p = pathOf(m)
      if (p) void shelfAdd(p).then(() => say('선반에 담았어요'))
      else say('아직 받지 못했어요')
    },
    note: (m: Msg) => {
      const id = crypto.randomUUID()
      storeSet(`note:${id}`, { id, text: m.text, color: 3, x: 420, y: 160, w: 230, h: 150, pinned: false, group: m.group, by: m.by })
      storeSet('notes.shown', true)
      say('그룹 메모로 만들었어요')
    },
    event: (m: Msg, when: Date) => {
      const title = (m.text ?? '').replace(/(오늘|내일|모레|[일월화수목금토]요일)?\s*(오전|오후)?\s*\d{1,2}시\s*(\d{1,2}분|반)?/, '').split(/[?.!]/)[0].trim().slice(0, 30) || '회의'
      setEvents((all) => [...all, { id: crypto.randomUUID(), title, start: when.toISOString(), end: new Date(when.getTime() + 3_600_000).toISOString(), source: 'local', group: m.group, by: m.by }])
      say(`일정 추가 · ${when.toLocaleDateString('ko-KR', { weekday: 'short' })} ${hm(when.getTime())}`)
    },
  }

  if (!group)
    return (
      <div className="chat-none">
        <p>채팅방은 Hera Team 공유 그룹마다 하나씩 생겨요.</p>
        {/* (a4) 예전엔 패널 창(설정 › Team)을 띄웠다 → 아일랜드 안 Team 화면으로 */}
        <button className="primary" data-team onClick={() => (onTeam ? onTeam() : isTauri && void islandOpen('team'))}>Team 에서 그룹 만들기 · 들어오기</button>
      </div>
    )
  return (
    <section className="chat" style={{ '--g': group.color } as CSSProperties}>
      <div className="chat-head">
        <small>{group.members.filter((m) => m.online).length}명 온라인 · 달력·메모와 같은 방</small>
        <CalendarSelect groupsOnly value={group.id} onChange={setGid} />
      </div>
      <div className="chat-list" ref={list}>
        {room.length === 0 && <p className="float-empty">첫 메시지를 보내 보세요. 파일·사진은 여기나 캡슐에 끌어 놓으면 돼요.</p>}
        {room.map((m) => {
          const mine = m.byPk === me.pk
          const when = m.kind === 'text' && !mine ? parseWhen(m.text!) : null
          const p = pathOf(m)
          const pr = m.fid ? prog[m.fid] : undefined
          const waiting = m.kind !== 'text' && !p && !m.img
          const away = waiting && !online(m.from)
          const src = m.img ?? (p && m.kind === 'image' ? fileSrc(p) : undefined)
          return (
            <div key={m.id} className="chat-msg" data-me={mine}
              onPointerDown={(e) => { if (p && isTauri && e.buttons & 1) (e.currentTarget as HTMLElement).dataset.down = `${e.clientX},${e.clientY}` }}
              onPointerMove={(e) => {
                // 받은 파일·사진 끌어내기 (OLE) — 6px 넘게 움직이면
                const d = (e.currentTarget as HTMLElement).dataset.down?.split(',').map(Number)
                if (!d || !p || !(e.buttons & 1) || Math.hypot(e.clientX - d[0], e.clientY - d[1]) < 6) return
                delete (e.currentTarget as HTMLElement).dataset.down
                void dragOut(p)
              }}
              onPointerUp={(e) => delete (e.currentTarget as HTMLElement).dataset.down}>
              {!mine && <b className="chat-who"><i />{m.by} <small>{hm(m.at)}</small></b>}
              {m.kind === 'text' && <p className="chat-bubble">{m.text}</p>}
              {m.kind === 'image' && (
                src ? (
                  <button className="chat-img" onClick={() => setBig(m)} aria-label={`${m.name} 크게 보기`}>
                    <img src={src} alt={m.name} draggable={false} />
                    {pr !== undefined && pr < 1 && <Ring p={pr} />}
                  </button>
                ) : (
                  <span className="chat-file" data-off={away}><i className="chat-ext">IMG</i><span><b>{m.name}</b><small>{away ? '보낸 사람이 온라인일 때 받기' : pr !== undefined ? `받는 중 · ${fmtSize(m.size)}` : `받기 대기 · ${fmtSize(m.size)}`}</small></span>{pr !== undefined && <Ring p={pr} />}</span>
                )
              )}
              {m.kind === 'file' && (
                <span className="chat-file" data-off={away}>
                  <i className="chat-ext">{/\.([a-z0-9]{1,4})$/i.exec(m.name ?? '')?.[1] ?? '파일'}</i>
                  <span><b>{m.name}</b><small>{away ? '보낸 사람이 온라인일 때 받기' : waiting ? (pr !== undefined ? `받는 중 · ${fmtSize(m.size)}` : `받기 대기 · ${fmtSize(m.size)}`) : fmtSize(m.size)}</small></span>
                  {pr !== undefined && pr < 1 && <Ring p={pr} />}
                </span>
              )}
              {!mine && !away && (
                <span className="chat-acts" aria-label="바로 사용">
                  <button onClick={() => act.copy(m)}>복사</button>
                  {m.kind !== 'text' && <button onClick={() => act.open(m)}>열기</button>}
                  {m.kind !== 'text' && <button onClick={() => act.shelve(m)}>선반에</button>}
                  {m.kind === 'text' && <button onClick={() => act.note(m)}>메모로</button>}
                  {when && <button className="chat-when" onClick={() => act.event(m, when)}>＋ 일정 추가 · {when.toLocaleDateString('ko-KR', { weekday: 'short' })} {hm(when.getTime())}</button>}
                </span>
              )}
            </div>
          )
        })}
      </div>
      <form className="chat-input" data-over={over}
        onDragOver={(e: DragEvent) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)}
        onDrop={(e: DragEvent) => (e.preventDefault(), setOver(false), attach(e.dataTransfer.files))}
        onSubmit={(e) => (e.preventDefault(), send())}>
        <button type="button" className="chat-plus" aria-label="파일·사진 첨부" title="파일·사진 (최대 100MB)" onClick={() => file.current?.click()}>＋</button>
        <input type="file" ref={file} multiple hidden onChange={(e) => (e.target.files && attach(e.target.files), (e.target.value = ''))} />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={over ? '놓으면 보내요' : `${group.name}에 메시지`} aria-label="메시지" />
        <button className="primary">보내기</button>
      </form>
      {big && (
        <div className="chat-big" onClick={() => setBig(null)} role="dialog" aria-label={big.name}>
          <img src={big.img ?? fileSrc(pathOf(big) ?? '')} alt={big.name} />
          <small>{big.name} · {fmtSize(big.size)} · 누르면 닫기</small>
        </div>
      )}
      {toast && <div className="chat-toast" role="status">{toast}</div>}
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

