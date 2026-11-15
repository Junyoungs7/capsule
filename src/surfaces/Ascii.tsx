import { useEffect, useRef, type CSSProperties } from 'react'
import { reducedMotion, usePresence } from './Dock'

/* ── v2 아스키 아트: 글자로 짠 3D ──
   물체 표면을 여러 나라 말 문구로 덮는다. 카메라는 수평이라 화면의 한 줄 = 물체의 한 높이 →
   줄마다 표면 단면을 1D z-버퍼(칸 = 몇 px)에 래스터화하고, 칸마다 '표면 u 좌표 → 문구 글자 index' 를 적는다.
   글자는 표면에 붙어 같이 돌고, 비스듬한 면에서는 화면 폭이 줄어 저절로 가로로 눌린다(뒷면 글자는 좌우 반전).
   밝기 = 램버트 + 반사광(>1 이면 하이라이트 색) × 깊이, 효과 = 스캔 띠 · 언어 바뀜 물결 · 해독(뒤섞였다 풀림) · 반짝임 · 떨어지는 글자.
   그리기 = fillText(maxWidth = 눌린 폭) + globalAlpha, 글자 색을 1/8 버퍼에 쌓아 흐린 빛 번짐을 'lighter' 로 얹는다.
   위젯 = 회전하는 짧은 단어 고리 ≤10fps(독이 펼쳐져 있을 때만), 전체화면 ≤30fps + HUD, 숨기면 루프 없음, 이동 줄이기 = 정지 1프레임. */

const TAU = Math.PI * 2
const hash = (x: number, y: number, s = 0) => {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 982451653)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

