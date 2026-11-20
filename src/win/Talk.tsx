import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { isTauri, onEvent, talkClear, talkFile, talkInvite, talkList, talkRead, talkSend, useValue, type TalkMsg } from '../data/api'
import { colorFor, initial, usePeople } from './people'
import { Ico } from './icons'
import { colorOf, extOf } from './Panel'

/* 전체 톡 창 (?surface=talk, 보통 창 380×560 — 시안 talk.html). 등록한 사람 모두 + 내 맥이 한 방.
   기록은 이 PC 에만 (Rust talk.rs, 최근 500개). 꺼진 사람은 그동안의 말을 못 받는다.
   Enter = 보내기 · Shift+Enter = 줄바꿈 · 파일을 창에 끌어 놓으면 켜진 사람 모두에게 · + 초대 = 고른 사람과 톡 사람들이 서로 등록. */
const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5)
const day = (at: number) => new Date(at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })
const size = (n: number) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)

export function TalkWin() {
  const [msgs, setMsgs] = useState<TalkMsg[]>([])
  const [text, setText] = useState('')
  const [inviting, setInviting] = useState(false)
  const [pick, setPick] = useState<string[]>([])
  const [drop, setDrop] = useState(false)
  const [sure, setSure] = useState(false)
  const [peer] = useValue<string | null>('link.peerName', null)
  const { people, online } = usePeople()
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isTauri) return
    void talkList().then(setMsgs, () => {})
    void talkRead()
    const offs = [
      onEvent<TalkMsg>('talk', (m) => (setMsgs((all) => (all.some((x) => x.id === m.id) ? all : [...all, m].slice(-500))), document.hasFocus() && void talkRead())),
      onEvent('talk-cleared', () => setMsgs([])),
    ]
    const focus = () => void talkRead()
    addEventListener('focus', focus)
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload
      if (p.type === 'enter' || p.type === 'over') return setDrop(true)
      setDrop(false)
      if (p.type === 'drop' && p.paths.length) void talkFile(p.paths)
    })
    return () => (offs.forEach((f) => f()), removeEventListener('focus', focus), void off.then((f) => f()))
  }, [])
  useLayoutEffect(() => void (list.current && (list.current.scrollTop = list.current.scrollHeight)), [msgs.length])

  const on = people.filter((p) => online(p.id))
  const off = people.filter((p) => !online(p.id))
  const total = people.length + (peer ? 1 : 0)
  const send = () => {
    const t = text.trim()
    if (!t) return
    void talkSend(t)
    setText('')
  }
  const nameOf = (m: TalkMsg) => (m.from === 'mac' ? m.name || peer || '내 맥' : m.name || '?')
  const clear = () => (sure ? (void talkClear(), setSure(false)) : (setSure(true), window.setTimeout(() => setSure(false), 3000)))
  return (
    <div className={`talkwin ${drop ? 'drop' : ''}`}>
      <header className="tb">
        <b>전체 톡</b><small data-talk-count>{total}명 · {on.length + (peer ? 1 : 0)}명 켜짐</small>
        <span className="who">
          {peer && <span className="av mac">⌘</span>}
          {on.slice(0, 5).map((p) => <span key={p.id} className="av" style={{ '--c': colorFor(p.id) } as CSSProperties} title={p.name}>{initial(p.name)}</span>)}
        </span>
        <button className="link" data-invite aria-expanded={inviting} onClick={() => (setInviting(!inviting), setPick([]))}>+ 초대</button>
        <button className={`ib ${sure ? 'danger' : ''}`} data-talk-clear title={sure ? '한 번 더 누르면 이 PC의 대화를 지워요' : '대화 지우기 (이 PC만)'} aria-label="대화 지우기" onClick={clear}><Ico k="x" /></button>
      </header>
      {inviting && (
        <div className="inv" data-inv>
          <small>초대할 사람 — 톡 사람들과 서로 등록돼요 (켜져 있어야 해요)</small>
          {people.length === 0 && <small>먼저 패널의 + 사람 추가로 등록해 주세요</small>}
          {people.map((p) => (
            <label key={p.id} className={online(p.id) ? '' : 'off'}>
              <input type="checkbox" data-inv-pk={p.id} disabled={!online(p.id)} checked={pick.includes(p.id)} onChange={(e) => setPick((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))} />
              {p.name}{!online(p.id) && <em> · 꺼져 있음</em>}
            </label>
          ))}
          <button className="btn pri" data-inv-go disabled={!pick.length} onClick={() => (void talkInvite(pick), setInviting(false))}>초대하기</button>
        </div>
      )}
      <div className="list" ref={list} data-talk-list>
        {msgs.length === 0 && <p className="empty">아직 대화가 없어요 · 등록한 사람과 내 맥이 함께 봐요</p>}
        {msgs.map((m, i) => {
          const prev = msgs[i - 1]
          const newDay = !prev || day(prev.at) !== day(m.at)
          const cont = !newDay && prev && prev.from === m.from && m.from !== 'sys' && m.at - prev.at < 5 * 60_000
          return (
            <div key={m.id} className="row">
              {newDay && <div className="day">{day(m.at)}</div>}
              {m.from === 'sys' ? <div className="sys">{m.text}</div> : (
                <div className={`m ${m.from === 'me' ? 'me' : ''} ${cont ? 'cont' : ''}`} data-msg={m.from}>
                  <span className={`av ${m.from === 'mac' ? 'mac' : ''}`} style={{ '--c': colorFor(m.from) } as CSSProperties}>{m.from === 'mac' ? '⌘' : initial(nameOf(m))}</span>
                  <div className="col">
                    <span className="nm">{nameOf(m)}</span>
                    {m.file ? (
                      <div className="file"><i style={{ background: colorOf(m.file.name) }}>{(extOf(m.file.name) || '파일').toUpperCase().slice(0, 4)}</i><div>{m.file.name}<small>{size(m.file.size)} · 선반에 들어갔어요</small></div></div>
                    ) : <div className="b">{m.text}</div>}
                  </div>
                  <time>{hhmm(m.at)}</time>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {off.length > 0 && <div className="hint">{off.map((p) => p.name).join(' · ')}님은 지금 꺼져 있어 받지 못해요</div>}
      <div className="inbox">
        <textarea className="inp" data-talk-in value={text} rows={1} placeholder="메시지 · Enter 보내기" aria-label="메시지"
          style={{ height: Math.min(100, 36 + 20 * (text.split('\n').length - 1)) }}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (e.preventDefault(), send())} />
        <button className="btn pri" data-talk-send disabled={!text.trim()} onClick={send} aria-label="보내기" title="보내기"><Ico k="send" /></button>
      </div>
      <div className="dropover">놓으면 켜진 사람 모두에게 보내요</div>
    </div>
  )
}
