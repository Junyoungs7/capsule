import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { isTauri, linkApply, linkPlan, useValue, type Ambient, type LinkCfg, type LinkMon, type LinkSeg } from '../data/api'

/* ── Hera Link 3b 패널 조각: 모니터 배치 캔버스 · 키 매핑 · 상대 PC 분위기 ── */

const W = 336, H = 176, PAD = 10, SNAP = 10 // 캔버스 크기 · 여백 · 붙는 거리(화면 px)
type At = Record<string, [number, number]>

// 시안(브라우저): 가짜 배치 — PC 두 대 + 맥 두 대
const DEMO: LinkMon[] = [
  { id: 'DISPLAY1', mac: false, rect: [0, 0, 1920, 1080], at: [0, 0, 1920, 1080] },
  { id: 'DISPLAY2', mac: false, rect: [1920, 0, 1920, 1080], at: [1920, 0, 1920, 1080] },
  { id: 'Mac 1', mac: true, rect: [0, 0, 1512, 982], at: [3840, 98, 1512, 982] },
  { id: 'Mac 2', mac: true, rect: [1512, 0, 1920, 1080], at: [5352, 0, 1920, 1080] },
]

/** 모니터마다 끌어 붙이기. PC 모니터는 Windows 배치 그대로(고정), 맥 모니터를 끌어 PC 모니터 가장자리에 붙인다(스냅).
    파란 막대 = 실제로 넘어가는 구간 (Rust 가 엔진 링크로 바꾼 결과 그대로). 표현 못 하는 배치는 아래에 이유. */