/** 달 위상 0..1 (0 = 삭, 0.5 = 보름). 기준 삭: 2000-01-06 18:14 UTC, 삭망월 29.530588853일 */
export const moonPhase = (d: Date) => {
  const m = 29.530588853
  const days = (d.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86_400_000
  return (((days % m) + m) % m) / m
}
export const moonName = (f: number) => ['삭', '초승달', '상현달', '차오르는 달', '보름달', '기우는 달', '하현달', '그믐달'][Math.round(f * 8) % 8]

const FONT = `'Cascadia Mono', Consolas, 'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans CJK KR', 'Microsoft YaHei', 'Yu Gothic', 'Segoe UI Symbol', monospace`

/* ── 문구 (언어마다 1개) ── */
const LUCK = ['good luck', '행운을 빌어요', 'buena suerte', 'bonne chance', 'viel Glück', 'buona fortuna', 'boa sorte', '幸運を祈る', '祝你好运', '祝你好運', 'удачи', 'powodzenia', 'veel geluk', 'lycka till', 'held og lykke', 'lykke til', 'onnea', 'sok szerencsét', 'hodně štěstí', 'veľa šťastia', 'iyi şanslar', 'καλή τύχη', 'בהצלחה', 'حظا سعيدا', 'chúc may mắn', 'semoga beruntung', 'semoga berjaya', 'bahati njema', 'noroc', 'sretno', 'удачі', 'късмет', 'sėkmės', 'veiksmi', 'edu', 'gangi þér vel', 'pob lwc', 'ádh mór ort', 'bona sort', 'zorte on', 'swerte']
const XMAS = ['Merry Christmas', '메리 크리스마스', 'Joyeux Noël', 'Feliz Navidad', 'Frohe Weihnachten', 'メリークリスマス', '圣诞快乐', '聖誕快樂', 'Buon Natale', 'Feliz Natal', 'Vrolijk kerstfeest', 'God jul', 'Glædelig jul', 'Hyvää joulua', 'Wesołych Świąt', 'С Рождеством', 'Καλά Χριστούγεννα', 'Boldog karácsonyt', 'Veselé Vánoce', 'Mutlu Noeller', 'Crăciun fericit', 'Nollaig Shona', 'Nadolig Llawen', 'Bon Nadal', 'Gleðileg jól', 'Sretan Božić', 'Selamat Hari Natal', 'Maligayang Pasko', 'Chúc mừng Giáng sinh', 'Häid jõule', 'Linksmų Kalėdų', 'Eguberri on']
const GIFT = ['선물', 'gift', 'regalo', 'cadeau', 'Geschenk', 'プレゼント', '礼物', 'подарок', 'presente', 'dono', 'gave', 'lahja', 'prezent', 'δώρο', 'hediye', 'ajándék']
const HOPE = ['hope', '희망', 'espoir', 'esperanza', 'Hoffnung', '希望', 'надежда', 'speranza', 'nadzieja', 'ελπίδα']
const SNOWW = ['눈', 'snow', 'neige', 'nieve', 'Schnee', '雪', 'снег', 'neve', 'sneeuw', 'śnieg', 'lumi', 'hó']
const WISH = ['wish', '소원', 'souhait', 'deseo', 'Wunsch', '願い', '愿望', 'желание', 'desiderio']
const NIGHT = ['good night', '잘 자요', 'bonne nuit', 'おやすみ', '晚安', 'gute Nacht', 'buenas noches', 'buonanotte', 'boa noite', 'спокойной ночи', 'welterusten', 'god natt', 'dobranoc', 'καληνύχτα', 'iyi geceler', 'hyvää yötä', 'jó éjszakát', 'dobrou noc', 'laku noć', 'noapte bună', 'selamat malam', 'magandang gabi', 'chúc ngủ ngon', 'лека нощ', 'oíche mhaith', 'nos da', 'bona nit', 'gabon', 'góða nótt', 'labanakt', 'head ööd']
const MOONW = ['달', 'moon', 'lune', 'luna', '月', 'Mond', 'луна', 'σελήνη', 'maan', 'kuu', 'hold', 'bulan']
const DREAM = ['dream', '꿈', 'rêve', 'sueño', 'Traum', '夢', '梦', 'сон', 'sogno', 'droom']
const AUT = ['가을', 'autumn', 'fall', 'otoño', 'automne', 'Herbst', 'autunno', 'outono', '秋', 'осень', 'jesień', 'herfst', 'höst', 'efterår', 'høst', 'syksy', 'ősz', 'podzim', 'φθινόπωρο', 'sonbahar', 'toamnă', 'jesen', 'musim gugur', 'taglagas', 'mùa thu', 'haust', 'hydref', 'tardor', 'udazkena', 'fómhar', 'ruduo', 'rudens', 'sügis']
const LEAF = ['단풍', 'maple', 'érable', 'Ahorn', '紅葉', '枫叶', 'клён', 'acero', 'arce', 'esdoorn', 'lönn', 'vaher']

/* ── 글자 흐름: 문구를 섞어 4번 이어 붙인 긴 줄. 표면 u(라틴 글자 칸 단위) → 글자 index. 글자마다 실제 폭을 재서(1/4 칸 단위) 한중일도 빈틈 없이 ── */
type Stream = { ch: string[]; wu: Float32Array; word: Int32Array; head: Uint8Array; at: Int32Array; U: number; nz: Int32Array }
let mx: CanvasRenderingContext2D | null = null
let mUnit = 1
const wcache = new Map<string, number>()
function unitsOf(c: string) {
  let w = wcache.get(c)
  if (w === undefined) {
    if (!mx) (mx = document.createElement('canvas').getContext('2d')!), (mx.font = `40px ${FONT}`), (mUnit = mx.measureText('M').width)
    wcache.set(c, (w = Math.min(2, Math.max(0.5, Math.round((mx.measureText(c).width / mUnit) * 4) / 4))))
  }
  return w
}
function mkStream(list: string[], seed: number): Stream {
  const ch: string[] = [], word: number[] = [], head: number[] = []
  let w = 0
  for (let rep = 0; rep < 4; rep++)
    for (const i of list.map((_, i) => i).sort((a, b) => hash(a, rep, seed) - hash(b, rep, seed))) {
      Array.from(list[i].normalize('NFC')).forEach((c, j) => {
        ch.push(c), word.push(w), head.push(j ? 0 : 1)
        if (c === ' ') w++
      })
      ch.push(' '), word.push(w++), head.push(0)
    }
  const at: number[] = []
  ch.forEach((c, i) => {
    for (let u = unitsOf(c) * 4; u > 0; u--) at.push(i) // 1/4 칸마다 글자 index
  })
  const nz = ch.flatMap((c, i) => (c === ' ' ? [] : [i]))
  return { ch, wu: Float32Array.from(ch, unitsOf), word: Int32Array.from(word), head: Uint8Array.from(head), at: Int32Array.from(at), U: at.length, nz: Int32Array.from(nz) }
}

/* ── 줄 래스터: 줄 r × 칸 i. 칸마다 깊이·글자·밝기·재질·흐름·방향(-1 = 뒷면, 좌우 반전) ── */
const LX = -0.47, LY = 0.55, LZ = 0.69 // 빛 (왼쪽 위 앞)
const HX = LX * 0.62, HY = LY * 0.62, HZ = (LZ + 1) * 0.62 // 반사광 half 벡터 (근사 정규화)
const AMB = 0.3, DIF = 0.8
class Rows {
  W = 0; R = 0; cs = 1; lh = 1; uw = 1; S = 1; cx = 0; cy = 0; pw = 0; ph = 0
  z = new Float32Array(0)
  k = new Int32Array(0)
  l = new Float32Array(0)
  m = new Int8Array(0)
  s = new Int8Array(0)
  d = new Int8Array(0)
  st: Stream[] = []
  rp = -1; rcx = 0; rcy = 0; sh0 = 0; sh1 = 0 // 언어 바뀜 물결: 반지름 rp 안 = sh1, 밖 = sh0
  resize(pw: number, ph: number, lh: number, uw: number, cs: number, S: number) {
    const W = Math.ceil(pw / cs), R = Math.floor(ph / lh)
    Object.assign(this, { W, R, cs, lh, uw, S, pw, ph, cx: pw / 2, cy: (R * lh) / 2 })
    for (const [k, T] of [['z', Float32Array], ['k', Int32Array], ['l', Float32Array], ['m', Int8Array], ['s', Int8Array], ['d', Int8Array]] as const) (this as Record<string, unknown>)[k] = new T(W * R)
  }
  clear() {
    this.m.fill(-1)
    this.z.fill(-1e9)
  }
  /** 줄 r 중심의 월드 y / 월드 y 의 (소수) 줄 */
  y(r: number) {
    return (this.cy - (r + 0.5) * this.lh) / this.S
  }
  row(y: number) {
    return (this.cy - y * this.S) / this.lh - 0.5
  }
  /** 줄 r 위 선분 (x px, 깊이, u 글자칸, 밝기). per > 0 = u 를 둘레 per 칸으로 감는다 */
  seg(r: number, x0: number, z0: number, u0: number, l0: number, x1: number, z1: number, u1: number, l1: number, m: number, s: number, off: number, per = 0) {
    if (x1 < x0) [x0, x1, z0, z1, u0, u1, l0, l1] = [x1, x0, z1, z0, u1, u0, l1, l0]
    const cs = this.cs, a = x0 / cs - 0.5, b = x1 / cs - 0.5
    const i0 = Math.max(0, Math.ceil(a)), i1 = Math.min(this.W - 1, Math.floor(b))
    if (i1 < i0) return
    const st = this.st[s], U = st.U, at = st.at, base = r * this.W, inv = b > a ? 1 / (b - a) : 0, dir = u1 >= u0 ? 1 : -1
    const dy = (r + 0.5) * this.lh - this.rcy, rp2 = this.rp * this.rp
    for (let i = i0; i <= i1; i++) {
      const f = (i - a) * inv, z = z0 + (z1 - z0) * f, o = base + i
      if (z <= this.z[o]) continue
      let sh = this.sh1
      if (this.rp >= 0) {
        const dx = i * cs - this.rcx
        if (dx * dx + dy * dy > rp2) sh = this.sh0
      }
      let q = Math.floor((u0 + (u1 - u0) * f) * 4)
      if (per) q = ((q % (per * 4)) + per * 4) % (per * 4)
      q = (q + off + sh) % U
      if (q < 0) q += U
      this.z[o] = z
      this.k[o] = at[q]
      this.l[o] = l0 + (l1 - l0) * f
      this.m[o] = m
      this.s[o] = s
      this.d[o] = dir
    }
  }
}

/* ── 부푼 판(베개) 모양: 2D 마스크 → 거리 변환 → 둥근 두께 h, 앞면 법선. 앞(+z)·뒤(-z) 두 면 ── */
type Shape = { G: number; h: Float32Array; nx: Float32Array; ny: Float32Array; nz: Float32Array; d: Float32Array; lo: Int16Array; hi: Int16Array }
function shape(inside: (x: number, y: number) => boolean, T: number, dr: number, G = 160): Shape {
  const N = G * G, D = new Float32Array(N), c = 2 / G, r2 = Math.SQRT2
  for (let gy = 0; gy < G; gy++)
    for (let gx = 0; gx < G; gx++) D[gy * G + gx] = gx && gy && gx < G - 1 && gy < G - 1 && inside((gx + 0.5) * c - 1, 1 - (gy + 0.5) * c) ? 1e9 : 0
  for (let o = G; o < N - G; o++) if (D[o]) D[o] = Math.min(D[o], D[o - 1] + 1, D[o - G] + 1, D[o - G - 1] + r2, D[o - G + 1] + r2)
  for (let o = N - G - 1; o >= G; o--) if (D[o]) D[o] = Math.min(D[o], D[o + 1] + 1, D[o + G] + 1, D[o + G + 1] + r2, D[o + G - 1] + r2)
  const h = new Float32Array(N), nx = new Float32Array(N), ny = new Float32Array(N), nz = new Float32Array(N), d = new Float32Array(N)
  let mxd = 1
  for (let o = 0; o < N; o++) if (D[o]) (h[o] = T * Math.sqrt(1 - (1 - Math.min(1, ((D[o] - 0.5) * c) / dr)) ** 2)), (mxd = Math.max(mxd, D[o]))
  const lo = new Int16Array(G).fill(G), hi = new Int16Array(G).fill(-1)
  for (let gy = 1; gy < G - 1; gy++)
    for (let gx = 1; gx < G - 1; gx++) {
      const o = gy * G + gx
      if (!h[o]) continue
      const hx = (h[o + 1] - h[o - 1]) / (2 * c), hy = (h[o - G] - h[o + G]) / (2 * c), k = 1 / Math.hypot(hx, hy, 1)
      nx[o] = -hx * k; ny[o] = -hy * k; nz[o] = k; d[o] = D[o] / mxd
      lo[gy] = Math.min(lo[gy], gx); hi[gy] = gx
    }
  return { G, h, nx, ny, nz, d, lo, hi }
}
/** 베개 모양을 (ox, oy) 에 크기 sc, 세로축 회전 th, 세로 눌림 ysc 로 그린다. mat(d = 가장자리 0 … 가운데 1) */
function pillow(R: Rows, sh: Shape, ox: number, oy: number, sc: number, th: number, ysc: number, s: number, mat: (d: number) => number, seed: number, lumMul = 1) {
  const c = Math.cos(th), sn = Math.sin(th), G = sh.G, S = R.S, ppu = S / R.uw
  const r0 = Math.max(0, Math.ceil(R.row(oy + sc * ysc))), r1 = Math.min(R.R - 1, Math.floor(R.row(oy - sc * ysc)))
  for (let r = r0; r <= r1; r++) {
    const v = (R.y(r) - oy) / (sc * ysc)
    if (v <= -1 || v >= 1) continue
    const gy = Math.floor((1 - v) * 0.5 * G), off = Math.floor(hash(Math.round((v * sc * S) / R.lh), seed, 3) * 9999)
    for (let f = 1; f >= -1; f -= 2) {
      let pX = 0, pZ = 0, pu = 0, pl = 0, have = false
      for (let gx = sh.lo[gy]; gx <= sh.hi[gy]; gx++) {
        const o = gy * G + gx, h = sh.h[o]
        if (!h) {
          have = false
          continue
        }
        const x = ((gx + 0.5) / G * 2 - 1) * sc, z = f * h * sc
        const X = R.cx + (ox + x * c + z * sn) * S, Z = -x * sn + z * c
        const n0 = sh.nx[o], n2 = f * sh.nz[o], ny = sh.ny[o], nX = n0 * c + n2 * sn, nZ = -n0 * sn + n2 * c
        const spec = nX * HX + ny * HY + nZ * HZ
        let lum = (AMB + DIF * Math.max(0, nX * LX + ny * LY + nZ * LZ)) * (f < 0 ? 0.62 : 1) * (0.88 + (0.12 * Z) / sc) * lumMul
        if (spec > 0.95) lum += (spec - 0.95) * 9
        const u = x * ppu
        if (have) R.seg(r, pX, pZ, pu, pl, X, Z, u, lum, mat(sh.d[o]), s, off)
        pX = X; pZ = Z; pu = u; pl = lum; have = true
      }
    }
  }
}
/** 세로축 원뿔대 (트리 단·줄기): 보이는 앞쪽 반만, 글자는 둘레에 감김 */
function cone(R: Rows, y0: number, y1: number, rb: number, rt: number, th: number, m: number, s: number, seed: number, lumMul = 1) {
  const S = R.S, ppu = S / R.uw, k = (rb - rt) / (y1 - y0), nn = 1 / Math.hypot(1, k)
  const r0 = Math.max(0, Math.ceil(R.row(y1))), r1 = Math.min(R.R - 1, Math.floor(R.row(y0)))
  for (let r = r0; r <= r1; r++) {
    const y = R.y(r), f = (y - y0) / (y1 - y0), rr = rb + (rt - rb) * f
    if (f < 0 || f > 1 || rr <= 0.003) continue
    const Cu = Math.max(3, Math.round(TAU * rr * ppu)), N = Math.max(6, Math.ceil((rr * S * Math.PI) / (R.cs * 2.5)))
    const off = Math.floor(hash(Math.round(((y - y0) * S) / R.lh), seed, 5) * 9999)
    let pX = 0, pZ = 0, pu = 0, pl = 0
    for (let i = 0; i <= N; i++) {
      const p = -Math.PI / 2 + (Math.PI * i) / N, sp = Math.sin(p), cp = Math.cos(p)
      const X = R.cx + rr * sp * S, Z = rr * cp, u = ((p - th) / TAU) * Cu
      const nX = sp * nn, nY = k * nn, nZ = cp * nn, spec = nX * HX + nY * HY + nZ * HZ
      let lum = (AMB + DIF * Math.max(0, nX * LX + nY * LY + nZ * LZ)) * (0.75 + 0.25 * cp) * lumMul
      if (spec > 0.96) lum += (spec - 0.96) * 8
      if (i) R.seg(r, pX, pZ, pu, pl, X, Z, u, lum, m, s, off, Cu)
      pX = X; pZ = Z; pu = u; pl = lum
    }
  }
}
/** 세로 상자의 줄 r 단면: 중심 (bx, bz), 반폭 hw·hd, 자전 yaw, 전체 회전 th. mat(면, 칸 j, 칸 수) — 같은 재질 칸끼리 묶어 그린다.
    emit[재질] > 0 = 스스로 빛남(그 밝기), < 0 = 조명 × |값| */
function boxRow(R: Rows, r: number, bx: number, bz: number, hw: number, hd: number, yaw: number, th: number, s: number, off: number, lumMul: number, mat: (f: number, j: number, n: number) => number, emit?: number[]) {
  const c = Math.cos(th), sn = Math.sin(th), cy = Math.cos(yaw), sy = Math.sin(yaw), S = R.S, ppu = S / R.uw
  const P = [[-hw, hd], [hw, hd], [hw, -hd], [-hw, -hd]].map(([x, z]) => {
    const wx = bx + x * cy - z * sy, wz = bz + x * sy + z * cy
    return [wx * c + wz * sn, -wx * sn + wz * c]
  })
  const mx0 = (P[0][0] + P[2][0]) / 2, mz0 = (P[0][1] + P[2][1]) / 2
  let ue = 0
  for (let f = 0; f < 4; f++) {
    const [ax, az] = P[f], [bx2, bz2] = P[(f + 1) % 4], len = Math.hypot(bx2 - ax, bz2 - az), n = Math.max(1, Math.round(len * ppu))
    let nX = (bz2 - az) / len, nZ = -(bx2 - ax) / len
    if (nX * ((ax + bx2) / 2 - mx0) + nZ * ((az + bz2) / 2 - mz0) < 0) (nX = -nX), (nZ = -nZ)
    if (nZ > 0) {
      const lit = (AMB + DIF * Math.max(0, nX * LX + nZ * LZ)) * (0.75 + 0.25 * nZ) * lumMul
      for (let j = 0; j < n; ) {
        const m = mat(f, j, n)
        let j1 = j + 1
        while (j1 < n && mat(f, j1, n) === m) j1++
        const e = emit?.[m] ?? 0, lum = e > 0 ? e * lumMul : e < 0 ? -e * lit : lit
        const t0 = j / n, t1 = j1 / n
        R.seg(r, R.cx + (ax + (bx2 - ax) * t0) * S, az + (bz2 - az) * t0, ue + j, lum, R.cx + (ax + (bx2 - ax) * t1) * S, az + (bz2 - az) * t1, ue + j1, lum, m, s, off)
        j = j1
      }
    }
    ue += n
  }
}

/* ── 모양들 ── */
let cloverShape: Shape | null = null
const CLOVER = () =>
  (cloverShape ??= shape((x, y) => {
    for (let s = 0.1; s <= 1; s += 0.03) if (Math.hypot(x - (0.24 * s * s - 0.03 * s), y + 0.93 * s) < 0.034 - 0.01 * s) return true // 줄기
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2 - Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a)
      const qx = (x * ca + y * sa) / 0.31, qy = (-x * sa + y * ca - 0.05) / 0.31 - 1 // 잎 축 = +y, 하트 끝이 가운데
      const k = qx * qx + qy * qy - 1
      if (k * k * k - qx * qx * qy * qy * qy < 0) return true
    }
    return false
  }, 0.15, 0.17))
