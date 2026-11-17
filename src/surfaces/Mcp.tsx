import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri, onEvent, reportHitRects, setClip, useValue } from '../data/api'
import '../styles/mcp.css'

/* AI 연결(MCP) — Rust mcp.rs · hera-mcp.exe (docs/mcp.md). 설정은 store mcp.* 를 Rust 가 호출마다 읽는다. */

type Perms = Record<'read' | 'write' | 'screen' | 'exec' | 'files' | 'clip', boolean>
const PERMS_DEFAULT: Perms = { read: true, write: true, screen: true, exec: false, files: false, clip: false }
const GROUPS: [keyof Perms, string, string][] = [
  ['read', '읽기', '할 일·일정·메모·실행 중 앱 조회'],
  ['write', '쓰기', '할 일·일정·메모 추가·수정·완료 (지울 때는 물어봐요)'],
  ['screen', '화면', '캡슐 알림 띄우기·효과·아스키'],
  ['exec', '실행', '앱·URL 실행, 창 앞으로 가져오기 — 매번 물어봐요'],
  ['files', '파일', '선반·맥으로 보내기 — 매번 물어봐요'],
  ['clip', '클립보드 기록 읽기', '최근 복사한 텍스트 검색'],
]
type LogEntry = { at: number; tool: string; text?: string; group?: string | null; ok: boolean; error?: string | null }

const copy = (t: string) => navigator.clipboard.writeText(t).catch(() => setClip(t))

/** 패널 설정 → "AI 연결(MCP)" */
export function McpSettings() {
  const [on, setOn] = useValue('mcp.enabled', false)
  const [perms, setPerms] = useValue<Perms>('mcp.perms', PERMS_DEFAULT)
  const [always, setAlways] = useValue<string[]>('mcp.always', [])
  const [chip, setChip] = useValue('mcp.chip', true)
  const [exe, setExe] = useState('C:\\Users\\<나>\\AppData\\Local\\Hera\\hera-mcp.exe')
  const [log, setLog] = useState<LogEntry[] | null>(null)
  const [copied, setCopied] = useState('')
  useEffect(() => void (isTauri && invoke<string>('mcp_info').then(setExe)), [])
  const p = { ...PERMS_DEFAULT, ...perms }
  const cmd = `claude mcp add hera -- "${exe}"`
  const desktop = JSON.stringify({ mcpServers: { hera: { command: exe } } }, null, 2)
  const doCopy = (k: string, t: string) => void copy(t).then(() => (setCopied(k), setTimeout(() => setCopied(''), 1500)))
  const showLog = () => void (isTauri ? invoke<LogEntry[]>('mcp_log').then(setLog) : setLog([]))
  return (
    <>
      <h3>AI 연결 (MCP)</h3>
      <label className="row">
        <span className="grow">
          <b>이 PC의 AI 도구가 Hera를 다루게 하기</b>
          <small>Claude Code·Claude Desktop 등 · 이 PC의 내 계정에서만 연결돼요</small>
        </span>
        <input type="checkbox" className="switch" checked={on} onChange={(e) => setOn(e.target.checked)} />
      </label>
      {on && (
        <>
          {GROUPS.map(([k, label, desc]) => (
            <label className="row" key={k}>
              <span className="grow">
                <b>{label}</b>
                <small>{desc}</small>
              </span>
              <input type="checkbox" className="switch" checked={p[k]} onChange={(e) => setPerms({ ...p, [k]: e.target.checked })} />
            </label>
          ))}
          <label className="row">
            <span className="grow">
              <b>캡슐에 "AI · 도구" 표시</b>
              <small>AI가 Hera를 쓸 때마다 잠깐</small>
            </span>
            <input type="checkbox" className="switch" checked={chip} onChange={(e) => setChip(e.target.checked)} />
          </label>
          {always.length > 0 && (
            <div className="row mcp-always">
              <span className="grow">
                <b>항상 허용한 도구</b>
                <small>{always.map((t) => (
                  <button key={t} className="mcp-tag" onClick={() => setAlways(always.filter((x) => x !== t))} title="눌러서 해제">{t} ✕</button>
                ))}</small>
              </span>
            </div>
          )}
          <div className="row mcp-setup">
            <span className="grow">
              <b>Claude Code에 연결</b>
              <code className="mono">{cmd}</code>
            </span>
            <button onClick={() => doCopy('cc', cmd)}>{copied === 'cc' ? '복사됨' : '복사'}</button>
          </div>
          <div className="row mcp-setup">
            <span className="grow">
              <b>Claude Desktop</b>
              <small>설정 → 개발자 → 구성 편집 (claude_desktop_config.json)</small>
              <pre className="mono">{desktop}</pre>
            </span>
            <button onClick={() => doCopy('cd', desktop)}>{copied === 'cd' ? '복사됨' : '복사'}</button>
          </div>
          <div className="row mcp-log">
            <span className="grow">
              <b>최근 AI 호출</b>
              {log === null ? (
                <small>최근 50개 · Hera를 끄면 지워져요</small>
              ) : log.length === 0 ? (
                <small>아직 없어요</small>
              ) : (
                <ul>
                  {log.map((l, i) => (
                    <li key={i} data-ok={l.ok} title={l.error ?? ''}>
                      <span>{new Date(l.at).toLocaleTimeString('ko-KR', { hour12: false })}</span> {l.text ?? l.tool}
                      {l.group ? ` · ${l.group}` : ''}
                      {l.ok ? '' : ` — ${l.error ?? '실패'}`}
                    </li>
                  ))}
                </ul>
              )}
            </span>
            <button onClick={showLog}>{log ? '새로고침' : '보기'}</button>
          </div>
        </>
      )}
    </>
  )
}