export function MonitorCanvas({ connected }: { connected: boolean }) {
  const [plan, setPlan] = useState<{ mons: LinkMon[]; segs: LinkSeg[]; limits: string[] }>({ mons: isTauri ? [] : DEMO, segs: [], limits: [] })
  const [, setLayout] = useValue<{ at: At }>('link.layout', { at: {} })
  const [macMons, setMacMons] = useValue<{ id: string; rect: [number, number, number, number] }[] | null>('link.macMonitors', null)
  const [drag, setDrag] = useState<{ id: string; at: [number, number] } | null>(null)
  const start = useRef<{ x: number; y: number; at: [number, number] } | null>(null)
  const refresh = () => void (isTauri && linkPlan().then(([mons, p]) => setPlan({ mons, segs: p.segs, limits: p.limits })))
  useEffect(refresh, [])

  const mons = plan.mons.map((m) => (drag && m.id === drag.id ? { ...m, at: [drag.at[0], drag.at[1], m.at[2], m.at[3]] as LinkMon['at'] } : m))
  const xs = mons.flatMap((m) => [m.at[0], m.at[0] + m.at[2]]), ys = mons.flatMap((m) => [m.at[1], m.at[1] + m.at[3]])
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)]
  const k = Math.min((W - 2 * PAD) / (Math.max(...xs) - minX || 1), (H - 2 * PAD) / (Math.max(...ys) - minY || 1))
  const h = Math.min(H, Math.ceil((Math.max(...ys) - minY) * k + 2 * PAD) + 24) // 내용 높이에 맞춤 (+끌 여유)
  const px = (x: number) => PAD + (x - minX) * k, py = (y: number) => PAD + (y - minY) * k
  const wins = mons.filter((m) => !m.mac)
  const wb = wins.length ? [Math.min(...wins.map((m) => m.at[0])), Math.min(...wins.map((m) => m.at[1])), Math.max(...wins.map((m) => m.at[0] + m.at[2])), Math.max(...wins.map((m) => m.at[1] + m.at[3]))] : [0, 0, 0, 0]

  // 끌기: 맥 모니터의 가장자리를 PC 모니터 가장자리에 붙인다 (x·y 따로, 가장 가까운 후보)
  const snap = (m: LinkMon, x: number, y: number): [number, number] => {
    const t = SNAP / k
    let bx = x, by = y, dx = t, dy = t
    for (const w of wins) {
      const [wx, wy, ww, wh] = w.at
      for (const cx of [wx + ww, wx - m.at[2], wx, wx + ww - m.at[2]]) if (Math.abs(cx - x) < dx) (dx = Math.abs(cx - x)), (bx = cx)
      for (const cy of [wy + wh, wy - m.at[3], wy, wy + wh - m.at[3]]) if (Math.abs(cy - y) < dy) (dy = Math.abs(cy - y)), (by = cy)
    }
    return [Math.round(bx), Math.round(by)]
  }
  const down = (m: LinkMon, e: PointerEvent) => {
    if (!m.mac) return
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, y: e.clientY, at: [m.at[0], m.at[1]] }
    setDrag({ id: m.id, at: [m.at[0], m.at[1]] })
  }
  const move = (m: LinkMon, e: PointerEvent) => {
    const s = start.current
    if (!s || drag?.id !== m.id) return
    setDrag({ id: m.id, at: snap(m, s.at[0] + (e.clientX - s.x) / k, s.at[1] + (e.clientY - s.y) / k) })
  }
  const up = () => {
    if (!drag) return
    const at: At = Object.fromEntries(plan.mons.filter((m) => m.mac).map((m) => [m.id, [m.at[0], m.at[1]] as [number, number]]))
    at[drag.id] = drag.at
    setLayout({ at })
    setPlan((p) => ({ ...p, mons: mons }))
    setDrag(null)
    start.current = null
    // store 쓰기 → 엔진이 링크 다시 만들고 → 결과(구간·제약) 다시 받기
    if (isTauri) window.setTimeout(() => (void linkApply(), refresh()), 300)
  }
  // 파란 막대: PC 경계 상자 가장자리의 % 구간 → 캔버스
  const bar = (g: LinkSeg) => {
    const [a, b] = g.win.map((v) => v / 100)
    const vert = g.side === 'left' || g.side === 'right'
    const len = vert ? wb[3] - wb[1] : wb[2] - wb[0]
    const s0 = (vert ? wb[1] : wb[0]) + a * len, s1 = (vert ? wb[1] : wb[0]) + b * len
    const edge = { left: wb[0], right: wb[2], up: wb[1], down: wb[3] }[g.side]
    return vert ? { left: px(edge) - 2, top: py(s0), width: 4, height: (s1 - s0) * k } : { left: px(s0), top: py(edge) - 2, width: (s1 - s0) * k, height: 4 }
  }

  const macs = macMons ?? plan.mons.filter((m) => m.mac).map((m) => ({ id: m.id, rect: m.rect }))
  return (
    <div className="mon-wrap">
      <div className="mon-canvas" style={{ width: W, height: h }}>
        {mons.map((m) => (
          <div
            key={m.id}
            className="mon"
            data-mac={m.mac}
            data-drag={drag?.id === m.id}
            style={{ left: px(m.at[0]), top: py(m.at[1]), width: m.at[2] * k, height: m.at[3] * k }}
            onPointerDown={(e) => down(m, e)}
            onPointerMove={(e) => move(m, e)}
            onPointerUp={up}
            title={`${m.mac ? '맥' : 'PC'} · ${m.id} · ${Math.round(m.rect[2])}×${Math.round(m.rect[3])}`}
          >
            <span>{m.mac ? '' : ''}{m.id.replace(/^DISPLAY/, 'PC ')}</span>
          </div>
        ))}
        {!drag && plan.segs.map((g, i) => <i key={i} className="mon-link" style={bar(g)} />)}
      </div>
      <small className="mon-hint">PC 모니터는 Windows 배치 그대로 · 맥 모니터를 끌어 붙이면 맞닿은 구간(파란 선)만 넘어가요</small>
      {plan.limits.map((l, i) => <small key={i} className="mon-limit">⚠ {l}</small>)}
      {!connected && (
        <div className="mon-sizes">
          <small>맥이 연결되면 실제 모니터로 바뀌어요 · 지금은 크기만 정해 두기</small>
          {macs.map((m, i) => (
            <label key={m.id}>
              {m.id}
              <input type="number" value={m.rect[2]} onChange={(e) => setMacMons(macs.map((x, j) => (j === i ? { ...x, rect: [x.rect[0], x.rect[1], Number(e.target.value) || 1, x.rect[3]] } : x)))} aria-label={`${m.id} 너비`} />×
              <input type="number" value={m.rect[3]} onChange={(e) => setMacMons(macs.map((x, j) => (j === i ? { ...x, rect: [x.rect[0], x.rect[1], x.rect[2], Number(e.target.value) || 1] } : x)))} aria-label={`${m.id} 높이`} />
            </label>
          ))}
          <button onClick={() => isTauri && window.setTimeout(() => (void linkApply(), refresh()), 300)}>반영</button>
        </div>
      )}
    </div>
  )
}

