import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { usePresence } from './Dock'

/* ── v2 아스키 아트: 63×22 고정 격자, 직접 그린 장면 4개 ──
   셀 = 토큰. 1글자 = 범례(legend) 키 → [표시 글자, 색]. 2글자 = [색 키][표시 글자] (달·구름·배처럼 그림 그대로 찍을 때).
   tick 은 1.5초마다 몇 칸만 바꾼다 (보일 때만 — 독 접힘/전체화면 닫힘이면 타이머 없음). */
const W = 63
const H = 22
type Grid = string[][]
type Legend = Record<string, [string, string]>
type Made = { grid: Grid; tick: () => void }
export type SceneId = 'xmas' | 'city' | 'autumn' | 'calm'
type Scene = { name: string; bg: string; ink: string; legend: Legend; make: () => Made }

// 결정적 해시(장면 배치용) — 같은 장면은 항상 같은 모양
const hash = (x: number, y: number, s = 0) => {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 982451653)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}
const rnd = (n: number) => Math.floor(Math.random() * n)
const pick = <T,>(a: T[]) => a[rnd(a.length)]
const blank = (): Grid => Array.from({ length: H }, () => Array<string>(W).fill(' '))
/** 그림 찍기: 공백은 투명. key 가 있으면 2글자 토큰(색 키 + 글자) */
const stamp = (g: Grid, x: number, y: number, lines: string[], key = '') =>
  lines.forEach((l, dy) => [...l].forEach((ch, dx) => ch !== ' ' && g[y + dy]?.[x + dx] !== undefined && (g[y + dy][x + dx] = key + ch)))
const sprinkle = (g: Grid, ch: string, n: number, y0: number, y1: number, seed: number) => {
  for (let k = 0; k < n; k++) {
    const x = Math.floor(hash(k, seed) * W), y = y0 + Math.floor(hash(seed, k) * (y1 - y0))
    if (g[y][x] === ' ') g[y][x] = ch
  }
}
const cells = (g: Grid, test: (t: string) => boolean) => {
  const out: [number, number][] = []
  g.forEach((row, y) => row.forEach((t, x) => test(t) && out.push([x, y])))
  return out
}
/** 낙하물(눈송이·잎) 몇 개만 한 칸 아래로 (+좌우 흔들림). 막히거나 바닥이면 onLand */
function fall(g: Grid, kinds: string, n: number, floor: number, onLand: (x: number, y: number, t: string) => void) {
  const ps = cells(g, (t) => kinds.includes(t))
  for (let i = 0; i < n && ps.length; i++) {
    const [x, y] = ps.splice(rnd(ps.length), 1)[0]
    const t = g[y][x], nx = Math.min(W - 1, Math.max(0, x + rnd(3) - 1)), ny = y + 1
    g[y][x] = ' '
    if (ny < floor && g[ny][nx] === ' ') g[ny][nx] = t
    else onLand(nx, y, t)
  }
}