type Ask = { id: number; tool: string; text: string; group: string | null; secs: number }
type Call = { tool: string; ko: string; group: string | null; ok: boolean }

/** island 창: AI 확인 카드(허용/거부, 20초 후 Rust 가 거부 처리) + "AI · 도구" 칩 */
export function McpIsland() {
  const [asks, setAsks] = useState<Ask[]>([])
  const [chip, setChip] = useState<(Call & { n: number }) | null>(null)
  const [always, setAlways] = useState(false)
  const chipTimer = useRef(0)
  useEffect(() => {
    if (!isTauri) return
    const offs = [
      onEvent<Ask>('mcp-confirm', (a) => setAsks((q) => [...q, a])),
      onEvent<number>('mcp-confirm-done', (id) => setAsks((q) => q.filter((x) => x.id !== id))),
      onEvent<Call>('mcp-call', (c) => {
        setChip((p) => ({ ...c, n: (p?.n ?? 0) + 1 }))
        clearTimeout(chipTimer.current)
        chipTimer.current = window.setTimeout(() => setChip(null), 2500)
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [])
  const ask = asks[0]
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setAlways(false)
    reportHitRects('mcp', ask && card.current ? [card.current.getBoundingClientRect()] : [])
  }, [ask?.id])
  const answer = (ok: boolean) => {
    if (!ask) return
    void invoke('mcp_confirm', { id: ask.id, ok, always: ok && always })
    setAsks((q) => q.filter((x) => x.id !== ask.id))
  }
  if (!isTauri) return null
  return (
    <>
      {ask && (
        <div ref={card} key={ask.id} className="mcp-ask alert" role="alertdialog" aria-label="AI 요청 확인" style={{ '--secs': `${ask.secs}s` } as CSSProperties}>
          <div className="head">
            <span className="bell" />
            <small>AI 요청{ask.group ? ` · ${ask.group}` : ''}</small>
          </div>
          <b>AI가 '{ask.text}'을(를) 하려고 해요</b>
          <div className="actions">
            <label className="mcp-always-tick">
              <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} /> 항상 허용
            </label>
            <button onClick={() => answer(false)}>거부</button>
            <button className="primary" onClick={() => answer(true)}>허용</button>
          </div>
          <span className="mcp-timer" />
        </div>
      )}
      {chip && !ask && (
        <div key={chip.n} className="mcp-chip" data-ok={chip.ok}>
          AI · {chip.ko}
          {chip.group ? ` · ${chip.group}` : ''}
        </div>
      )}
    </>
  )
}
