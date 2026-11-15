import { useEffect, useRef, type CSSProperties } from 'react'
import { reducedMotion, usePresence } from './Dock'

/* ── v2 아스키 아트: 실시간 3D (donut.c 방식) ──
   3D 표면을 점으로 샘플링 → 셀마다 z-버퍼 → 램버트 + 반사광 → 밝기 램프 글자, 재질마다 색 1개 × 밝기 4단.
   멀수록 어두워지는 안개, 반사광 자리는 '@'(하이라이트 색), 바닥에는 부드러운 그림자.
   그리기 = 캔버스 + 글리프 아틀라스(재질×글자×밝기를 한 번만 fillText, 이후 drawImage).
   위젯 40×16 ≤10fps(독이 펼쳐져 있을 때만), 전체화면 = 화면 크기 ≤30fps, 숨기면 루프 없음. 이동 줄이기 = 정지 1프레임. */

const RAMP = ' .,-~:;=!*#$@'
const CH = RAMP + "o'|/\\+%&^_"
const C = (c: string) => CH.indexOf(c)
const NR = RAMP.length - 1
const BRIGHT = [0.36, 0.56, 0.78, 1]
const gl = (mat: number, c: number, b: number) => (mat << 7) | (c << 2) | b

const hash = (x: number, y: number, s = 0) => {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 982451653)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}
const TAU = Math.PI * 2

