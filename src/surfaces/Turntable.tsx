import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import type { LpRecord } from '../data/types'
import { reducedMotion, Tile } from './Dock'

/* ── 픽셀 아트 스프라이트 ─────────────────────────────────────────────────
   U px 격자에 레이어를 순서대로 칠한 뒤(painter), 같은 색의 가로 run 을 path 1개로 묶는다.
   모듈 로드 시 1회 계산 → 렌더는 색 수만큼의 <path> 뿐. 정적 SVG, 이미지 파일 없음. */
const U = 3 // 1 도트 = 3px
type Hit = (x: number, y: number) => boolean
type Art = { w: number; h: number; paths: [string, string][] }

function sprite(w: number, h: number, layers: [string, Hit][]): Art {
  const g: string[] = Array(w * h).fill('')
  for (const [c, hit] of layers) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (hit(x, y)) g[y * w + x] = c
  const out = new Map<string, string>()
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = g[y * w + x]
      if (!c) continue
      let n = 1
      while (x + n < w && g[y * w + x + n] === c) n++
      out.set(c, (out.get(c) ?? '') + `M${x} ${y}h${n}v1h-${n}z`)
      x += n - 1
    }
  return { w, h, paths: [...out] }
}

// 원/링: 셀 중심 기준 거리. f 로 방향별 음영(dx,dy 는 중심에서의 오프셋)
const ring = (cx: number, cy: number, r0: number, r1: number, f: (dx: number, dy: number, r: number) => boolean = () => true): Hit =>
  (x, y) => {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, r = Math.hypot(dx, dy)
    return r >= r0 && r < r1 && f(dx, dy, r)
  }