const MAPLE_R = [
  [0, 0.95], [0.06, 0.8], [0.12, 0.84], [0.15, 0.68], [0.23, 0.73], [0.25, 0.54], [0.31, 0.58], [0.27, 0.4], // 위 잎 오른쪽 톱니
  [0.13, 0.27], // 깊은 골
  [0.3, 0.33], [0.36, 0.45], [0.45, 0.38], [0.56, 0.5], [0.62, 0.39], [0.76, 0.47], [0.9, 0.36], // 옆 잎 윗변 → 끝
  [0.76, 0.24], [0.83, 0.13], [0.64, 0.11], [0.6, 0.0], // 옆 잎 아랫변
  [0.3, -0.03], // 골
  [0.44, -0.15], [0.52, -0.11], [0.58, -0.3], [0.45, -0.31], [0.41, -0.42], [0.27, -0.31], // 아래 잎
  [0.1, -0.29], [0.03, -0.37], [0.035, -0.6], // 잎자루
]
const MAPLE_P = [...MAPLE_R, ...MAPLE_R.map(([x, y]) => [-x, y]).reverse()].map(([x, y]) => [x, y - 0.17])
let mapleShape: Shape | null = null
const MAPLE = () =>
  (mapleShape ??= shape((x, y) => {
    let inside = false // 짝수-홀수 규칙
    for (let i = 0, j = MAPLE_P.length - 1; i < MAPLE_P.length; j = i++) {
      const [xi, yi] = MAPLE_P[i], [xj, yj] = MAPLE_P[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }, 0.12, 0.13, 200))

/* ── 장면 ── */
const T0 = 24 // 장면 시계 시작값: 선물이 몇 개 쌓인 채로 시작, 정지 프레임도 이 시각
type Gly = { m: number; lum: number; k: number; s: number; row: number }
type Over = { put: (c: string, x: number, y: number, m: number, a: number, k?: number) => void; free: (x: number, y: number) => boolean }
type Run = { geo: (R: Rows, t: number, dt: number) => void; over?: (o: Over, R: Rows, t: number, dt: number) => void; tint?: (g: Gly, t: number) => void }
type Fx = { band?: number; ripple?: number; decode?: number; sparkle?: number; fall?: number }
type Scene = { name: string; bg: string; mats: string[]; phrases: string[][]; mini: [string, number][]; fx: Fx; make: () => Run; built?: Stream[] } // mats[0] = 하이라이트

/** 유성: period 초마다 문구 글자가 꼬리를 끌며 하늘을 비스듬히 가로지른다 */
function shoot(o: Over, R: Rows, t: number, st: Stream, m: number, period: number) {
  const k = Math.floor(t / period), ph = t - k * period
  if (ph > 1.6) return
  const vx = -R.pw * 0.5, vy = R.ph * 0.16, hx = R.pw * (0.55 + 0.4 * hash(k, 1, 9)) + vx * ph, hy = R.ph * (0.04 + 0.12 * hash(k, 2, 9)) + vy * ph
  const dl = Math.hypot(vx, vy), fade = ph > 1.2 ? (1.6 - ph) / 0.4 : 1
  for (let i = 0, n = 0; n < 18; i++) {
    const sl = st.ch[(k * 37 + i) % st.ch.length]
    if (sl === ' ') continue
    const d = n * R.uw * 1.15
    o.put(sl, hx - (vx / dl) * d, hy - (vy / dl) * d, n ? m : 0, (1 - n / 18) * fade, n ? 1 : 1.3)
    n++
  }
}

/* 12월: 회전하는 3단 트리(메리 크리스마스) · 반짝이는 금·빨강 장식 단어 · 희망 글자 빛살 별 · 단어로 된 선물 상자가 떨어져 쌓임 · 눈 · 소원 유성 */
const GIFT_CYCLE = 42
const GIFTS: [number, number, number, number, number][] = [
  [0.3, 0.86, 0.27, 0, -1], [1.35, 0.92, 0.22, 1, -1], [2.4, 0.84, 0.3, 2, -1], [3.45, 0.94, 0.2, 3, -1], [4.5, 0.88, 0.26, 0, -1], [5.5, 0.96, 0.23, 2, -1],
  [0.3, 0.86, 0.17, 3, 0], [2.4, 0.84, 0.19, 1, 2],
]
const xmas: Scene = {
  name: '크리스마스 트리',
  bg: '#03060d',
  mats: ['#fffbe6', '#47e07c', '#b07a4a', '#ffd84a', '#ff5468', '#62b6ff', '#eef4ff', '#c49bff', '#cfe0ff'],
  phrases: [XMAS, GIFT, HOPE, SNOWW, WISH],
  mini: [['Noël', 1], ['선물', 4], ['Merry', 3], ['눈', 8], ['gift', 5], ['聖誕', 4], ['hope', 3], ['★', 3]],
  fx: { ripple: 9, decode: 0.05, sparkle: 0.002 },
  make() {
    const [TREE, TRUNK, GOLD, RED, BLUE, WHITE, PURPLE, SNOW] = [1, 2, 3, 4, 5, 6, 7, 8]
    const BOX = [RED, BLUE, PURPLE, WHITE], RIB = [GOLD, WHITE, GOLD, RED], G0 = -0.82
    const base: number[] = []
    GIFTS.forEach(([, , , , under], i) => (base[i] = under < 0 ? G0 : base[under] + GIFTS[under][2] * 0.8))
    const bows: number[] = []
    let fl: Float32Array | null = null
    return {
      geo(R, t) {
        const th = t * 0.45, c = Math.cos(th), sn = Math.sin(th)
        for (const [rb, y0, y1, rt, sd] of [[0.74, -0.66, -0.04, 0.16, 1], [0.58, -0.3, 0.3, 0.1, 2], [0.42, 0.06, 0.62, 0.015, 3]]) cone(R, y0, y1, rb, rt, th, TREE, 0, sd)
        cone(R, G0, -0.6, 0.08, 0.075, th, TRUNK, 0, 9, 0.8)
        // 선물: 차례로 떨어져(중력 + 작은 튕김) 쌓이고, 주기 끝에 사라진다. 트리와 같이 돈다.
        const cyc = t % GIFT_CYCLE, fade = cyc > 36 ? Math.max(0, 1 - (cyc - 36) / 4) : 1
        bows.length = 0
        GIFTS.forEach(([ang, rad, w, ci, under], gi) => {
          const tau = cyc - (1 + gi * 2.6)
          if (tau < 0 || fade <= 0) return
          const hgt = w * 0.8, by0 = base[gi], T = Math.sqrt((2 * (1.3 - by0)) / 3)
          let by = by0
          if (tau < T) by = 1.3 - 1.5 * tau * tau
          else if (tau < T + 1) by += 0.12 * w * Math.abs(Math.sin((tau - T) * 9)) * Math.exp(-(tau - T) * 5)
          const bx = Math.cos(ang) * rad, bz = Math.sin(ang) * rad, yaw = ang * 1.7 + (tau < T ? (T - tau) * 3 : 0) + (under >= 0 ? 0.5 : 0)
          const mid = by + hgt / 2, rib = RIB[ci], box = BOX[ci], band = (R.lh / R.S) * 0.55
          const r0 = Math.max(0, Math.ceil(R.row(by + hgt))), r1 = Math.min(R.R - 1, Math.floor(R.row(by)))
          for (let r = r0; r <= r1; r++) {
            const y = R.y(r), across = Math.abs(y - mid) < band
            boxRow(R, r, bx, bz, w / 2, w / 2, yaw, th, 1, gi * 131 + Math.round(((y - by) * R.S) / R.lh) * 17, fade, (_f, j, n) => (across || Math.abs(j / n - 0.5) < 0.09 ? rib : box))
          }
          bows.push(R.cx + (bx * c + bz * sn) * R.S, R.cy - (by + hgt) * R.S, fade)
        })
      },
      tint(g, t) {
        // 트리 위 단어 몇 개 = 금·빨강 장식, 따로따로 반짝임 (단어가 표면에 붙어 같이 돈다)
        if (g.m !== TREE) return
        const hv = hash(xmas.built![0].word[g.k], g.row, 11)
        if (hv > 0.14) return
        g.m = hv < 0.07 ? GOLD : RED
        g.lum = 0.5 + 0.72 * (0.5 + 0.5 * Math.sin(t * 3.1 + hv * 900))
      },
      over(o, R, t, dt) {
        const st = xmas.built!, lh = R.lh, uw = R.uw
        // 별: ★ + 희망 글자 8갈래 빛살 (길이가 숨쉬고, 6초마다 번쩍)
        const sx = R.cx, sy = R.cy - 0.71 * R.S, flash = (t % 6) < 0.5 ? 1 - (t % 6) / 0.5 : 0
        for (let i = 0; i < 8; i++) {
          const a = (i * TAU) / 8 + t * 0.25, n = Math.round(3 + 2.5 * (0.5 + 0.5 * Math.sin(t * 2.3 + i * 1.7)) + flash * 4)
          for (let j = 0, q = i * 23; j < n; j++, q++) {
            const sl = st[2].ch[st[2].nz[q % st[2].nz.length]]
            const d = (j + 1.7) * lh * 0.78
            o.put(sl, sx + Math.cos(a) * d, sy + Math.sin(a) * d * 0.9, j ? GOLD : 0, (1 - j / n) * (0.85 + 0.15 * flash))
          }
        }
        o.put('★', sx, sy, GOLD, 1, 2.4 + 0.3 * Math.sin(t * 3.1) + flash)
        for (let i = 0; i < bows.length; i += 3) o.put('✦', bows[i], bows[i + 1] - lh * 0.45, GOLD, bows[i + 2], 1.1)
        // 땅: 눈 단어가 한 줄로 희미하게
        const gy = R.cy - (G0 - 0.02) * R.S
        for (let x = R.cx - R.S * 1.25, q = 0; x < R.cx + R.S * 1.25; q++) {
          const qq = q % st[3].ch.length, sl = st[3].ch[qq], w = st[3].wu[qq]
          if (sl !== ' ') o.put(sl, x + (w * uw) / 2, gy, SNOW, 0.3 * (1 - Math.abs(x - R.cx) / (R.S * 1.25)))
          x += w * uw
        }
        // 눈: 3D 위치(z<0 = 트리 뒤라 가려짐), 가까울수록 크고 밝게
        const N = 110
        if (!fl || fl.length !== N * 4) {
          fl = new Float32Array(N * 4)
          for (let k = 0; k < N; k++) fl.set([(Math.random() - 0.5) * (R.pw / R.S), -0.85 + Math.random() * 2, Math.random() * 2 - 1, 0.12 + Math.random() * 0.16], k * 4)
        }
        for (let k = 0; k < N; k++) {
          const p = k * 4
          fl[p + 1] -= fl[p + 3] * dt
          fl[p] += Math.sin(t * 0.7 + k) * 0.04 * dt
          if (fl[p + 1] < -0.86) (fl[p + 1] = 1.15), (fl[p] = (Math.random() - 0.5) * (R.pw / R.S))
          const x = R.cx + fl[p] * R.S, y = R.cy - fl[p + 1] * R.S, z = fl[p + 2]
          if (z < 0 && !o.free(x, y)) continue
          o.put(k % 9 === 0 ? '❄' : k % 3 ? '·' : '*', x, y, SNOW, 0.35 + 0.35 * (z + 1), 0.8 + 0.35 * (z + 1))
        }
        shoot(o, R, t, st[4], GOLD, 11)
      },
    }
  },
}

/* 밤: 회전대 위 빌딩 숲(잘 자요) · 창문 = 단어 조각이 켜졌다 꺼짐(켜지는 순간 번쩍) · 실제 위상의 달(달 글자) · 별 · 꿈 유성 */
const city: Scene = {
  name: '밤의 도시',
  bg: '#02040b',
  mats: ['#ffffff', '#9fb4e6', '#ffc24a', '#ff9a3c', '#3a4870', '#f6ecc4', '#ff5a5a', '#c9d6ff', '#ffc24a'],
  phrases: [NIGHT, MOONW, DREAM],
  mini: [['moon', 5], ['잘 자요', 1], ['夢', 2], ['night', 7], ['달', 5], ['nuit', 1], ['晚安', 2], ['dream', 7]],
  fx: { band: 13, decode: 0.04, sparkle: 0.0008 },
  make() {
    const [WALL, WIN, WINC, DARK, MOON, RED, STAR] = [1, 2, 3, 4, 5, 6, 7]
    const WINF = 8 // 켜지는 순간 (하이라이트로 번쩍)
    const emit: number[] = []
    emit[WIN] = 0.95; emit[WINC] = 0.9; emit[DARK] = -0.2; emit[WINF] = 1.3; emit[WALL] = -0.45
    const YB = -0.8
    const B: [number, number, number, number, number][] = [] // bx bz hw hd top
    for (let gx = 0; gx < 4; gx++)
      for (let gz = 0; gz < 2; gz++) {
        const x = (gx - 1.5) * 0.56 + (gz ? 0.28 : 0), z = (gz - 0.5) * 0.6
        B.push([x, z, 0.09 + hash(gx, gz, 2) * 0.05, 0.09 + hash(gz, gx, 3) * 0.04, YB + 0.3 + hash(gx, gz, 1) ** 1.3 * 0.7])
      }
    B.push([0, 0, 0.12, 0.12, YB + 1.42]) // 가운데 탑
    const tall = B.reduce((m, b, i) => (b[4] > B[m][4] ? i : m), 0)
    let th = 0
    return {
      geo(R, t) {
        th = 0.5 + t * 0.1
        const lpu = R.S / R.lh
        B.forEach(([bx, bz, hw, hd, top], bi) => {
          const r0 = Math.max(0, Math.ceil(R.row(top))), r1 = Math.min(R.R - 1, Math.floor(R.row(YB)))
          for (let r = r0; r <= r1; r++) {
            const y = R.y(r), li = Math.round((y - YB) * lpu), roof = (top - y) * lpu < 0.8
            boxRow(R, r, bx, bz, hw, hd, 0, th, 0, bi * 977 + li * 53, 1, (f, j) => {
              if (roof || li < 1 || li % 2 === 0 || j % 5 === 0 || j % 5 === 4) return WALL
              const wid = (j / 5) | 0, tt = t / 2.6 + hash(bi * 7 + f, wid, li) * 5, ph = tt - Math.floor(tt)
              if (hash(bi * 97 + f * 13 + wid, li, Math.floor(tt)) > 0.5) return DARK
              return ph < 0.06 ? WINF : hash(bi, wid, li) < 0.2 ? WINC : WIN
            }, emit)
          }
        })
        // 달: 화면 공간 구, 글자가 천천히 자전, 실제 위상만큼 밝은 쪽 (어두운 쪽 = 지구 반사광으로 아주 희미하게)
        const f = moonPhase(new Date()), kk = Math.cos(TAU * f), Rp = R.ph * 0.1, mx = R.pw * 0.8, my = R.ph * 0.2
        const r0 = Math.max(0, Math.ceil((my - Rp) / R.lh - 0.5)), r1 = Math.min(R.R - 1, Math.floor((my + Rp) / R.lh - 0.5))
        for (let r = r0; r <= r1; r++) {
          const v = ((r + 0.5) * R.lh - my) / Rp
          if (Math.abs(v) >= 1) continue
          const a = Math.sqrt(1 - v * v), Cu = Math.max(3, Math.round((TAU * a * Rp) / R.uw)), N = 40, edge = kk * a
          let pX = 0, pu = 0, pl = 0
          for (let i = 0; i <= N; i++) {
            const xn = -a + (2 * a * i) / N, lit = f < 0.5 ? xn > edge : xn < -edge
            const X = mx + xn * Rp, u = ((Math.asin(Math.max(-1, Math.min(1, xn / a))) + t * 0.05) / TAU) * Cu
            const lum = lit ? 0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - xn * xn - v * v)) : 0.1
            if (i) R.seg(r, pX, -50, pu, pl, X, -50, u, lum, MOON, 1, r * 71, Cu)
            pX = X; pu = u; pl = lum
          }
        }
      },
      over(o, R, t) {
        const n = 80
        for (let k = 0; k < n; k++) {
          const x = hash(k, 1, 3) * R.pw, y = hash(k, 2, 3) * R.ph * 0.55, tw = Math.sin(t * 1.4 + k * 2.7)
          if (o.free(x, y)) o.put(hash(k, 3, 3) < 0.08 ? '✦' : hash(k, 3, 3) < 0.25 ? '+' : '·', x, y, STAR, tw > 0.7 ? 0.9 : 0.35)
        }
        // 제일 높은 빌딩 안테나 + 깜빡이는 빨간 불
        const [bx, bz, , , top] = B[tall], ax = R.cx + (bx * Math.cos(th) + bz * Math.sin(th)) * R.S, ay = R.cy - top * R.S
        for (let k = 1; k <= 3; k++) o.put('|', ax, ay - k * R.lh * 0.8, WALL, 0.6)
        o.put('•', ax, ay - 3.8 * R.lh * 0.8, RED, Math.sin(t * 4) > 0 ? 1 : 0.15, 1.3)
        shoot(o, R, t, city.built![2], STAR, 13)
      },
    }
  },
}