/* 12월: 트리(장식 반짝임) + 눈 */
const xmas: Scene = {
  name: '크리스마스 트리',
  bg: '#0a0f1f',
  ink: '#c7d2fe',
  legend: {
    '^': ['^', '#3fae6a'], '/': ['/', '#2a8a52'], '\\': ['\\', '#2a8a52'],
    '*': ['*', '#ffd84a'], '+': ['+', '#fff6c8'],
    o: ['o', '#ff5468'], '@': ['@', '#ffc23d'], O: ['O', '#62b6ff'],
    f: ['.', '#dfe6ff'], F: ['*', '#ffffff'],
    T: ['|', '#9a6a3a'], p: ['#', '#e2485c'], q: ['#', '#3fae6a'], b: ['', '#ffd84a'],
    g: ['~', '#e9f0ff'], G: ['-', '#9fb0d8'],
  },
  make() {
    const g = blank()
    g[1][31] = '*'
    const widths = [3, 5, 7, 9, 11, 7, 9, 11, 13, 15, 17, 11, 13, 15, 17, 19, 21, 23]
    widths.forEach((w, i) => {
      const y = 2 + i, x0 = 31 - (w - 1) / 2
      g[y][x0] = '/'
      g[y][x0 + w - 1] = '\\'
      for (let x = x0 + 1; x < x0 + w - 1; x++) g[y][x] = (x * 3 + y * 5) % 7 === 0 ? 'o@O'[(x + y) % 3] : '^'
    })
    for (let x = 30; x <= 32; x++) g[20][x] = 'T'
    stamp(g, 23, 20, ['['], 'b'), stamp(g, 26, 20, [']'], 'b'), (g[20][24] = g[20][25] = 'p')
    stamp(g, 35, 20, ['['], 'b'), stamp(g, 39, 20, [']'], 'b'), (g[20][36] = g[20][37] = g[20][38] = 'q')
    for (let x = 0; x < W; x++) g[21][x] = x % 5 === 2 ? 'G' : 'g'
    sprinkle(g, 'f', 30, 0, 20, 7)
    sprinkle(g, 'F', 9, 0, 20, 11)
    const orn = cells(g, (t) => 'o@O'.includes(t))
    return {
      grid: g,
      tick() {
        for (let i = 0; i < 3; i++) {
          const [x, y] = pick(orn)
          g[y][x] = pick(['o', '@', 'O', '+'])
        }
        g[1][31] = Math.random() < 0.35 ? '+' : '*'
        fall(g, 'fF', 7, 21, (_x, _y, t) => {
          const x = rnd(W)
          if (g[0][x] === ' ') g[0][x] = t
        })
      },
    }
  },
}

/* 밤: 빌딩 창문 불이 켜졌다 꺼짐, 안테나 깜빡, 차 한 대 */
const city: Scene = {
  name: '밤의 도시',
  bg: '#070b18',
  ink: '#8b96bd',
  legend: {
    w: ['|', '#4b5a80'], r: ['_', '#5d6c94'],
    L: ['#', '#ffd36e'], C: ['#', '#8fd3ff'], d: ['.', '#26304f'],
    s: ['.', '#7f8bb5'], S: ['+', '#e6ecff'],
    A: ['!', '#ff5a5a'], a: ['!', '#4a2532'],
    m: ['', '#f6e7b0'], e: ['=', '#2c3654'], y: ['-', '#c9a74a'], c: ['', '#ff6b6b'], h: ['', '#fff3b0'],
  },
  make() {
    const g = blank()
    sprinkle(g, 's', 20, 0, 8, 3)
    sprinkle(g, 'S', 3, 0, 6, 5)
    stamp(g, 50, 1, ["  .@@'", " @@'", ' @@', ' @@.', "  '@@."], 'm')
    const B: [number, number, number][] = [[0, 7, 11], [6, 10, 7], [15, 7, 13], [21, 12, 4], [32, 8, 10], [39, 11, 6], [49, 7, 12], [55, 8, 9]]
    for (const [x0, w, top] of B) {
      for (let x = x0; x < x0 + w; x++) g[top][x] = 'r'
      for (let y = top + 1; y <= 19; y++) {
        g[y][x0] = g[y][x0 + w - 1] = 'w'
        for (let x = x0 + 1; x < x0 + w - 1; x++) {
          const k = hash(x, y, 9)
          g[y][x] = (x - x0) % 2 === 0 && (y - top) % 2 === 0 ? (k < 0.38 ? 'L' : k < 0.48 ? 'C' : 'd') : ' '
        }
      }
    }
    g[3][27] = 'w'
    g[2][27] = 'A'
    for (let x = 0; x < W; x++) g[21][x] = x % 6 === 3 ? 'y' : 'e'
    const wins = cells(g, (t) => 'LCd'.includes(t))
    let car = 4
    const CAR = 'o==>'
    return {
      grid: g,
      tick() {
        for (let i = 0; i < 3; i++) {
          const [x, y] = pick(wins)
          g[y][x] = g[y][x] === 'd' ? (Math.random() < 0.8 ? 'L' : 'C') : 'd'
        }
        for (let i = 0; i < 2; i++) {
          const [x, y] = pick(cells(g, (t) => t === 's' || t === 'S'))
          g[y][x] = g[y][x] === 's' && Math.random() < 0.5 ? 'S' : 's'
        }
        g[2][27] = g[2][27] === 'A' ? 'a' : 'A'
        for (let i = 0; i < CAR.length; i++) g[20][(car + i) % W] = ' '
        car = (car + 2) % W
        for (let i = 0; i < CAR.length; i++) g[20][(car + i) % W] = (i === 3 ? 'h' : 'c') + CAR[i]
      },
    }
  },
}