/** 달 위상 0..1 (0 = 삭, 0.5 = 보름). 기준 삭: 2000-01-06 18:14 UTC, 삭망월 29.530588853일 */
export const moonPhase = (d: Date) => {
  const m = 29.530588853
  const days = (d.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86_400_000
  return (((days % m) + m) % m) / m
}
export const moonName = (f: number) => ['삭', '초승달', '상현달', '차오르는 달', '보름달', '기우는 달', '하현달', '그믐달'][Math.round(f * 8) % 8]

/* ── 래스터: 셀 z-버퍼 + 글리프 id. 카메라는 eye → target (월드 위 = +y) ── */
class Raster {
  cols = 0; rows = 0; cw = 1; ch = 1; F = 1; q = 1
  z = new Float32Array(0)
  g = new Int32Array(0)
  ex = 0; ey = 0; ez = 0
  rx = 1; ry = 0; rz = 0; ux = 0; uy = 1; uz = 0; fx = 0; fy = 0; fz = 1
  lx = 0; ly = 1; lz = 0
  fog = 0.04
  amb = 0.15 // 주변광
  iz = 0

  resize(cols: number, rows: number, cw: number, ch: number) {
    Object.assign(this, { cols, rows, cw, ch, F: (rows * ch) / 2 / Math.tan(0.45), q: rows / 20 })
    this.z = new Float32Array(cols * rows)
    this.g = new Int32Array(cols * rows)
  }
  clear() {
    this.z.fill(0)
    this.g.fill(-1)
  }
  light(x: number, y: number, z: number) {
    const k = 1 / Math.hypot(x, y, z)
    this.lx = x * k; this.ly = y * k; this.lz = z * k
  }
  look(ex: number, ey: number, ez: number, tx: number, ty: number, tz: number) {
    let fx = tx - ex, fy = ty - ey, fz = tz - ez
    let k = 1 / Math.hypot(fx, fy, fz)
    fx *= k; fy *= k; fz *= k
    let rx = fz, rz = -fx
    k = 1 / Math.hypot(rx, rz)
    rx *= k; rz *= k
    Object.assign(this, { ex, ey, ez, fx, fy, fz, rx, ry: 0, rz, ux: fy * rz, uy: fz * rx - fx * rz, uz: -fy * rx })
  }
  /** 월드 점 → 셀 index (화면 밖/카메라 뒤 = -1). this.iz = 1/깊이 */
  proj(px: number, py: number, pz: number) {
    const dx = px - this.ex, dy = py - this.ey, dz = pz - this.ez
    const zc = dx * this.fx + dy * this.fy + dz * this.fz
    if (zc < 0.2) return -1
    const x = dx * this.rx + dy * this.ry + dz * this.rz
    const y = dx * this.ux + dy * this.uy + dz * this.uz
    const cx = Math.floor(this.cols / 2 + (this.F * x) / zc / this.cw)
    const cy = Math.floor(this.rows / 2 - (this.F * y) / zc / this.ch)
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return -1
    this.iz = 1 / zc
    return cy * this.cols + cx
  }
  /** 음영 표면 점: n = 단위 법선, tex = 밝기 가감(질감), sh = 그림자(0..1) */
  surf(px: number, py: number, pz: number, nx: number, ny: number, nz: number, mat: number, tex = 0, sh = 1, gloss = true) {
    const i = this.proj(px, py, pz)
    if (i < 0) return
    const iz = this.iz
    if (iz <= this.z[i]) return
    let vx = this.ex - px, vy = this.ey - py, vz = this.ez - pz
    const d = Math.hypot(vx, vy, vz)
    vx /= d; vy /= d; vz /= d
    if (nx * vx + ny * vy + nz * vz < 0) return // 뒷면
    const ndl = nx * this.lx + ny * this.ly + nz * this.lz
    const fog = Math.exp(-d * this.fog)
    this.z[i] = iz
    if (gloss && ndl > 0 && sh > 0.8 && fog > 0.5) {
      const rdv = (2 * ndl * nx - this.lx) * vx + (2 * ndl * ny - this.ly) * vy + (2 * ndl * nz - this.lz) * vz
      if (rdv > 0.94) return void (this.g[i] = gl(0, rdv > 0.975 ? C('@') : C('$'), 3))
    }
    const lum = Math.min(1, Math.max(0, (this.amb + (1 - this.amb) * Math.max(0, ndl) * sh) * fog + tex))
    this.g[i] = gl(mat, Math.max(1, Math.round(lum * NR)), Math.min(3, Math.floor(lum * 4.4)))
  }
  /** 스스로 빛나는 점(전구·창문·눈송이·잎): 안개만 적용 */
  dot(px: number, py: number, pz: number, mat: number, c: number, b: number) {
    const i = this.proj(px, py, pz)
    if (i < 0) return -1
    const iz = this.iz * 1.002
    if (iz <= this.z[i]) return -1
    this.z[i] = iz
    this.g[i] = gl(mat, c, Math.max(0, Math.min(b, Math.floor(Math.exp(-this.fog / this.iz) * 4.6))))
    return i
  }
  /** 배경(하늘·별·달): 빈 칸에만 */
  scr(cx: number, cy: number, mat: number, c: number, b: number) {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return
    const i = cy * this.cols + cx
    if (this.z[i] === 0) (this.z[i] = 1e-9), (this.g[i] = gl(mat, c, b))
  }
  /** 화면 공간 원판 달 (위상 f): 빈 칸에만 */
  moon(mcx: number, mcy: number, Rpx: number, f: number, mat: number) {
    const k = Math.cos(TAU * f), rc = Math.ceil(Rpx / this.cw) + 1, rr = Math.ceil(Rpx / this.ch) + 1
    for (let y = -rr; y <= rr; y++)
      for (let x = -rc; x <= rc; x++) {
        const u = (x * this.cw) / Rpx, v = (y * this.ch) / Rpx, d2 = u * u + v * v
        if (d2 > 1) continue
        const edge = k * Math.sqrt(1 - v * v)
        const lit = f < 0.5 ? u > edge : u < -edge
        if (!lit) continue
        const lum = 0.72 + 0.28 * Math.sqrt(1 - d2) - (hash(x, y, 77) < 0.2 ? 0.22 : 0) // 가장자리 어둡게 + 바다(크레이터)
        this.scr(Math.round(mcx + x), Math.round(mcy + y), mat, Math.round(lum * NR), lum > 0.8 ? 3 : 2)
      }
  }
  /** 바뀐 칸만 픽셀 버퍼에 타일 복사 → putImageData 1회 (drawImage 수천 번보다 훨씬 싸다) */
  draw(ctx: CanvasRenderingContext2D, A: Atlas, img: ImageData, buf: Uint32Array, prev: Int32Array) {
    const w = A.w, h = A.h, W = this.cols * w, g = this.g
    for (let i = 0; i < g.length; i++) {
      const id = g[i]
      if (id === prev[i]) continue
      prev[i] = id
      const t = id < 0 ? A.empty : A.tile(id), x0 = (i % this.cols) * w, y0 = ((i / this.cols) | 0) * h
      for (let y = 0, s = 0; y < h; y++) for (let x = 0, o = (y0 + y) * W + x0; x < w; x++) buf[o + x] = t[s++]
    }
    ctx.putImageData(img, 0, 0)
  }
}

/** 글리프 타일: 배경색 위에 미리 그린 불투명 픽셀(w×h). 처음 쓰일 때 fillText 1회 */
class Atlas {
  x: CanvasRenderingContext2D
  tiles: (Uint32Array | undefined)[] = []
  empty: Uint32Array
  rgb: number[][]
  constructor(public w: number, public h: number, mats: string[], public bg: string) {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    this.x = c.getContext('2d', { willReadFrequently: true })!
    this.x.font = `${Math.max(3, h * 0.9)}px 'Cascadia Mono', Consolas, monospace`
    this.x.textAlign = 'center'
    this.x.textBaseline = 'middle'
    this.rgb = mats.map((m) => [1, 3, 5].map((i) => parseInt(m.slice(i, i + 2), 16)))
    this.empty = this.paint('', '')
  }
  private paint(ch: string, color: string) {
    this.x.fillStyle = this.bg
    this.x.fillRect(0, 0, this.w, this.h)
    if (ch) (this.x.fillStyle = color), this.x.fillText(ch, this.w / 2, this.h * 0.55)
    return new Uint32Array(this.x.getImageData(0, 0, this.w, this.h).data.buffer)
  }
  tile(id: number) {
    const [r, g, b] = this.rgb[id >> 7], k = BRIGHT[id & 3]
    return (this.tiles[id] ??= this.paint(CH[(id >> 2) & 31], `rgb(${(r * k) | 0},${(g * k) | 0},${(b * k) | 0})`))
  }
}

type Frame = (r: Raster, t: number, dt: number) => void
type Scene = { name: string; bg: string; mats: string[]; make: () => Frame } // mats[0] = 반사광 하이라이트

/** 하늘의 별 (빈 칸, 결정적 배치, 몇 개만 반짝) */
function stars(r: Raster, n: number, maxRow: number, mat: number, t: number) {
  for (let k = 0; k < n; k++) {
    const tw = Math.sin(t * 1.3 + k * 2.7)
    r.scr(Math.floor(hash(k, 1) * r.cols), Math.floor(hash(k, 2) * r.rows * maxRow), mat, C(hash(k, 3) < 0.15 ? '+' : '.'), tw > 0.75 ? 3 : 1)
  }
}
/** 지면 원판 + 부드러운 그림자 (그림자 중심 = 높이 sy 물체를 빛 방향으로 바닥에 투영) */
function ground(r: Raster, R: number, mat: number, sy: number, sr: number, dark = -0.25) {
  const sx = (-r.lx / r.ly) * sy, sz = (-r.lz / r.ly) * sy
  const nr = Math.ceil(13 * r.q)
  for (let i = 1; i <= nr; i++) {
    const rho = (R * i) / nr, nt = Math.ceil(26 * r.q * rho)
    for (let j = 0; j < nt; j++) {
      const th = (j / nt) * TAU, x = rho * Math.cos(th), z = rho * Math.sin(th)
      const sh = Math.min(1, Math.max(0.25, (Math.hypot(x - sx, z - sz) - sr * 0.6) / sr))
      r.surf(x, 0, z, 0, 1, 0, mat, dark + (hash(i, j, 5) < 0.05 ? 0.2 : 0) - (rho / R) * 0.15, sh, false)
    }
  }
}

/* 12월: 회전하는 원뿔 트리 · 줄을 따라 달리는 가랜드 불빛 · 빛살이 반짝이는 별 · 떨어져 트리 아래 쌓이는 선물 상자
   · 가끔 유성 · 땅에 쌓여 가는 눈 · 살짝 흔들리는 카메라. 선물·눈은 GIFT_CYCLE 주기로 눈 속에 가라앉고 다시 시작. */
const GIFT_CYCLE = 42 // s: 떨어짐(~25s) → 쌓인 채 → 34s부터 가라앉음 → 40s 사라짐
// 선물 자리 (트리 기준 좌표): 각도, 반지름, 폭, 색, 아래 선물 index(-1 = 바닥). 아래 선물이 먼저 떨어진다.
const GIFTS: [number, number, number, number, number][] = [
  [0.35, 1.95, 0.56, 0, -1], [1.4, 2.08, 0.46, 1, -1], [2.45, 1.88, 0.6, 2, -1], [3.5, 2.1, 0.44, 3, -1], [4.55, 1.92, 0.52, 0, -1], [5.55, 2.06, 0.48, 2, -1],
  [0.35, 1.95, 0.34, 3, 0], [2.45, 1.88, 0.36, 1, 2],
]
const xmas: Scene = {
  name: '크리스마스 트리',
  bg: '#060a17',
  mats: ['#fffbe6', '#3fae6a', '#8b5a2b', '#dfe8fb', '#ffd84a', '#ff5468', '#62b6ff', '#ffffff', '#8f9bc8', '#b98cff', '#ff9f45'],
  make() {
    const [TREE, TRUNK, SNOW, GOLD, RED, BLUE, WHITE, STAR, PURPLE, ORANGE] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const TIERS = [[1.5, 0.35, 1.75], [1.15, 1.25, 2.55], [0.8, 2.05, 3.25]]
    const BOX = [RED, BLUE, PURPLE, ORANGE], RIB = [GOLD, WHITE, GOLD, RED]
    // 선물 바닥 높이 (쌓인 것은 아래 선물 윗면) · 높이 = 폭 × 0.78
    const base: number[] = []
    GIFTS.forEach(([, , , , under], i) => (base[i] = under < 0 ? 0 : base[under] + GIFTS[under][2] * 0.78))
    let fl: Float32Array | null = null
    const LAND = 220
    const land = new Float32Array(LAND * 2) // 땅에 쌓인 눈송이 (트리 기준 좌표)
    let nLand = 0, landTick = 0, lastCyc = 0

    return (r, t, dt) => {
      const q = r.q, a = t * 0.35, ca = Math.cos(a), sa = Math.sin(a)
      const rot = (x: number, z: number) => [x * ca - z * sa, x * sa + z * ca]
      // 카메라: 아주 천천히 좌우·위아래로 흔들림
      r.look(Math.sin(t * 0.21) * 0.45, 2.2 + Math.sin(t * 0.37) * 0.12, -7.0 + Math.sin(t * 0.15) * 0.25, 0, 1.95, 0)
      r.light(-0.55, 0.75, -0.5)
      r.fog = 0.03
      r.amb = 0.22
      const cyc = t % GIFT_CYCLE
      if (cyc < lastCyc) nLand = 0 // 새 주기: 쌓인 눈도 처음부터
      lastCyc = cyc
      const acc = Math.min(1, cyc / 30) // 쌓인 눈 정도

      // 트리: 원뿔 3단 (법선 = (cos, rb/H, sin) 정규화)
      TIERS.forEach(([rb, y0, y1], ti) => {
        const H = y1 - y0, k = rb / H, nn = 1 / Math.hypot(1, k)
        const nh = Math.ceil(17 * q * H), nt = Math.ceil(34 * q * rb)
        for (let i = 0; i < nh; i++) {
          const h = i / nh, rr = rb * (1 - h), y = y0 + h * H
          for (let j = 0; j < nt; j++) {
            const th = (j / nt) * TAU + a, c = Math.cos(th), s = Math.sin(th)
            r.surf(rr * c, y, rr * s, c * nn, k * nn, s * nn, TREE, (hash(j, i, ti) < 0.22 ? -0.2 : 0) + (h < 0.1 ? 0.08 : 0), 1, false)
          }
        }
        // 나선 가랜드: 금빛 줄 + 전구. 불빛 물결이 줄을 따라 아래→위로 달린다 (pos = 단 + 높이, 트리 전체에서 이어짐)
        const ns = Math.ceil(60 * q * rb), step = Math.max(3, Math.round(ns / 26))
        for (let k2 = 0; k2 < ns; k2++) {
          const h = (k2 / ns) * 0.92, th = h * TAU * 2.2 + ti * 2.1 + a, rr = rb * (1 - h) + 0.06
          const x = rr * Math.cos(th), z = rr * Math.sin(th), y = y0 + h * H
          if ((r.ex - x) * Math.cos(th) + (r.ez - z) * Math.sin(th) < 0) continue
          const ph = ((((ti + h) * 5 - t * 1.6) % 1) + 1) % 1 // 0..1, 작을수록 물결 머리
          if (k2 % step) {
            if (k2 % 2) r.dot(x, y, z, GOLD, C('.'), ph < 0.12 ? 3 : 2)
            continue
          }
          const bi = k2 / step
          r.dot(x, y, z, [RED, GOLD, BLUE][(bi + ti) % 3], C(ph < 0.16 ? '@' : 'o'), ph < 0.16 ? 3 : ph < 0.34 ? 2 : 1)
        }
      })
      // 줄기
      for (let i = 0; i < Math.ceil(6 * q); i++)
        for (let j = 0, nt = Math.ceil(16 * q); j < nt; j++) {
          const th = (j / nt) * TAU + a, c = Math.cos(th), s = Math.sin(th)
          r.surf(0.22 * c, (i / Math.ceil(6 * q)) * 0.4, 0.22 * s, c, 0, s, TRUNK, j % 3 ? 0 : -0.2)
        }

      // 선물: 차례로 떨어져(중력 + 작은 튕김) 쌓이고, 주기 끝에 눈 속으로 가라앉는다. 트리와 같이 돈다.
      const sink = cyc > 34 ? ((cyc - 34) / 6) * 1.4 : 0
      GIFTS.forEach(([ang, rad, w, ci, under], gi) => {
        const t0 = 1.5 + gi * 3, tau = cyc - t0
        if (tau < 0) return
        const hgt = w * 0.78, by0 = base[gi], drop = 6.2 - by0, T = Math.sqrt((2 * drop) / 7)
        let by = by0
        if (tau < T) by = 6.2 - 3.5 * tau * tau
        else if (tau < T + 1) by += 0.22 * w * Math.abs(Math.sin((tau - T) * 9)) * Math.exp(-(tau - T) * 5)
        by -= sink
        if (by + hgt < -0.05) return
        const [cx, cz] = rot(Math.cos(ang) * rad, Math.sin(ang) * rad)
        const yaw = ang * 1.7 + a + (tau < T ? (T - tau) * 2.5 : 0) + (under >= 0 ? 0.5 : 0)
        const cy = Math.cos(yaw), sy = Math.sin(yaw), hw = w / 2
        const mat = BOX[ci], rib = RIB[ci], n = Math.max(2, Math.ceil(w * 11 * q)), nv = Math.max(2, Math.ceil(hgt * 11 * q))
        // 옆면 4개 (리본 띠가 가운데를 세로로), 윗면 (리본 십자 + 쌓인 눈), 매듭
        for (const [lx, lz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = lx * cy - lz * sy, nz = lx * sy + lz * cy, tx = -nz, tz = nx
          for (let i = 0; i <= n; i++) {
            const u = (i / n - 0.5) * w, ribbon = Math.abs(u) < w * 0.09
            for (let j = 0; j <= nv; j++) {
              const py = by + (j / nv) * hgt
              if (py < 0) continue
              r.surf(cx + nx * hw + tx * u, py, cz + nz * hw + tz * u, nx, 0, nz, ribbon ? rib : mat, ribbon ? 0.05 : hash(i, j, gi) < 0.1 ? -0.1 : 0)
            }
          }
        }
        const top = by + hgt
        if (top > 0)
          for (let i = 0; i <= n; i++)
            for (let j = 0; j <= n; j++) {
              const u = (i / n - 0.5) * w, v = (j / n - 0.5) * w, ribbon = Math.abs(u) < w * 0.09 || Math.abs(v) < w * 0.09
              const snow = !ribbon && hash(i, j, 70 + gi) < acc * 0.55
              r.surf(cx + u * cy - v * sy, top, cz + u * sy + v * cy, 0, 1, 0, ribbon ? rib : snow ? SNOW : mat, 0)
            }
        if (top > 0) {
          r.dot(cx, top + 0.07, cz, rib, C('&'), 3)
          if (q > 1.2) for (const s of [-1, 1]) r.dot(cx + s * 0.09 * cy, top + 0.06, cz + s * 0.09 * sy, rib, C('o'), 2)
        }
      })

      // 별: 빛살이 길어졌다 짧아지고, 가끔 대각 빛살까지 번쩍 (화면 공간, 맨 앞)
      const tw = 0.5 + 0.5 * Math.sin(t * 3.1), flash = Math.sin(t * 0.9 + 1) > 0.95
      const si = r.dot(0, 3.42, 0, GOLD, C(flash ? '@' : tw > 0.5 ? '*' : '+'), 3)
      if (si >= 0) {
        const sx = si % r.cols, sy = (si / r.cols) | 0
        const put = (x: number, y: number, c: string, b: number) => {
          if (x < 0 || y < 0 || x >= r.cols || y >= r.rows) return
          const j = y * r.cols + x
          if (r.z[j] < 0.5) (r.z[j] = 0.5), (r.g[j] = gl(GOLD, C(c), b))
        }
        const L = Math.round(q * (0.7 + 1.1 * tw + (flash ? 1.4 : 0)))
        const diag = flash || Math.floor(t * 1.2) % 3 === 0
        for (let d = 1; d <= L; d++) {
          const b = d === 1 ? 3 : d <= L / 2 ? 2 : 1
          put(sx - 2 * d, sy, '-', b), put(sx - 2 * d + 1, sy, '-', b), put(sx + 2 * d, sy, '-', b), put(sx + 2 * d - 1, sy, '-', b)
          put(sx, sy - d, '|', b), put(sx, sy + d, '|', b)
          if (diag && d <= Math.ceil(L * 0.6)) put(sx + 2 * d, sy - d, '/', b), put(sx - 2 * d, sy + d, '/', b), put(sx - 2 * d, sy - d, '\\', b), put(sx + 2 * d, sy + d, '\\', b)
        }
      }

      ground(r, 2.7, SNOW, 1.6, 1.3, -0.42 + 0.24 * acc)
      // 3D 눈: x,y,z,속도,위상. 땅(지름 안)에 닿은 것 3개 중 1개는 그 자리에 쌓인다
      const N = Math.round(30 + 40 * q)
      if (!fl || fl.length !== N * 5) {
        fl = new Float32Array(N * 5)
        for (let k2 = 0; k2 < N; k2++) fl.set([(Math.random() - 0.5) * 9, Math.random() * 5.5, (Math.random() - 0.4) * 7, 0.35 + Math.random() * 0.5, Math.random() * 6], k2 * 5)
      }
      for (let k2 = 0; k2 < N; k2++) {
        const o = k2 * 5
        fl[o + 1] -= fl[o + 3] * dt
        fl[o] += Math.sin(t * 0.8 + fl[o + 4]) * 0.2 * dt
        if (fl[o + 1] < 0) {
          const x = fl[o], z = fl[o + 2]
          if (Math.hypot(x, z) < 2.6 && nLand < LAND && ++landTick % 3 === 0) land.set([x * ca + z * sa, -x * sa + z * ca], 2 * nLand++)
          fl[o + 1] = 5.5
          fl[o] = (Math.random() - 0.5) * 9
        }
        const near = fl[o + 2] < -2
        r.dot(fl[o], fl[o + 1], fl[o + 2], WHITE, C(near ? '*' : '.'), near ? 3 : 2)
      }
      for (let k2 = 0; k2 < nLand; k2++) {
        const [x, z] = rot(land[2 * k2], land[2 * k2 + 1])
        r.dot(x, 0.02, z, WHITE, C(k2 % 4 ? '.' : ','), 2)
      }

      // 유성: 11초마다 한 번, 하늘을 비스듬히 가로지른다 (빈 칸에만, 머리 먼저)
      const P = 11, kk = Math.floor(t / P), ph = t - kk * P
      if (ph < 1.3) {
        const vx = -r.cols * 0.55, vy = r.rows * 0.16
        const hx = r.cols * (0.4 + hash(kk, 3, 9) * 0.55) + vx * ph, hy = r.rows * (0.04 + hash(kk, 4, 9) * 0.16) + vy * ph
        const len = Math.ceil(9 * q), fade = ph > 1 ? 1 : 0
        for (let i = 0; i <= len; i++) {
          const f = i / len
          r.scr(Math.round(hx - vx * f * 0.2), Math.round(hy - vy * f * 0.2), i ? WHITE : GOLD, C(i ? (f < 0.4 ? '-' : '.') : '*'), Math.max(0, (i ? (f < 0.4 ? 2 : 1) : 3) - fade))
        }
      }
      stars(r, Math.round(26 * q), 0.55, STAR, t)
    }
  },
}

/* 밤: 박스 빌딩 블록을 카메라가 천천히 공전, 창문 불이 켜졌다 꺼짐, 달 */
const city: Scene = {
  name: '밤의 도시',
  bg: '#050813',
  mats: ['#eef3ff', '#5a6a94', '#3c4868', '#ffd36e', '#8fd3ff', '#1c2440', '#c9a74a', '#f6e7b0', '#9aa6d6', '#ff5a5a'],
  make() {
    const [WALL, ROOF, WIN, WINC, GROUND, ROAD, MOON, STAR, RED] = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    const S = 2.3
    const B: [number, number, number, number, number][] = [] // cx, cz, w, d, h
    for (let gx = -2; gx < 2; gx++)
      for (let gz = -2; gz < 2; gz++) {
        const k = hash(gx + 9, gz + 9, 1), center = Math.abs(gx + 0.5) + Math.abs(gz + 0.5) < 1.5
        B.push([(gx + 0.5) * S, (gz + 0.5) * S, 1.25 + hash(gx, gz, 2) * 0.5, 1.25 + hash(gz, gx, 3) * 0.5, 1.1 + k ** 1.4 * 3.2 + (center ? 1.6 : 0)])
      }
    const tall = B.reduce((m, b, i) => (b[4] > B[m][4] ? i : m), 0)
    return (r, t) => {
      const ang = t * 0.06 + 0.7
      r.look(Math.cos(ang) * 12, 6.4, Math.sin(ang) * 12, 0, 1.7, 0)
      r.light(-0.45, 0.65, 0.6)
      r.fog = 0.028
      r.amb = 0.34
      const dens = 4.6 * r.q
      B.forEach(([cx, cz, w, d, h], bi) => {
        // 옆면 4개: [법선 x, 법선 z, 면 폭]
        for (const [nx, nz, span] of [[1, 0, d], [-1, 0, d], [0, 1, w], [0, -1, w]] as const) {
          const fx = cx + (nx * w) / 2, fz = cz + (nz * d) / 2
          if ((r.ex - fx) * nx + (r.ez - fz) * nz <= 0) continue
          const nu = Math.ceil(span * dens), nv = Math.ceil(h * dens)
          for (let i = 0; i <= nu; i++) {
            const u = (i / nu) * span, ox = nz ? u - span / 2 : 0, oz = nx ? u - span / 2 : 0
            for (let j = 0; j <= nv; j++) {
              const v = (j / nv) * h, px = fx + ox, pz = fz + oz
              const fu = (u % 0.42) / 0.42, fv = (v % 0.5) / 0.5
              if (fu > 0.22 && fu < 0.78 && fv > 0.3 && fv < 0.82 && v > 0.3 && v < h - 0.25) {
                const wi = Math.floor(u / 0.42), wj = Math.floor(v / 0.5), key = hash(bi * 7 + nx * 3 + nz, wi * 31 + wj)
                if (hash(wi + bi * 17, wj + nz * 5 + nx * 11, Math.floor(t / 2.5 + key * 13)) < 0.4) {
                  r.dot(px + nx * 0.02, v, pz + nz * 0.02, key < 0.18 ? WINC : WIN, C('#'), 3)
                  continue
                }
                r.surf(px, v, pz, nx, 0, nz, WALL, -0.3)
              } else r.surf(px, v, pz, nx, 0, nz, WALL, 0)
            }
          }
        }
        const nu = Math.ceil(w * dens), nd = Math.ceil(d * dens)
        for (let i = 0; i <= nu; i++) for (let j = 0; j <= nd; j++) r.surf(cx - w / 2 + (i / nu) * w, h, cz - d / 2 + (j / nd) * d, 0, 1, 0, ROOF, -0.1)
        if (bi === tall) {
          for (let k = 0; k < 6; k++) r.dot(cx, h + k * 0.12, cz, WALL, C('|'), 2)
          r.dot(cx, h + 0.8, cz, RED, C('!'), Math.sin(t * 4) > 0 ? 3 : 0)
        }
      })
      // 바닥: 블록 사이 도로 (가운데 점선)
      const E = 2 * S + 0.6, n = Math.ceil(2 * E * dens * 0.55)
      for (let i = 0; i <= n; i++)
        for (let j = 0; j <= n; j++) {
          const x = -E + (i / n) * 2 * E, z = -E + (j / n) * 2 * E
          const mx = Math.abs(((x % S) + S) % S - S / 2), mz = Math.abs(((z % S) + S) % S - S / 2)
          const road = mx > 0.95 || mz > 0.95
          if (road && (mx > 1.1 || mz > 1.1) && hash(i, j) < 0.5) r.dot(x, 0, z, ROAD, C('-'), 1)
          else r.surf(x, 0, z, 0, 1, 0, GROUND, road ? -0.05 : -0.18)
        }
      r.moon(r.cols * 0.82, r.rows * 0.17, r.rows * r.ch * 0.08, moonPhase(new Date()), MOON)
      stars(r, Math.round(34 * r.q), 0.45, STAR, t)
    }
  },
}

/* 가을: 회전하는 나무(줄기 + 잎 덩어리 구), 3D로 뒹굴며 떨어지는 잎 */
const autumn: Scene = {
  name: '가을 나무',
  bg: '#120c0e',
  mats: ['#fff1d0', '#7a4b2a', '#e2553a', '#f08a2c', '#f5c443', '#a3352b', '#4a3022'],
  make() {
    const [TRUNK, RED, OR, YEL, DEEP, GROUND] = [1, 2, 3, 4, 5, 6]
    const LEAF = [RED, OR, YEL, DEEP]
    const CL = [[0, 3.25, 0, 1.25, OR], [-1.0, 2.75, 0.25, 0.95, RED], [1.0, 2.85, -0.2, 1.0, YEL], [0.15, 2.95, -0.95, 0.9, DEEP], [-0.25, 3.95, 0.2, 0.85, RED], [0.45, 2.6, 0.85, 0.85, OR], [0.8, 3.6, 0.4, 0.75, YEL]]
    const TUMBLE = [C("'"), C('~'), C(','), C('%'), C('*')]
    const N = 34
    const L = new Float32Array(N * 7) // x y z vy phase spin landed
    const spawn = (o: number) => {
      const th = Math.random() * TAU, rad = 0.4 + Math.random() * 1.4
      L.set([Math.cos(th) * rad, 2.1 + Math.random() * 0.8, Math.sin(th) * rad, 0.45 + Math.random() * 0.4, Math.random() * 6, Math.random() * 5, 0], o)
    }
    for (let k = 0; k < N; k++) spawn(k * 7), (L[k * 7 + 1] = Math.random() * 2.8)
    return (r, t, dt) => {
      r.look(0, 2.5, -7.3, 0, 2.1, 0)
      r.light(-0.5, 0.65, -0.75)
      r.fog = 0.03
      r.amb = 0.3
      const a = t * 0.22, ca = Math.cos(a), sa = Math.sin(a), q = r.q
      CL.forEach(([x0, cy, z0, rad, mat], ci) => {
        const cx = x0 * ca - z0 * sa, cz = x0 * sa + z0 * ca
        const np = Math.ceil(9 * q * rad), nt = np * 2
        for (let i = 0; i < np; i++) {
          const ph = ((i + 0.5) / np) * Math.PI, sp = Math.sin(ph), ny = Math.cos(ph)
          for (let j = 0; j < nt; j++) {
            if (hash(j, i, ci + 9) < 0.06) continue // 잎 사이 틈
            const th = (j / nt) * TAU + a, nx = sp * Math.cos(th), nz = sp * Math.sin(th)
            const bump = rad * (1 + 0.1 * (hash(i, j, ci) - 0.5)), h2 = hash(i + ci, j, 7)
            r.surf(cx + nx * bump, cy + ny * bump, cz + nz * bump, nx, ny, nz, h2 < 0.75 ? mat : LEAF[Math.floor(h2 * 16) % 4], (hash(i, j, ci + 3) - 0.5) * 0.2, 1, hash(j, i, ci + 5) < 0.04)
          }
        }
      })
      // 줄기: 위로 갈수록 가늘어지는 원기둥, 세로 결
      const nh = Math.ceil(10 * q * 2.5), nt = Math.ceil(14 * q)
      for (let i = 0; i < nh; i++) {
        const y = (i / nh) * 2.6, rr = 0.32 - 0.12 * (y / 2.6)
        for (let j = 0; j < nt; j++) {
          const th = (j / nt) * TAU + a, c = Math.cos(th), s = Math.sin(th)
          r.surf(rr * c, y, rr * s, c, 0.05, s, TRUNK, j % 3 ? 0 : -0.2)
        }
      }
      ground(r, 3.2, GROUND, 3.2, 1.7, -0.08)
      // 바닥에 쌓인 잎
      for (let k = 0; k < 46; k++) {
        const th = hash(k, 1, 2) * TAU, rho = 0.45 + hash(k, 2, 2) * 2.4
        r.dot(Math.cos(th) * rho, 0.02, Math.sin(th) * rho, LEAF[k % 4], C(k % 3 ? ',' : '%'), 2)
      }
      // 떨어지는 잎: 흔들리며 회전(글자가 바뀜), 바닥에 닿으면 잠시 머문 뒤 다시
      for (let k = 0; k < N; k++) {
        const o = k * 7
        if (L[o + 6] > 0) {
          if ((L[o + 6] -= dt) <= 0) spawn(o)
        } else {
          L[o + 1] -= L[o + 3] * dt
          L[o] += Math.sin(t * 1.3 + L[o + 4]) * 0.4 * dt
          L[o + 2] += Math.cos(t * 1.1 + L[o + 4]) * 0.3 * dt
          L[o + 5] += dt * 3.2
          if (L[o + 1] <= 0.03) (L[o + 1] = 0.03), (L[o + 6] = 4 + Math.random() * 5)
        }
        r.dot(L[o], L[o + 1], L[o + 2], LEAF[k % 4], L[o + 6] > 0 ? C(',') : TUMBLE[Math.floor(L[o + 5]) % 5], 3)
      }
    }
  },
}

/* 기본: 파도치는 바다 + 먼 산맥 높이장, 카메라가 옆으로 천천히 흐름, 지는 해와 물 위 반짝임.
   높이장은 열(column) 단위 레이 마칭(Comanche 방식)으로 앞→뒤 채우기 — 점 샘플링보다 싸다. */
const calm: Scene = {
  name: '바다와 산',
  bg: '#0b1626',
  mats: ['#fff3d0', '#3b78b8', '#5b7aa0', '#e8eef8', '#ffcf7a', '#9fb2cc'],
  make() {
    const [WATER, MOUNT, SNOWC, SUN, CLOUD] = [1, 2, 3, 4, 5]
    const WR = [C('.'), C('-'), C('~'), C('='), C('*')]
    const MR = [C('.'), C(','), C(':'), C('^'), C('#')]
    return (r, t) => {
      const cols = r.cols, rows = r.rows, camX = t * 0.7, camH = 2.0, hz = rows * 0.42
      const Fc = r.F / r.cw, Fr = r.F / r.ch
      const wave = (x: number, z: number) =>
        0.11 * Math.sin(x * 0.9 + t * 1.2) + 0.08 * Math.sin(z * 1.3 - t * 1.6 + x * 0.3) + 0.06 * Math.sin(x * 2.7 + z * 0.8 + t * 2.1) + 0.05 * Math.sin(x * 4.3 - z * 1.7 - t * 2.6)
      const mount = (x: number, z: number) =>
        z < 38 ? -1 : Math.min(1, (z - 38) / 14) * ((Math.sin(x * 0.08) * 0.5 + 0.5) * 9 + Math.sin(x * 0.23 + 1) * 3 + Math.sin(x * 0.5) * 1.2) - 4
      const height = (x: number, z: number) => Math.max(z < 26 ? wave(x, z) : 0, mount(x, z))
      // 해 방향 (화면 위치에서 역산) — 물 반사 하이라이트용
      const sc = cols * 0.62, sr = hz - rows * 0.08
      let sx = (sc - cols / 2) / Fc, sy = (hz - sr) / Fr, sz = 1
      const sk = 1 / Math.hypot(sx, sy, sz)
      sx *= sk; sy *= sk; sz *= sk
      const yb = new Int32Array(cols).fill(rows)
      for (let c = 0; c < cols; c++) {
        const dir = (c - cols / 2) / Fc
        for (let d = 1.2; d < 110; d *= 1.04) {
          const wx = camX + dir * d, m = mount(wx, d), h = Math.max(d < 26 ? wave(wx, d) : 0, m)
          const y = Math.ceil(hz + ((camH - h) / d) * Fr)
          if (y >= yb[c]) continue
          const e = 0.04 * d, hx = height(wx + e, d) - h, hzz = height(wx, d + e) - h
          let nx = -hx / e, ny = 1, nz = -hzz / e
          const nk = 1 / Math.hypot(nx, ny, nz)
          nx *= nk; ny *= nk; nz *= nk
          const fog = Math.exp(-d * 0.018)
          let id: number
          if (m >= h && m > 0) {
            // 산: 옆빛 램버트, 높은 곳은 눈
            const lum = Math.min(1, (0.3 + 0.7 * Math.max(0, -0.55 * nx + 0.7 * ny - 0.3 * nz)) * Math.exp(-d * 0.007))
            id = gl(h > 6.2 ? SNOWC : MOUNT, MR[Math.min(4, Math.floor(lum * 5))], Math.min(3, Math.floor(lum * 4.4)))
          } else {
            // 물: 시선 반사 · 해 방향 = 반짝임, 나머지는 물결 글자
            let vx = dir * d, vy = h - camH, vz = d
            const vk = 1 / Math.hypot(vx, vy, vz)
            vx *= vk; vy *= vk; vz *= vk
            const vn = vx * nx + vy * ny + vz * nz
            const s = (vx - 2 * vn * nx) * sx + (vy - 2 * vn * ny) * sy + (vz - 2 * vn * nz) * sz
            if (s > 0.992 && fog > 0.3) id = gl(0, C(s > 0.997 ? '@' : '*'), 3)
            else if (s > 0.97) id = gl(SUN, C('~'), 2)
            else {
              // 물결 마루는 밝게, 골은 어둡게 → 대각선으로 흐르는 물결 무늬
              const lum = Math.min(1, (0.12 + 0.88 * Math.min(1, Math.max(0, (h + 0.3) / 0.6)) ** 1.5) * fog)
              id = gl(WATER, WR[Math.min(4, Math.floor(lum * 5))], Math.min(3, Math.floor(lum * 3.8 + 0.3)))
            }
          }
          for (let yy = Math.max(0, y); yy < yb[c]; yy++) {
            const i = yy * cols + c
            r.z[i] = 1 / d
            r.g[i] = id
          }
          yb[c] = Math.max(0, y)
        }
      }
      // 해: 원판 + 번지는 빛, 산 뒤로 걸치면 산이 가린다(빈 칸에만)
      const R = rows * r.ch * 0.07
      for (let y = -12; y <= 12; y++)
        for (let x = -24; x <= 24; x++) {
          const u = (x * r.cw) / R, v = (y * r.ch) / R, d = Math.hypot(u, v)
          if (d < 1) r.scr(Math.round(sc + x), Math.round(sr + y), SUN, C(d < 0.75 ? '@' : '#'), 3)
          else if (d < 2.2 && hash(x, y, 4) < 0.6 - (d - 1) * 0.45) r.scr(Math.round(sc + x), Math.round(sr + y), SUN, C(d < 1.5 ? ':' : '.'), d < 1.5 ? 2 : 1)
        }
      // 구름 띠: 천천히 흐름
      for (let y = Math.floor(rows * 0.06); y < hz - rows * 0.12; y++)
        for (let c = 0; c < cols; c++) {
          const v = Math.sin(c * 0.06 + t * 0.12 + y * 0.9) * Math.sin(c * 0.023 - t * 0.04 + y * 1.7)
          if (v > 0.62) r.scr(c, y, CLOUD, C(v > 0.78 ? '~' : '-'), v > 0.78 ? 1 : 0)
        }
    }
  },
}

export type SceneId = 'xmas' | 'city' | 'autumn' | 'calm'
export const SCENES: Record<SceneId, Scene> = { xmas, city, autumn, calm }

const SEASON = ['겨울', '겨울', '봄', '봄', '봄', '여름', '여름', '여름', '가을', '가을', '가을', '겨울']
export const seasonOf = (d: Date) => SEASON[d.getMonth()]
export const isNight = (d: Date) => d.getHours() >= 19 || d.getHours() < 6
/** 계절·시간대 → 장면: 12월 트리 > 밤 도시 > 가을 나무 > 바다와 산 */
export const pickScene = (d: Date): SceneId => (d.getMonth() === 11 ? 'xmas' : isNight(d) ? 'city' : seasonOf(d) === '가을' ? 'autumn' : 'calm')

/** 렌더 루프. grid = 고정 격자(위젯), 없으면 화면 크기에 맞춤. live=false 거나 이동 줄이기면 1프레임만. */
function AsciiCanvas({ id, live, fps, grid }: { id: SceneId; live: boolean; fps: number; grid?: [number, number] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current!, ctx = cv.getContext('2d')!
    const sc = SCENES[id], frame = sc.make(), r = new Raster()
    let A: Atlas, img: ImageData, buf: Uint32Array, prev: Int32Array
    const size = () => {
      const w = cv.clientWidth, h = cv.clientHeight, k = devicePixelRatio || 1
      const fs = Math.max(11, Math.min(18, Math.min(w / 110, h / 46)))
      const [cols, rows] = grid ?? [Math.floor(w / (fs * 0.62)), Math.floor(h / (fs * 1.2))]
      // 칸 = 정수 픽셀 (캔버스는 CSS 로 박스에 맞게 늘어남)
      const pw = Math.max(1, Math.floor((w * k) / cols)), ph = Math.max(1, Math.floor((h * k) / rows))
      cv.width = cols * pw
      cv.height = rows * ph
      r.resize(cols, rows, w / cols, h / rows)
      A = new Atlas(pw, ph, sc.mats, sc.bg)
      img = ctx.createImageData(cv.width, cv.height)
      buf = new Uint32Array(img.data.buffer)
      prev = new Int32Array(cols * rows).fill(-2)
    }
    const t0 = performance.now()
    let raf = 0, last = 0
    const render = (now: number) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0
      last = now
      r.clear()
      frame(r, (now - t0) / 1000 + 6, dt)
      r.draw(ctx, A, img, buf, prev)
    }
    size()
    render(t0)
    if (!live || reducedMotion()) return
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - last >= 1000 / fps - 3) render(now)
    }
    raf = requestAnimationFrame(loop)
    const onResize = () => (size(), render(performance.now()))
    if (!grid) addEventListener('resize', onResize)
    return () => (cancelAnimationFrame(raf), removeEventListener('resize', onResize))
  }, [id, live])
  return <canvas ref={ref} className="ascii3d" aria-hidden />
}