/* 가을: 회전하는 큰 단풍잎(가을) · 색이 안에서 밖으로 물결치듯 번짐 · 단풍 단어로 된 작은 잎들이 뒹굴며 떨어짐 · 잎에서 글자가 떨어져 나감 */
const autumn: Scene = {
  name: '가을 단풍',
  bg: '#0a0505',
  mats: ['#fff1d0', '#ff4a3a', '#ff8a2a', '#ffc340', '#c22f2a', '#ffb08a'],
  phrases: [AUT, LEAF],
  mini: [['가을', 3], ['秋', 1], ['fall', 2], ['단풍', 1], ['otoño', 3], ['紅葉', 2], ['Herbst', 1], ['leaf', 3]],
  fx: { band: 10, decode: 0.05, sparkle: 0.0015, fall: 9 },
  make() {
    const [RED, OR, AMB2, DEEP] = [1, 2, 3, 4]
    const LEAFC = [RED, OR, AMB2, DEEP]
    const N = 9, L = new Float32Array(N * 6) // x y vy spin tumble phase
    const spawn = (o: number, y: number) => L.set([(Math.random() - 0.5) * 3.4, y, 0.1 + Math.random() * 0.12, Math.random() * TAU, Math.random() * TAU, Math.random() * TAU], o)
    for (let k = 0; k < N; k++) spawn(k * 6, -1 + Math.random() * 2.2)
    return {
      geo(R, t, dt) {
        const sh = MAPLE(), wv = 0.22 * Math.sin(t * 0.55)
        pillow(R, sh, 0, 0.06 + 0.03 * Math.sin(t * 0.7), 0.86, (t - T0) * 0.5 + 0.4, 1, 0, (d) => (d + wv > 0.42 ? AMB2 : d + wv > 0.2 ? OR : d + wv > 0.08 ? RED : DEEP), 1, 1.2)
        for (let k = 0; k < N; k++) {
          const o = k * 6
          L[o + 1] -= L[o + 2] * dt
          L[o] += Math.sin(t * 0.9 + L[o + 5]) * 0.12 * dt
          L[o + 3] += dt * 1.6
          L[o + 4] += dt * 1.1
          if (L[o + 1] < -1.15) spawn(o, 1.2)
          pillow(R, sh, L[o], L[o + 1], 0.12 + 0.04 * hash(k, 1), L[o + 3], 0.3 + 0.7 * Math.abs(Math.cos(L[o + 4])), 1, () => LEAFC[k % 4], 20 + k, 0.9)
        }
      },
    }
  },
}