/* 가을: 단풍 나무에서 잎이 떨어져 발치에 쌓임 */
const autumn: Scene = {
  name: '가을 나무',
  bg: '#150e11',
  ink: '#b79a8a',
  legend: {
    R: ['@', '#e2553a'], O: ['%', '#f08a2c'], Y: ['&', '#f5c443'], B: ['@', '#a3352b'],
    T: ['|', '#8a5530'], K: [':', '#5a3520'], '/': ['/', '#8a5530'], '\\': ['\\', '#8a5530'],
    f: ['*', '#f08a2c'], j: [',', '#f5c443'], k: ['*', '#e2553a'],
    p: ['%', '#c86a2a'], P: ['@', '#a3352b'], G: ['_', '#5a3a26'], v: ['v', '#7d6872'], u: ['', '#e8894a'],
  },
  make() {
    const g = blank()
    stamp(g, 5, 2, [' .@@.', '@@@@@@', " '@@'"], 'u')
    stamp(g, 44, 0, ['v    v      v'], '')
    const cx = 31, cy = 7.5, rx = 18, ry = 6.8
    const bottom = Array<number>(W).fill(-1)
    for (let y = 0; y < 15; y++)
      for (let x = 0; x < W; x++) {
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2, k = hash(x, y, 4)
        if (d < 1 - 0.28 * hash(y, x, 2) && k > 0.07) {
          g[y][x] = k < 0.4 ? 'R' : k < 0.7 ? 'O' : k < 0.88 ? 'Y' : 'B'
          bottom[x] = y
        }
      }
    for (let y = 12; y <= 19; y++) (g[y][30] = 'T'), (g[y][31] = 'K'), (g[y][32] = 'T')
    g[13][28] = '\\', g[12][27] = '\\', g[13][34] = '/', g[12][35] = '/'
    g[19][29] = '/', g[19][33] = '\\'
    for (let x = 0; x < W; x++) {
      g[20][x] = 'G'
      if (g[19][x] === ' ' && Math.abs(x - 31) < 16 && hash(x, 19, 6) < 0.3) g[19][x] = hash(x, 1) < 0.6 ? 'p' : 'P'
    }
    const rim = bottom.flatMap((y, x) => (y >= 0 && x > 15 && x < 47 ? [[x, y + 1] as const] : []))
    return {
      grid: g,
      tick() {
        fall(g, 'fjk', 6, 20, (x, y, t) => {
          if (y >= 18 && g[19][x] === ' ') g[19][x] = t === 'k' ? 'P' : 'p'
        })
        for (let i = 0; i < 2; i++) {
          const [x, y] = pick(rim)
          if (g[y][x] === ' ') g[y][x] = pick(['f', 'j', 'k'])
        }
        const pile = cells(g.slice(0, 20), (t) => t === 'p' || t === 'P').filter(([, y]) => y === 19)
        if (pile.length > 26) {
          const [x] = pick(pile)
          g[19][x] = ' '
        }
        // 새 몇 마리가 천천히 왼쪽으로
        for (const [x] of cells(g.slice(0, 1), (t) => t === 'v')) (g[0][x] = ' '), (g[0][(x + W - 1) % W] = 'v')
      },
    }
  },
}