const box = (x0: number, y0: number, x1: number, y1: number): Hit => (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1
const lit = (dx: number, dy: number, r: number) => (dx + dy) / r < -0.55 // 왼쪽 위 하이라이트
const shade = (dx: number, dy: number, r: number) => (dx + dy) / r > 0.55 // 오른쪽 아래 그림자
const noise = (x: number, y: number) => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// 3×5 도트 숫자 (33 / 45 스위치)
const FONT: Record<string, string[]> = {
  '3': ['111', '001', '011', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
}
const text = (s: string, ox: number, oy: number): Hit => (x, y) => {
  const i = Math.floor((x - ox) / 4), cx = (x - ox) % 4, cy = y - oy
  return x >= ox && i < s.length && cx < 3 && cy >= 0 && cy < 5 && FONT[s[i]][cy][cx] === '1'
}

// 팔레트 (제한색)
const P = {
  wOut: '#2a170b', wDark: '#43281a', wBase: '#5c3720', wGrain: '#6b4127', wHi: '#93603a',
  g0: '#131417', g1: '#1f2126', g2: '#25282d', g3: '#3a3d45',
  a0: '#5f6672', a1: '#9aa1ac', a2: '#c9ced6', a3: '#eef1f4',
  amber: '#f5a524', amberDim: '#7a4a10',
  v0: '#0b0b0d', v1: '#141519', v2: '#1c1d23', v3: '#2b2d35',
}

// 데크: 80×82 도트 = 240×246px. 플래터 중심 (35,35), 톤암 피벗 (69,13) — CSS 의 .disc/.arm 좌표와 짝
const W = 80, H = 82, PC = 35, PX = 69, PY = 13
const corner = (x: number, y: number) => Math.min(x, W - 1 - x) + Math.min(y, H - 1 - y) < 2
const body: Hit = (x, y) => !corner(x, y)
const plate = box(4, 4, 76, 78)
const PLINTH = sprite(W, H, [
  // 월넛 프레임: 결 + 계단식 하이라이트/그림자 + 하단 디더
  [P.wBase, body],
  [P.wGrain, (x, y) => body(x, y) && noise(Math.floor(x / 7), y) > 0.68],
  [P.wDark, (x, y) => body(x, y) && y >= H - 5 && (x + y) % 2 === 0],
  [P.wHi, (x, y) => body(x, y) && (y === 1 || x === 1) && x < W - 2 && y < H - 2],
  [P.wDark, (x, y) => body(x, y) && (y === H - 2 || x === W - 2) && x > 0 && y > 0],
  [P.wOut, (x, y) => body(x, y) && (x === 0 || y === 0 || x === W - 1 || y === H - 1 || corner(x - 1, y) || corner(x + 1, y) || corner(x, y - 1) || corner(x, y + 1))],
  // 그라파이트 상판 (브러시드: 행 교차) + 안쪽 베벨
  [P.g1, plate],
  [P.g2, (x, y) => plate(x, y) && y % 2 === 0],
  [P.g0, (x, y) => plate(x, y) && (y === 4 || x === 4)],
  [P.g3, (x, y) => plate(x, y) && (y === 77 || x === 75)],
  // 플래터 그림자 → 림(3톤) → 매트
  [P.g0, ring(PC + 1, PC + 1, 0, 31.5)],
  [P.v0, ring(PC, PC, 30, 31)],
  [P.a1, ring(PC, PC, 28, 30)],
  [P.a3, ring(PC, PC, 28, 30, lit)],
  [P.a2, ring(PC, PC, 29, 30, (dx, dy, r) => !shade(dx, dy, r) && !lit(dx, dy, r) && dy < 0)],
  [P.a0, ring(PC, PC, 28, 30, shade)],
  [P.v2, ring(PC, PC, 0, 28)],
  [P.v3, ring(PC, PC, 3, 28, (_dx, _dy, r) => Math.floor(r) % 3 === 0)],
  // 톤암 베어링 + 암 레스트
  [P.v0, ring(PX, PY, 0, 5.5)],
  [P.a1, ring(PX, PY, 0, 4.5)],
  [P.a3, ring(PX, PY, 0, 4.5, lit)],
  [P.a0, ring(PX, PY, 0, 4.5, shade)],
  [P.g1, ring(PX, PY, 0, 2)],
  [P.v0, box(65, 41, 69, 45)],
  [P.a1, box(66, 41, 68, 42)],
  // 컨트롤: 33(눌림·앰버) / 45(알루미늄) 키, LED 하우징, 노브
  [P.v0, box(6, 68, 16, 77)],
  [P.g0, box(7, 69, 16, 77)],
  [P.amber, text('33', 8, 71)],
  [P.v0, box(17, 68, 27, 77)],
  [P.a1, box(17, 68, 26, 76)],
  [P.a3, box(17, 68, 26, 69)],
  [P.a0, box(17, 75, 26, 76)],
  [P.g1, text('45', 18, 70)],
  [P.v0, box(59, 70, 64, 74)],
  [P.amberDim, box(60, 71, 63, 73)],
  [P.v0, ring(70.5, 72.5, 0, 4.5)],
  [P.a1, ring(70.5, 72.5, 0, 3.5)],
  [P.a3, ring(70.5, 72.5, 0, 3.5, lit)],
  [P.a0, ring(70.5, 72.5, 0, 3.5, shade)],
  [P.v0, box(70, 69, 71, 72)],
])

// 레코드: 56×56 도트(168px). 홈은 정수 반지름마다 교차, 트랙 사이 밝은 띠 2개, 가운데 커버색 라벨
const VR = 28
const D = VR * 2 * U
const VINYL = sprite(VR * 2, VR * 2, [
  [P.v1, ring(VR, VR, 0, VR)],
  [P.v2, ring(VR, VR, 11, VR - 1, (_dx, _dy, r) => Math.floor(r) % 2 === 0)],
  [P.v3, ring(VR, VR, 16, 17)],
  [P.v3, ring(VR, VR, 22, 23)],
  [P.v0, ring(VR, VR, VR - 1, VR)],
  [P.v0, ring(VR, VR, 10, 11)],
  // 라벨: --lab(대비 보정된 커버색) + 밝은 도트 테두리로 검은 홈과 분리
  ['color-mix(in oklab, var(--lab) 45%, white)', ring(VR, VR, 9, 10)],
  ['var(--lab)', ring(VR, VR, 0, 9)],
  ['color-mix(in oklab, var(--lab) 62%, white)', ring(VR, VR, 7, 9, lit)],
  ['color-mix(in oklab, var(--lab) 72%, black)', ring(VR, VR, 7, 9, shade)],
])

/* 라벨 대비: 아이콘이 항상 읽히게 커버 휘도로 라벨/잉크를 고른다 (턴테이블·Island 미니 LP 공용).
   어두운 커버 → 밝은 라벨 + 커버색 아이콘, 밝은 커버 → 짙은 아이콘, 그 사이 → 흰 아이콘 */
export function labelVars(cover = '#64748B'): CSSProperties {
  const n = parseInt(cover.slice(1), 16)
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  const [lab, ink] = L < 0.08 ? [`color-mix(in oklab, ${cover} 26%, white)`, cover] : L > 0.3 ? [cover, `color-mix(in oklab, ${cover} 28%, black)`] : [cover, '#fff']
  return { '--c': cover, '--lab': lab, '--ink': ink } as CSSProperties
}

// 서랍 앞판: 80×8 도트, 월넛 + 가운데 알루미늄 손잡이 (플린스와 같은 팔레트)
const FW = 80, FH = 8
const fbody: Hit = (x, y) => !(y === FH - 1 && (x === 0 || x === FW - 1))
const FRONT = sprite(FW, FH, [
  [P.wBase, fbody],
  [P.wGrain, (x, y) => fbody(x, y) && noise(Math.floor(x / 7) + 3, y + 40) > 0.68],
  [P.wHi, (x, y) => y === 1 && x > 0 && x < FW - 1],
  [P.wOut, (x, y) => fbody(x, y) && (y === 0 || y === FH - 1 || x === 0 || x === FW - 1 || (y === FH - 2 && (x === 1 || x === FW - 2)))],
  [P.v0, box(30, 2, 50, 6)],
  [P.a1, box(31, 3, 49, 5)],
  [P.a3, box(31, 3, 49, 4)],
  [P.a0, box(47, 4, 49, 5)],
])
// 정적 반사: 회전하지 않는 도트 하이라이트 쐐기 2개 (홈 1줄 걸러)
const glint = (a0: number, a1: number) => (dx: number, dy: number, r: number) => {
  const a = (Math.atan2(dy, dx) * 180) / Math.PI
  return a >= a0 && a < a1 && Math.floor(r) % 2 === 1
}
const SHEEN = sprite(VR * 2, VR * 2, [
  ['rgba(255,255,255,0.1)', ring(VR, VR, 11, VR - 1, glint(-150, -118))],
  ['rgba(255,255,255,0.07)', ring(VR, VR, 11, VR - 1, glint(30, 52))],
])

// 톤암: 12×60 도트, 피벗 (6,10). 카운터웨이트 · 허브 · 크롬 로드 · 헤드셸 + 앰버 카트리지
const ARM = sprite(12, 60, [
  [P.v0, box(2, 0, 10, 8)],
  [P.g1, box(3, 1, 9, 7)],
  [P.g3, box(3, 1, 9, 2)],
  [P.a1, box(3, 4, 9, 5)],
  [P.v0, ring(6, 10, 0, 3.5)],
  [P.a2, ring(6, 10, 0, 2.5)],
  [P.a3, ring(6, 10, 0, 2.5, lit)],
  [P.v0, box(4, 12, 8, 51)],
  [P.a3, box(5, 12, 6, 51)],
  [P.a1, box(6, 12, 7, 51)],
  [P.v0, box(1, 50, 9, 59)],
  [P.g1, box(2, 51, 8, 58)],
  [P.g3, box(2, 51, 8, 52)],
  [P.a1, box(8, 52, 11, 53)],
  [P.amber, box(3, 55, 7, 56)],
  [P.a2, box(3, 58, 5, 60)],
])

function Sprite({ art, className }: { art: Art; className?: string }) {
  return (
    <svg className={className} viewBox={`0 0 ${art.w} ${art.h}`} width={art.w * U} height={art.h * U} shapeRendering="crispEdges" aria-hidden>
      {art.paths.map(([c, d]) => <path key={c} d={d} style={{ fill: c }} />)}
    </svg>
  )
}

// 라벨 = 독 타일과 같은 앱 아이콘(세트는 세트 글리프), 레코드와 함께 회전
const Vinyl = ({ rec }: { rec: LpRecord }) => (
  <>
    <Sprite art={VINYL} />
    <span className="disc-label"><Tile rec={rec} size={44} /></span>
  </>
)

const PERIOD = 1800 // 33⅓rpm = 1.8s/회전
const STEPS = 60 // 회전당 60컷: 60Hz 에서 정확히 2프레임마다 6° — 도트 애니 느낌 + 고른 박자
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'ease-out'

type Props = {
  records: LpRecord[]
  onPlay: (r: LpRecord) => void
  onStop: (r: LpRecord) => void
}

export function Turntable({ records, onPlay, onStop }: Props) {
  const [loaded, setLoaded] = useState<LpRecord | null>(null)
  const [playing, setPlaying] = useState(false)
  const [dragging, setDragging] = useState<LpRecord | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const disc = useRef<HTMLDivElement>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const pt = useRef({ x: 0, y: 0, ox: 0, oy: 0 })
  const frame = useRef(0)
  const spinAnim = useRef<Animation | null>(null)
  const rate = useRef(0)
  const ramp = useRef(0)
  const armTimer = useRef(0)
  const [open, setOpen] = useState(false) // LP 서랍

  useEffect(() => () => (cancelAnimationFrame(frame.current), cancelAnimationFrame(ramp.current), clearTimeout(armTimer.current)), [])

  // Esc 로 서랍 닫기 — 열려 있을 때만 리스너
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [open])

  const ghostAt = (x: number, y: number, s: number) => `translate(${x - pt.current.ox - D / 2}px, ${y - pt.current.oy - D / 2}px) scale(${s})`

  // 고스트 디스크 첫 위치는 렌더 직후, 이후는 rAF 로 ref 직접 갱신
  useLayoutEffect(() => {
    if (dragging) ghost.current!.style.transform = ghostAt(pt.current.x, pt.current.y, 0.42)
  }, [dragging])

  // 회전: steps() WAAPI 무한 회전 1개를 재사용, playbackRate 를 0↔1 로 보간(가속/감속 구간에만 rAF)
  const spin = (to: 0 | 1) => {
    if (reducedMotion()) return
    const a = (spinAnim.current ??= disc.current!.animate([{ transform: 'rotate(0turn)' }, { transform: 'rotate(1turn)' }], {
      duration: PERIOD,
      iterations: Infinity,
      easing: `steps(${STEPS})`,
    }))
    if (to === 1) {
      a.playbackRate = rate.current = Math.max(rate.current, 0.001)
      a.play()
    }
    const from = rate.current, t0 = performance.now(), dur = to ? 1400 : 1700
    cancelAnimationFrame(ramp.current)
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur)
      rate.current = from + (to - from) * (1 - (1 - k) * (1 - k))
      a.playbackRate = Math.max(rate.current, 0.001)
      if (k < 1) ramp.current = requestAnimationFrame(step)
      else if (to === 0) a.pause() // 정지 각도 유지, 이후 프레임 0
    }
    ramp.current = requestAnimationFrame(step)
  }

  const play = (r: LpRecord) => {
    if (loaded && playing) onStop(loaded)
    setLoaded(r)
    setPlaying(true) // 톤암 하강 (CSS transition)
    clearTimeout(armTimer.current)
    armTimer.current = window.setTimeout(() => spin(1), reducedMotion() ? 0 : 620)
    onPlay(r)
  }

  const stop = () => {
    if (!loaded || !playing) return
    setPlaying(false) // 톤암 복귀
    clearTimeout(armTimer.current)
    spin(0)
    onStop(loaded)
  }

  const down = (r: LpRecord, e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const b = root.current!.getBoundingClientRect()
    pt.current = { x: e.clientX, y: e.clientY, ox: b.left, oy: b.top }
    setDragging(r)
  }
  const move = (e: PointerEvent) => {
    if (!dragging) return
    pt.current.x = e.clientX
    pt.current.y = e.clientY
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        ghost.current!.style.transform = ghostAt(pt.current.x, pt.current.y, 0.78)
      })
  }
  const up = (e: PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return
    cancelAnimationFrame(frame.current)
    frame.current = 0
    const g = ghost.current!
    const from = getComputedStyle(g).transform
    const plat = disc.current!.getBoundingClientRect()
    const cx = plat.left + plat.width / 2, cy = plat.top + plat.height / 2
    const near = e.type === 'pointerup' && Math.hypot(e.clientX - cx, e.clientY - cy) < 120
    const r = dragging
    const sleeve = e.currentTarget.getBoundingClientRect()
    const to = near ? ghostAt(cx, cy, 1) : ghostAt(sleeve.left + sleeve.width / 2, sleeve.top + sleeve.height / 2, 0.42)
    const anim = g.animate(
      [{ transform: from }, { transform: to, opacity: near ? 1 : 0 }],
      { duration: near ? 560 : 320, easing: near ? token('--spring-bouncy') : 'ease-in', fill: 'forwards' },
    )
    anim.onfinish = () => {
      setDragging(null)
      if (near) play(r)
    }
  }

  const label = loaded?.kind === 'set' ? loaded.targets?.map((id) => records.find((x) => x.id === id)?.title).filter(Boolean).join(' · ') : loaded?.title

  return (
    <div ref={root} className="turntable" data-playing={playing} data-open={open}>
      <div className="tt-card glass-card">
        <header className="tt-head">
          <span>
            <b>턴테이블</b>
            <small>{playing ? `재생 중 · ${label}` : loaded ? '정지됨' : '서랍에서 LP 를 고르세요'}</small>
          </span>
          <button className="tt-stop" onClick={stop} disabled={!playing} aria-label="정지">
            <svg viewBox="0 0 24 24" shapeRendering="crispEdges"><rect x="7" y="7" width="10" height="10" fill="currentColor" /></svg>
            정지
          </button>
        </header>

        <div className="deck">
          <Sprite art={PLINTH} className="plinth" />
          <i className="tt-led" />
          <div ref={disc} className="disc" style={loaded ? labelVars(loaded.cover) : undefined}>
            {loaded && <Vinyl rec={loaded} />}
          </div>
          {loaded ? <Sprite art={SHEEN} className="sheen" /> : <span className="spindle" />}
          <div className="arm" aria-hidden>
            <Sprite art={ARM} />
          </div>

          {/* 서랍: 정적 클립 상자 안에서 트레이+앞판이 transform 으로만 내려온다 (창은 열린 크기로 고정) */}
          <div className="tt-drawer-clip">
            <div className="tt-drawer">
              <div id="tt-tray" className="tt-tray" role="list" aria-label="LP 서랍" aria-hidden={!open}>
                {records.map((r) => (
                  <button
                    key={r.id}
                    role="listitem"
                    className="sleeve"
                    tabIndex={open ? 0 : -1}
                    data-set={r.kind === 'set'}
                    data-active={loaded?.id === r.id && playing}
                    onPointerDown={(e) => down(r, e)}
                    onPointerMove={move}
                    onPointerUp={up}
                    onPointerCancel={up}
                    onKeyDown={(e) => e.key === 'Enter' && play(r)}
                    aria-label={`${r.title} LP — 끌어서 플래터에 놓기 (Enter 로 재생)`}
                    style={{ '--c': r.cover } as CSSProperties}
                  >
                    <span className="sleeve-cover"><Tile rec={r} size={26} /></span>
                    <span className="sleeve-title">{r.title}</span>
                  </button>
                ))}
              </div>
              <button className="tt-front" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="tt-tray" aria-label={open ? 'LP 서랍 닫기' : 'LP 서랍 열기'}>
                <Sprite art={FRONT} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {dragging && (
        <div ref={ghost} className="ghost-disc" style={{ width: D, height: D, ...labelVars(dragging.cover) }}>
          <Vinyl rec={dragging} />
        </div>
      )}
    </div>
  )
}