/* 기본: 회전하는 네잎클로버(행운을 빌어요, 인광 초록) · 스캔 띠 · 언어 바뀜 물결 · 해독 · 반짝임 · 떨어지는 글자 */
const calm: Scene = {
  name: '네잎클로버',
  bg: '#000000',
  mats: ['#e2ffec', '#45ff8a'],
  phrases: [LUCK],
  mini: [['행운', 1], ['luck', 1], ['幸運', 1], ['suerte', 1], ['chance', 1], ['Glück', 1], ['福', 1], ['lycka', 1]],
  fx: { band: 7, ripple: 8, decode: 0.05, sparkle: 0.002, fall: 7 },
  make() {
    return { geo: (R, t) => pillow(R, CLOVER(), 0, 0.02 * Math.sin(t * 0.8), 0.98, (t - T0) * 0.6 + 0.35, 1, 0, () => 1, 7) }
  },
}

export type SceneId = 'xmas' | 'city' | 'autumn' | 'calm'
export const SCENES: Record<SceneId, Scene> = { xmas, city, autumn, calm }

const SEASON = ['겨울', '겨울', '봄', '봄', '봄', '여름', '여름', '여름', '가을', '가을', '가을', '겨울']
export const seasonOf = (d: Date) => SEASON[d.getMonth()]
export const isNight = (d: Date) => d.getHours() >= 19 || d.getHours() < 6
/** 계절·시간대 → 장면: 12월 트리 > 밤 도시 > 가을 단풍 > 네잎클로버 */
export const pickScene = (d: Date): SceneId => (d.getMonth() === 11 ? 'xmas' : isNight(d) ? 'city' : seasonOf(d) === '가을' ? 'autumn' : 'calm')