/* 기본: 달 뜬 산과 바다, 구름이 흘러가고 물결이 반짝임 */
const calm: Scene = {
  name: '산과 바다',
  bg: '#0b1626',
  ink: '#8aa0c0',
  legend: {
    '/': ['/', '#5a7aa3'], '\\': ['\\', '#5a7aa3'], '^': ['^', '#e8eef8'], x: ['/', '#e8eef8'], X: ['\\', '#e8eef8'],
    m: ['.', '#2c4262'], h: [',', '#2f5a4e'], H: ['/', '#3f8a6e'], J: ['\\', '#3f8a6e'], Q: ['^', '#4fa483'],
    w: ['~', '#3b6fa8'], W: ['-', '#24476e'], r: ['=', '#f3e9c6'], R: ['-', '#9c9378'],
    s: ['.', '#6f84a8'], S: ['+', '#dfe7f5'], n: ['', '#f3e9c6'], c: ['', '#9fb2cc'], k: ['', '#e9dcc0'], b: ['', '#a0704a'], v: ['v', '#7d8db0'],
  },
  make() {
    const g = blank()
    sprinkle(g, 's', 18, 0, 6, 21)
    sprinkle(g, 'S', 5, 0, 5, 23)
    stamp(g, 44, 2, [' .@@.', '@@@@@@', " '@@'"], 'n')
    stamp(g, 10, 4, ['v  v'], '')
    // 산: 기울기 ±1 삼각형들. 뒤 산(눈 덮인 봉우리) → 앞 언덕 순서로 위쪽 윤곽만 그린다
    const ridge = (peaks: [number, number][], base: number, L: string, R: string, P: string, fill: string, snow = 0) => {
      for (let x = 0; x < W; x++) {
        let top = base + 1, side = 0, peak = 0
        for (const [px, py] of peaks) {
          const y = py + Math.abs(x - px)
          if (y < top) (top = y), (side = Math.sign(x - px)), (peak = py)
        }
        if (top > base) continue
        const cap = top - peak < snow
        g[top][x] = side === 0 ? (snow ? '^' : P) : side < 0 ? (cap ? 'x' : L) : cap ? 'X' : R
        for (let y = top + 1; y <= base; y++) g[y][x] = hash(x, y, 31) < 0.22 ? fill : ' '
      }
    }
    ridge([[9, 6], [24, 3], [41, 5], [56, 7]], 12, '/', '\\', '^', 'm', 2)
    ridge([[3, 10], [17, 9], [33, 10], [50, 9], [62, 10]], 12, 'H', 'J', 'Q', 'h')
    for (let y = 13; y < H; y++) for (let x = 0; x < W; x++) g[y][x] = Math.abs(x - 46) <= 1 + (y - 13) / 4 ? (hash(x, y) < 0.6 ? 'r' : 'R') : hash(x, y, 8) < 0.3 ? 'w' : hash(x, y, 9) < 0.3 ? 'W' : ' '
    stamp(g, 15, 14, ['  |\\', '  | \\'], 'k')
    stamp(g, 14, 16, ['\\_____/'], 'b')
    const sea = cells(g, (t) => t === 'w' || t === 'W')
    const glint = cells(g, (t) => t === 'r' || t === 'R')
    const CLOUD = ['  .--.', '.(    ).', "'-.__.-'"]
    let cloud = 20, n = 0
    stamp(g, cloud, 0, CLOUD, 'c')
    return {
      grid: g,
      tick() {
        for (let i = 0; i < 6; i++) {
          const [x, y] = pick(sea)
          g[y][x] = g[y][x] === 'w' ? 'W' : 'w'
        }
        for (let i = 0; i < 3; i++) {
          const [x, y] = pick(glint)
          g[y][x] = g[y][x] === 'r' ? 'R' : 'r'
        }
        if (++n % 2) return
        for (let y = 0; y < 3; y++) for (let x = 0; x < W; x++) if (g[y][x][0] === 'c' && g[y][x].length === 2) g[y][x] = ' '
        cloud = cloud >= W ? -8 : cloud + 1
        stamp(g, cloud, 0, CLOUD, 'c')
      },
    }
  },
}

export const SCENES: Record<SceneId, Scene> = { xmas, city, autumn, calm }

const SEASON = ['겨울', '겨울', '봄', '봄', '봄', '여름', '여름', '여름', '가을', '가을', '가을', '겨울']
export const seasonOf = (d: Date) => SEASON[d.getMonth()]
export const isNight = (d: Date) => d.getHours() >= 19 || d.getHours() < 6
/** 계절·시간대 → 장면: 12월 트리 > 밤 도시 > 가을 나무 > 산과 바다 */
export const pickScene = (d: Date): SceneId => (d.getMonth() === 11 ? 'xmas' : isNight(d) ? 'city' : seasonOf(d) === '가을' ? 'autumn' : 'calm')

