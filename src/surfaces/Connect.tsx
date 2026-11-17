import { useEffect, useRef, type CSSProperties } from 'react'
import { useValue, type LinkCfg, type LinkStatus } from '../data/api'
import { dropDigits, mergeDigits } from '../motion'
import { Ico, type IcoKey } from './Icons'

/* (a6) 연결 = Hera Link (link.rs + link_files.rs). Hera 는 Deskflow 를 켜거나 끄거나 바꾸지 않는다 — 설정 파일만 읽어 온다.
   아일랜드 '연결' 화면 (한눈에) + 설정 창 '연결' 섹션이 같이 쓰는 조각들. 기기 목록은 여러 대를 그릴 수 있게 (지금은 맥 1대). */

/** Desktop 이 store · Rust 이벤트와 이어 준 Hera Link 묶음 */
export type LinkBundle = {
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
  xfer?: { dir: 'in' | 'out'; name: string; bytes: number; size: number } | null
}
export const LINK_DEFAULT: LinkCfg = { me: '', peer: 'MacBook', side: 'right', port: 24800, tls: true, doubleTap: false, filePort: 24810, keymap: 'habit', keyRows: [], ime: 'hera', autoSaverMin: 0, locator: true }
const SIDE: Record<LinkCfg['side'], string> = { left: '왼쪽', right: '오른쪽', top: '위쪽', bottom: '아래쪽' }

/** 상태 → 점 색 · 칩 글 · 한 줄 요약 */
export function linkLook(b: Pick<LinkBundle, 'on' | 'status' | 'pair' | 'cfg' | 'filesPeer' | 'pairedName'>) {
  const peer = b.status?.peer || b.pairedName || b.cfg?.peer || 'Mac'
  const st = b.status?.state ?? 'off'
  const side = SIDE[b.cfg?.side ?? 'right']
  if (b.pair) return { cls: 'warn', label: '페어링 확인', title: '새 기기가 연결을 요청해요', sub: `${b.pair.name} · 양쪽 숫자를 확인하세요`, peer }
  if (!b.on) return { cls: 'off', label: '꺼짐', title: '연결 꺼짐', sub: '켜면 내 맥과 마우스·키보드·클립보드·파일을 함께 써요', peer }
  if (st === 'connected') return { cls: 'ok', label: '연결됨', title: `${peer} 와 연결됨`, sub: `${side} 가장자리${b.filesPeer ? ' · 클립보드 · 파일 · 할 일 동기화' : ''}`, peer }
  if (st === 'blocked') return { cls: 'warn', label: '대기', title: 'Deskflow 가 실행 중이에요', sub: 'Hera 의 입력 공유는 쉬고 기다려요 (Deskflow 는 건드리지 않아요)', peer }
  if (st === 'error') return { cls: 'bad', label: '문제 있음', title: '연결에 문제가 있어요', sub: b.status?.detail || '설정 → 연결 → 고급을 확인하세요', peer }
  return { cls: 'off', label: '기다리는 중', title: `${peer} 를 기다리는 중`, sub: '다시 켜지면 자동으로 이어져요', peer }
}

/** 함께 쓰기 스위치 (store link.share.<k>, 없으면 켬 — Rust link::shared 와 같은 규칙). input = 연결 켜기 그 자체 */
export type ShareKey = 'input' | 'clip' | 'files' | 'sync' | 'chat' | 'fx'
export const SHARES: [ShareKey, IcoKey, string, string, string][] = [
  ['input', 'mouse', '마우스·키보드', '가장자리로 넘어감', '가장자리로 커서를 밀면 맥으로 넘어가요'],
  ['clip', 'clips', '클립보드', '텍스트 · 양방향', '복사한 텍스트가 양쪽 최근 복사에'],
  ['files', 'file', '파일', '끌어서 보내기', '파일을 캡슐·화면 가장자리로 끌어 놓기 · 받은 파일 → 선반'],
  ['sync', 'sync', '할 일·일정', '개인 항목 동기화', '개인 항목만 · 양쪽에서 고치면 나중에 고친 쪽으로 맞춰요'],
  ['chat', 'chat', '채팅 알림', '커서 있는 PC 에서만', '채팅 알림은 커서가 있는 PC 에서만 펫이 알려요'],
  ['fx', 'spark', '상대 화면 효과', '눈·비·아스키', '맥 화면에 효과·아스키 켜기, 맥이 보낸 효과 받기'],
]
export function useShare(b: Pick<LinkBundle, 'on' | 'setOn'>) {
  const [share, setShare] = useValue<Partial<Record<ShareKey, boolean>>>('link.share', {})
  const get = (k: ShareKey) => (k === 'input' ? b.on : share[k] ?? true)
  const set = (k: ShareKey, v: boolean) => (k === 'input' ? b.setOn(v) : setShare({ ...share, [k]: v }))
  return [get, set] as const
}