/** 빛 번짐: 그린 글자의 색 × 밝기를 1/8 해상도 버퍼에 쌓고 → 상자 흐림 2번 → putImageData → 'lighter' 로 늘려 얹기.
    캔버스를 다시 읽지 않으니(drawImage(자기 캔버스)/filter 는 글자 래스터를 기다려 프레임마다 3~7ms) 메인 스레드 비용이 거의 없다. */
class Glow {
  w = 1; h = 1
  b = new Float32Array(3)
  t = new Float32Array(3)
  img = new ImageData(1, 1)
  rgb: number[][]
  constructor(mats: string[]) {
    this.rgb = mats.map((m) => [1, 3, 5].map((i) => parseInt(m.slice(i, i + 2), 16) / 255))
  }
  resize(pw: number, ph: number) {
    this.w = Math.ceil(pw / 8); this.h = Math.ceil(ph / 8)
    this.b = new Float32Array(this.w * this.h * 3)
    this.t = new Float32Array(this.w * this.h * 3)
    this.img = new ImageData(this.w, this.h)
  }
  add(x: number, y: number, m: number, a: number) {
    const gx = x >> 3, gy = y >> 3
    if (gx < 0 || gy < 0 || gx >= this.w || gy >= this.h) return
    const o = (gy * this.w + gx) * 3, c = this.rgb[m]
    this.b[o] += c[0] * a; this.b[o + 1] += c[1] * a; this.b[o + 2] += c[2] * a
  }
  /** 가로·세로 3칸 상자 흐림 ×2 → 이미지 → 지움 */
  flush(g: CanvasRenderingContext2D, k: number) {
    const { w, h } = this
    let a = this.b, b = this.t
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          for (let c = 0; c < 3; c++) {
            const o = (y * w + x) * 3 + c
            b[o] = (a[o] * 2 + (x > 0 ? a[o - 3] : 0) + (x < w - 1 ? a[o + 3] : 0)) * 0.25
          }
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          for (let c = 0; c < 3; c++) {
            const o = (y * w + x) * 3 + c, W3 = w * 3
            a[o] = (b[o] * 2 + (y > 0 ? b[o - W3] : 0) + (y < h - 1 ? b[o + W3] : 0)) * 0.25
          }
    }
    const d = this.img.data
    for (let i = 0, o = 0; i < w * h; i++, o += 3) {
      d[i * 4] = a[o] * k; d[i * 4 + 1] = a[o + 1] * k; d[i * 4 + 2] = a[o + 2] * k; d[i * 4 + 3] = 255
    }
    g.putImageData(this.img, 0, 0)
    a.fill(0)
  }
}