/** 독 위젯 1칸: 40×16 격자, 독이 펼쳐져 있을 때만 10fps */
export function AsciiWidget({ id, live, onOpen }: { id: SceneId; live: boolean; onOpen: (r: DOMRect) => void }) {
  const box = useRef<HTMLButtonElement>(null)
  return (
    <button ref={box} className="dock-slot widget ascii-w" style={{ background: SCENES[id].bg }} onClick={() => onOpen(box.current!.getBoundingClientRect())} aria-label={`아스키 아트 · ${SCENES[id].name} (클릭: 전체화면)`}>
      <AsciiCanvas id={id} live={live} fps={10} grid={[40, 16]} />
    </button>
  )
}

/** 전체화면: from(위젯 rect) 이 있으면 그 자리에서 확대/그 자리로 축소, 없으면(화면보호기) 부드러운 페이드+약간 축소. */
/** onClosed = 닫힘 애니메이션이 끝남 (실제 앱: 아스키 창 파괴) */
export function AsciiFull({ open, id, from, saver, caption, onClose, onClosed }: { open: boolean; id: SceneId; from: DOMRect | null; saver: boolean; caption: string; onClose: () => void; onClosed?: () => void }) {
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
      onTransitionEnd={(e) => (p.onTransitionEnd(e), e.target === e.currentTarget && e.propertyName === 'opacity' && !open && onClosed?.())}
      onClick={onClose}
      role="dialog"
      aria-label={`아스키 아트 전체화면 · ${SCENES[id].name}`}
    >
      <AsciiCanvas id={id} live={open} fps={30} />
      <footer>
        <b>{SCENES[id].name}</b> · {caption}
        <small>{saver ? '마우스를 움직이거나 아무 키나 누르면 돌아가요' : 'Esc 또는 클릭으로 닫기'}</small>
      </footer>
    </div>
  )
}