/** 장면 렌더: 같은 색이 이어지는 칸을 span 하나로 묶는다. live 일 때만 1.5초 tick. */
export function AsciiArt({ id, live }: { id: SceneId; live: boolean }) {
  const sc = SCENES[id]
  const made = useMemo(() => sc.make(), [id])
  const [, render] = useState(0)
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => (made.tick(), render((n) => n + 1)), 1500)
    return () => clearInterval(t)
  }, [live, made])
  const rows = made.grid.map((row, y) => {
    const out: ReactNode[] = []
    let text = '', color = ''
    const flush = () => text && out.push(color ? <span key={out.length} style={{ color }}>{text}</span> : text)
    for (const t of row) {
      const [ch, c] = t === ' ' ? [' ', ''] : t.length === 2 ? [t[1], sc.legend[t[0]]?.[1] ?? sc.ink] : sc.legend[t] ?? [t, sc.ink]
      if (c && c !== color) (flush(), (text = ''), (color = c))
      text += ch
    }
    flush()
    return <div key={y}>{out}</div>
  })
  return <pre className="ascii" aria-hidden style={{ '--bg': sc.bg } as CSSProperties}>{rows}</pre>
}

/** 독 위젯 1칸: 장면을 작게(transform scale). 독이 펼쳐져 있을 때만 움직인다. */
export function AsciiWidget({ id, live, onOpen }: { id: SceneId; live: boolean; onOpen: (r: DOMRect) => void }) {
  const box = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const b = box.current!, pre = b.querySelector('pre')!
    pre.style.transform = `scale(${b.clientWidth / pre.offsetWidth}, ${b.clientHeight / pre.offsetHeight})`
  }, [])
  return (
    <button ref={box} className="dock-slot widget ascii-w" style={{ background: SCENES[id].bg }} onClick={() => onOpen(box.current!.getBoundingClientRect())} aria-label={`아스키 아트 · ${SCENES[id].name} (클릭: 전체화면)`}>
      <AsciiArt id={id} live={live} />
    </button>
  )
}

/** 전체화면: from(위젯 rect) 이 있으면 그 자리에서 확대/그 자리로 축소, 없으면(화면보호기) 부드러운 페이드+약간 축소. */
export function AsciiFull({ open, id, from, saver, caption, onClose }: { open: boolean; id: SceneId; from: DOMRect | null; saver: boolean; caption: string; onClose: () => void }) {
  const p = usePresence<HTMLDivElement>(open)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => (saver || e.key === 'Escape') && close.current()
    // 화면보호기: 마우스가 조금이라도(8px) 움직이면 닫힘 — 열리는 순간의 미세 흔들림은 무시
    let o: [number, number] | null = null
    const move = (e: PointerEvent) => {
      if (!saver) return
      o ??= [e.clientX, e.clientY]
      if (Math.hypot(e.clientX - o[0], e.clientY - o[1]) > 8) close.current()
    }
    addEventListener('keydown', key)
    addEventListener('pointermove', move)
    return () => (removeEventListener('keydown', key), removeEventListener('pointermove', move))
  }, [open, saver])
  if (!p.mounted) return null
  const vw = innerWidth, vh = innerHeight
  const z = from && { '--fx': `${from.left}px`, '--fy': `${from.top}px`, '--sx': from.width / vw, '--sy': from.height / vh, '--r': `${12 / (from.width / vw)}px` }
  return (
    <div
      ref={p.ref}
      className="ascii-full"
      data-zoom={!!z}
      style={{ ...z, '--bg': SCENES[id].bg } as CSSProperties}
      onTransitionEnd={p.onTransitionEnd}
      onClick={onClose}
      role="dialog"
      aria-label={`아스키 아트 전체화면 · ${SCENES[id].name}`}
    >
      <AsciiArt id={id} live={open} />
      <footer>
        <b>{SCENES[id].name}</b> · {caption}
        <small>{saver ? '마우스를 움직이거나 아무 키나 누르면 돌아가요' : 'Esc 또는 클릭으로 닫기'}</small>
      </footer>
    </div>
  )
}