/** 줄 버퍼 → 글자: 같은 (글자, 흐름) 칸이 이어진 만큼 = 그 글자의 화면 폭 (비스듬하면 fillText maxWidth 로 눌림).
    fillText 가 같은 일의 drawImage(아틀라스)보다 3배 싸다 (이 PC 측정: 4000자 4.6ms vs 17ms). 색은 바뀔 때만 지정. */
function paint(ctx: CanvasRenderingContext2D, R: Rows, sc: Scene, run: Run, t: number, cand: number[], glow: Glow | null) {
  const st = R.st, fx = sc.fx, g: Gly = { m: 0, lum: 0, k: 0, s: 0, row: 0 }, lh = R.lh, uw = R.uw
  const bp = fx.band ? ((t % fx.band) / fx.band) * R.pw * 1.7 - R.pw * 0.35 : 0, bw = R.pw * 0.045, ring = lh * 2.4, tq = Math.floor(t * 14)
  let letters = 0, phrases = 0, cur = -1
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let r = 0; r < R.R; r++) {
    const base = r * R.W, yc = r * lh + lh * 0.55
    for (let i = 0; i < R.W; ) {
      const m = R.m[base + i]
      if (m < 0) {
        i++
        continue
      }
      const k = R.k[base + i], s = R.s[base + i]
      let j = i + 1
      while (j < R.W && R.k[base + j] === k && R.s[base + j] === s) j++
      const S = st[s], w = (j - i) * R.cs, xc = i * R.cs + w / 2
      let q = k
      if (S.ch[k] !== ' ' && w >= 1.5) {
        g.m = m; g.lum = R.l[base + ((i + j) >> 1)]; g.k = k; g.s = s; g.row = r
        run.tint?.(g, t)
        let lum = g.lum
        const rnd = () => S.nz[Math.floor(hash(k, r, tq) * S.nz.length)]
        // 해독: 가끔 단어가 뒤섞였다가 글자 하나씩 제자리로
        if (fx.decode) {
          const wd = S.word[k], tt = t / 5 + hash(wd, 3, s), ph = (tt - Math.floor(tt)) * 5
          if (ph < 1 && hash(wd, Math.floor(tt), 7 + r) < fx.decode && hash(k, r, 99) > ph) (q = rnd()), (lum += 0.3)
        }
        if (fx.band) {
          const dd = (xc + (yc - R.ph / 2) * 0.45 - bp) / bw
          if (dd * dd < 9) lum += 0.8 * Math.exp(-dd * dd)
        }
        if (R.rp >= 0) {
          const e = Math.abs(Math.hypot(xc - R.rcx, yc - R.rcy) - R.rp)
          if (e < ring) (q = rnd()), (lum += 0.75 * (1 - e / ring))
        }
        if (fx.sparkle && hash(k + r * 7919, s, Math.floor(t * 5)) < fx.sparkle) lum = 1.6
        const hi = lum > 1.04, a = hi ? Math.min(1, 0.55 + (lum - 1) * 0.9) : lum
        if (a > 0.05) {
          const mm = hi ? 0 : g.m, mw = Math.min(w, S.wu[q] * uw)
          if (mm !== cur) ctx.fillStyle = sc.mats[(cur = mm)]
          ctx.globalAlpha = a
          if (R.d[base + i] < 0) {
            ctx.setTransform(-1, 0, 0, 1, 2 * xc, 0)
            ctx.fillText(S.ch[q], xc, yc, mw)
            ctx.setTransform(1, 0, 0, 1, 0, 0)
          } else ctx.fillText(S.ch[q], xc, yc, mw)
          letters++
          if (S.head[k]) phrases++
          glow?.add(xc, yc, mm, (a * w) / uw)
          if (fx.fall && cand.length < 320 && hash(k, r, tq) < 0.01) cand.push(xc, yc, s, q, mm)
        }
      }
      i = j
    }
  }
  return [letters, phrases]
}