/** 6자리 페어링 숫자: 하나씩 떨어지고, '같아요' 면 가운데로 모여 '연결됨' */
export function PairCode({ code, onPair, compact, who }: { code: string; onPair: (ok: boolean) => void; compact?: boolean; who: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => dropDigits(ref.current), [code])
  const digits = [...code].map((d, i) => <span key={i}>{d}</span>)
  const box = <div className="code" ref={ref} data-code={code}>{digits.slice(0, 3)}<i style={{ width: 8 }} />{digits.slice(3)}</div>
  const btns = (
    <div className="row2">
      <button className="btn ghost sm" data-pair="no" onClick={() => onPair(false)}>취소</button>
      <button className="btn sm" data-pair="ok" onClick={() => (ref.current ? mergeDigits(ref.current, () => onPair(true)) : onPair(true))}><Ico k="check" />같아요</button>
    </div>
  )
  return compact ? (
    <div className="pairbox"><small><b style={{ color: 'var(--t1)' }}>{who}</b> 와 연결하려고 해요</small>{box}<small>맥 화면에도 같은 숫자가 떠 있으면 '같아요'</small>{btns}</div>
  ) : (
    <div className="pairpanel">{box}<div className="tt"><b>{who} 와 연결하려고 해요</b><small>숫자 비교 페어링 — 양쪽 화면의 6자리가 같으면 같은 기기예요. 다르면 취소하세요.</small>{btns}</div></div>
  )
}

/** 내 기기 (여러 대를 그릴 수 있게 — 지금은 페어링한 맥 1대) */
export function devicesOf(b: LinkBundle) {
  const look = linkLook(b)
  const name = b.pairedName || (b.status?.state === 'connected' ? look.peer : null)
  return name ? [{ id: 'peer', name, icon: 'laptop' as IcoKey, cls: look.cls === 'ok' ? 'ok' : 'off', label: look.label, sub: b.filesPeer ? `파일 주고받기: ${b.filesPeer}` : b.status?.state === 'connected' ? '입력 공유 중' : '연결 대기' }] : []
}

/** 아일랜드 안 '연결' 화면 — 한눈에 보기. 자세한 것은 설정 → 연결 */
export function ConnectView({ b, onSettings }: { b: LinkBundle; onSettings: (sec: string) => void }) {
  const look = linkLook(b)
  const [get, set] = useShare(b)
  const devs = devicesOf(b)
  const live = b.on && b.status?.state === 'connected'
  const pct = b.xfer ? Math.round((100 * b.xfer.bytes) / Math.max(1, b.xfer.size)) : 0
  return (
    <div className="a6 lnk">
      {b.pair && <PairCode compact code={b.pair.code} who={b.pair.name} onPair={b.onPair} />}
      <div className="sect">내 기기</div>
      {devs.map((d) => (
        <div key={d.id} className={`dev ${d.cls === 'off' ? 'dim' : ''}`}>
          <span className="well md" style={{ '--c': 'var(--teal)' } as CSSProperties}><Ico k={d.icon} /><i className={`sdot ${d.cls}`} /></span>
          <span className="tt"><b>{d.name}</b><small>{d.label} · {d.sub}</small></span>
        </div>
      ))}
      {!devs.length && <div className="dev dim"><span className="tt"><b>페어링한 기기가 없어요</b><small>맥 Hera 에서 이 PC 를 고르면 여기에 숫자가 떠요</small></span></div>}
      {!b.pair && (
        <>
          <div className="sect">함께 쓰는 것 · {look.peer}</div>
          <div className="shares">
            {SHARES.map(([k, i, t, s]) => (
              <button key={k} className={`share ${get(k) && live ? '' : 'off'}`} data-share={k} aria-pressed={get(k)} onClick={() => set(k, !get(k))}>
                <Ico k={i} /><b>{t}</b><small>{!live ? '연결되면 켜져요' : get(k) ? s : '꺼짐'}</small>
              </button>
            ))}
          </div>
        </>
      )}
      {b.xfer && <div className="xfer"><Ico k="upload" /><span>{b.xfer.name} {b.xfer.dir === 'out' ? '→' : '←'} {look.peer}</span><span className="bar"><i style={{ transform: `scaleX(${pct / 100})` }} /></span><span>{pct}%</span></div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button className="btn ghost sm" data-opensec="link" style={{ flex: 1 }} onClick={() => onSettings('link')}><Ico k="settings" />설정에서 자세히</button>
        <button className="btn ghost sm" data-opensec="link:devices" style={{ flex: 1 }} onClick={() => onSettings('link:devices')}><Ico k="plus" />새 기기 연결</button>
      </div>
    </div>
  )
}

/** 아일랜드 화면 머리줄: 상태 칩 + Link 켜기 스위치 */
export function ConnectHead({ b }: { b: LinkBundle }) {
  const look = linkLook(b)
  return (
    <>
      <span className={`chp lchip ${look.cls}`} data-link={look.cls}><i />{look.label}</span>
      <button className={`sw ${b.on ? 'on' : ''}`} data-linkon aria-label="연결 켜기" aria-pressed={b.on} onClick={() => b.setOn(!b.on)} style={{ marginRight: 6 }} />
    </>
  )
}