/* ── 키 매핑 ── */
const MODS = ['ctrl', 'super', 'alt', 'altgr', 'shift', 'meta'] as const
type Mod = (typeof MODS)[number]
export const WIN_LABEL: Record<Mod, string> = { ctrl: 'Ctrl', super: 'Win', alt: 'Alt', altgr: 'AltGr', shift: 'Shift', meta: 'Meta' }
export const MAC_LABEL: Record<string, string> = { ctrl: '⌃ Control', super: '⌘ Command', alt: '⌥ Option', altgr: '⌥ 오른쪽', shift: '⇧ Shift', meta: 'Meta', none: '없음' }
export const PRESETS = [
  ['habit', '윈도우 습관대로', 'Ctrl = ⌘, Win = Ctrl — Ctrl+C/V/Z 가 맥에서도 그대로'],
  ['position', '키 위치대로', 'Win = ⌘, Alt = ⌥ (엔진 기본)'],
  ['shortcuts', '단축키만 바꾸기', 'Ctrl+C/V/X/Z/A/S/F/T/W/R/L/Q 만 ⌘ 로 (맥 Hera 가 처리), 나머지 Ctrl 은 Ctrl'],
  ['custom', '직접 정하기', '수식키마다 맥에서 어떤 키로 쓸지'],
] as const

/** Rust link::modifiers 와 같은 규칙 (미리보기용) */
export function mapped(c: Pick<LinkCfg, 'keymap' | 'keyRows'>): Record<Mod, string> {
  const m = Object.fromEntries(MODS.map((x) => [x, x])) as Record<Mod, string>
  if (c.keymap === 'habit') (m.ctrl = 'super'), (m.super = 'ctrl')
  if (c.keymap === 'custom') for (const [f, t] of c.keyRows ?? []) if ((MODS as readonly string[]).includes(f)) m[f as Mod] = t
  return m
}
const fromKey = (k: string): Mod | null => ({ Control: 'ctrl', Shift: 'shift', Alt: 'alt', AltGraph: 'altgr', Meta: 'super', OS: 'super' } as Record<string, Mod>)[k] ?? null

/** (a6) '직접 정하기' 줄: 왼쪽 = 누른 수식키, 오른쪽 = 맥에서 쓸 키 */
export function KeyRows({ c, put }: { c: LinkCfg; put: (p: Partial<LinkCfg>) => void }) {
  const [capture, setCapture] = useState<number | null>(null)
  const rows = c.keyRows ?? []
  useEffect(() => {
    if (capture === null) return
    const on = (e: KeyboardEvent) => {
      e.preventDefault()
      const m = fromKey(e.key)
      if (m) put({ keyRows: rows.map((r, i) => (i === capture ? [m, r[1]] : r)) })
      setCapture(null)
    }
    addEventListener('keydown', on, { once: true })
    return () => removeEventListener('keydown', on)
  }, [capture])
  return (
    <div className="card">
      {rows.map(([from, to], i) => (
        <div key={i} className="srow">
          <button className={`keycap ${capture === i ? 'cap' : ''}`} onClick={() => setCapture(i)} title="누른 수식키로 정하기">{capture === i ? <span>키를 누르세요…</span> : <kbd>{WIN_LABEL[from as Mod] ?? from}</kbd>}</button>
          <span className="tt"><small>→ 맥에서</small></span>
          <span className="sel"><select value={to} onChange={(e) => put({ keyRows: rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)) })} aria-label="맥 키">
            {[...MODS, 'none'].map((x) => <option key={x} value={x}>{MAC_LABEL[x]}</option>)}
          </select></span>
          <button className="btn danger sm" onClick={() => put({ keyRows: rows.filter((_, j) => j !== i) })} aria-label="줄 삭제">삭제</button>
        </div>
      ))}
      <div className="srow"><span className="tt"><small>엔진은 수식키(Ctrl·Win·Alt·AltGr·Shift)만 바꿀 수 있어요</small></span><button className="btn ghost sm" onClick={() => put({ keyRows: [...rows, ['ctrl', 'super']] })}>줄 추가</button></div>
    </div>
  )
}

/* ── 상대 PC 분위기: 아스키 · 화면보호기 · 효과 ── */
export const AMBIENT: [string, Ambient][] = [
  ['아스키', { kind: 'ascii', action: 'start' }],
  ['화면보호기', { kind: 'saver', action: 'start' }],
  ['눈', { kind: 'fx', fx: 'snow', action: 'start' }],
  ['비', { kind: 'fx', fx: 'rain', action: 'start' }],
  ['노을', { kind: 'fx', fx: 'sunset', action: 'start' }],
  ['달·별', { kind: 'fx', fx: 'moon', action: 'start' }],
]