/** 전체화면 렌더 루프 ≤30fps. live=false 거나 이동 줄이기면 1프레임만. */
function AsciiCanvas({ id, live }: { id: SceneId; live: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current!, ctx = cv.getContext('2d', { alpha: false })!
    const sc = SCENES[id], st = (sc.built ??= sc.phrases.map(mkStream)), run = sc.make(), R = new Rows()
    R.st = st
    const gcv = document.createElement('canvas'), gx = gcv.getContext('2d')!, glow = new Glow(sc.mats)
    const PN = 160, P = new Float32Array(PN * 8) // 떨어지는 글자: x y vx vy life 흐름 글자 재질
    let pn = 0, acc = 0, ms = 0, fpsE = 0, kdp = 1, font = ''
    const cand: number[] = []
    const ov: Over = {
      put(c, x, y, m, a, k = 1) {
        if (a <= 0.02) return
        ctx.globalAlpha = Math.min(1, a)
        ctx.fillStyle = sc.mats[m]
        glow.add(x, y, m, a * k * k)
        if (k === 1) return ctx.fillText(c, x, y)
        ctx.setTransform(k, 0, 0, k, x, y)
        ctx.fillText(c, 0, 0)
        ctx.setTransform(1, 0, 0, 1, 0, 0)
      },
      free(x, y) {
        const r = Math.floor(y / R.lh), i = Math.floor(x / R.cs)
        return r < 0 || r >= R.R || i < 0 || i >= R.W || R.m[r * R.W + i] < 0
      },
    }
    const size = () => {
      kdp = devicePixelRatio || 1
      const w = cv.clientWidth, h = cv.clientHeight
      cv.width = Math.max(1, Math.round(w * kdp))
      cv.height = Math.max(1, Math.round(h * kdp))
      const lh = Math.max(5, Math.round(Math.min(15, Math.max(10, h / 64)) * kdp))
      ctx.font = font = `${Math.round(lh * 0.86)}px ${FONT}`
      const uw = Math.max(2, Math.ceil(ctx.measureText('M').width))
      R.resize(cv.width, cv.height, lh, uw, Math.max(1, Math.round(uw / 4)), 0.42 * cv.height)
      glow.resize(cv.width, cv.height)
      gcv.width = glow.w
      gcv.height = glow.h
    }
    const t0 = performance.now()
    let raf = 0, last = 0
    const render = (now: number) => {
      const w0 = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 0
      if (last) fpsE = fpsE ? fpsE * 0.9 + (100 / Math.max(1, now - last)) : 1000 / Math.max(1, now - last)
      last = now
      const el = (now - t0) / 1000, t = el + T0, fx = sc.fx
      // 언어 바뀜 물결: ripple 초마다 가운데서 퍼지는 고리, 지나간 자리는 다른 문구로
      if (fx.ripple) {
        const cyc = Math.floor(t / fx.ripple), ph = t - cyc * fx.ripple
        R.sh1 = cyc * 211
        R.sh0 = (cyc - 1) * 211
        R.rp = ph < 1.8 ? (ph / 1.8) * R.S * 1.35 : -1
        R.rcx = R.cx
        R.rcy = R.cy
      }
      R.clear()
      run.geo(R, t, dt)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      ctx.fillStyle = sc.bg
      ctx.fillRect(0, 0, cv.width, cv.height)
      ctx.font = font
      cand.length = 0
      const [letters, phrases] = paint(ctx, R, sc, run, t, cand, glow)
      run.over?.(ov, R, t, dt)
      // 떨어지는 글자: 표면에서 떨어져 나와 중력으로 떨어지며 사라짐
      if (fx.fall && cand.length) {
        for (acc += fx.fall * dt; acc >= 1; acc--) {
          const c = Math.floor(Math.random() * (cand.length / 5)) * 5
          P.set([cand[c], cand[c + 1], (Math.random() - 0.5) * R.lh * 2, -R.lh * (0.5 + Math.random()), 1, cand[c + 2], cand[c + 3], cand[c + 4]], (pn++ % PN) * 8)
        }
      }
      for (let p = 0; p < PN * 8; p += 8) {
        if (P[p + 4] <= 0) continue
        P[p + 3] += R.lh * 9 * dt
        P[p] += P[p + 2] * dt
        P[p + 1] += P[p + 3] * dt
        P[p + 4] -= dt * 0.55
        ov.put(st[P[p + 5]].ch[P[p + 6]], P[p], P[p + 1], P[p + 4] > 0.9 ? 0 : P[p + 7], P[p + 4] * 0.85)
      }
      {
        glow.flush(gx, 120)
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = 1
        ctx.drawImage(gcv, 0, 0, cv.width, cv.height)
        ctx.globalCompositeOperation = 'source-over'
        // HUD
        const f = Math.round(11 * kdp), pad = Math.round(16 * kdp)
        ctx.globalAlpha = 0.5
        ctx.fillStyle = sc.mats[1]
        ctx.font = `${f}px ui-monospace, 'Cascadia Mono', Consolas, monospace`
        ctx.textBaseline = 'alphabetic'
        ctx.textAlign = 'right'
        ctx.fillText(`t ${el.toFixed(2).padStart(5, '0')}s`, cv.width - pad, pad + f)
        ctx.fillText(`${live && !reducedMotion() ? 'running' : 'still'} · ${Math.round(fpsE)} fps · ${ms.toFixed(1)} ms`, cv.width - pad, cv.height - pad)
        ctx.textAlign = 'left'
        ctx.fillText(`hera · ${sc.name}`, pad, cv.height - pad - f * 2.6)
        ctx.fillText(`languages ${sc.phrases[0].length}   phrases ${phrases}`, pad, cv.height - pad - f * 1.3)
        ctx.fillText(`letters ${letters.toLocaleString('en-US')}`, pad, cv.height - pad)
      }
      if (dt) ms = ms ? ms * 0.8 + (performance.now() - w0) * 0.2 : performance.now() - w0 // 첫 프레임(문구·글꼴 준비)은 빼고 잰다
    }
    size()
    render(t0)
    if (!live || reducedMotion()) return
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - last >= 1000 / 30 - 3) render(now)
    }
    raf = requestAnimationFrame(loop)
    const onResize = () => (size(), render(performance.now()))
    addEventListener('resize', onResize)
    return () => (cancelAnimationFrame(raf), removeEventListener('resize', onResize))
  }, [id, live])
  return <canvas ref={ref} className="ascii3d" aria-hidden />
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
      <AsciiCanvas id={id} live={open} />
      <footer>
        <b>{SCENES[id].name}</b> · {caption}
        <small>{saver ? '마우스를 움직이거나 아무 키나 누르면 돌아가요' : 'Esc 또는 클릭으로 닫기'}</small>
      </footer>
    </div>
  )
}
