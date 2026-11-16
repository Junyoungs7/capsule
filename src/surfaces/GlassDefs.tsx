import { Fragment, useEffect, useMemo } from 'react'

/* Liquid Glass 공용: SVG 렌즈 필터 + 포인터를 따라가는 림 하이라이트.
   렌즈 = feDisplacementMap. 변위 맵은 캔버스로 1회 만든 작은 PNG (가운데 128 = 변위 없음, 가장자리 띠에서만 굴절).
   R·G·B 채널을 조금씩 다른 세기로 굴절시켜 가장자리에 옅은 색수차를 낸다.
   쓰는 곳: backdrop-filter: … url(#hera-lens) — 작은 요소(라벨·탭 알약·팝오버)만. 큰 표면에는 쓰지 않는다. */

// ponytail: 맵은 요소 크기에 맞춰 늘어난다(preserveAspectRatio none) → 아주 길쭉한 요소는 좌우 띠가 넓어짐. 필요하면 크기별 맵.
function lensMap(w: number, h: number, bandX: number, bandY: number, top = 0) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(w, h)
  // 가장자리로 갈수록 세게 (제곱 곡선 = 볼록 렌즈의 테두리처럼 끝에서 급격히 휨)
  const edge = (u: number, b: number) => (b <= 0 ? 0 : u < b ? -((1 - u / b) ** 2) : u > 1 - b ? (1 - (1 - u) / b) ** 2 : 0)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = (y + 0.5) / h
      const vy = v < top ? 0 : (v - top) / (1 - top) // top 위쪽(독 오버슈트 여유)은 변위 없음
      const i = (y * w + x) * 4
      img.data[i] = 128 + 127 * edge((x + 0.5) / w, bandX)
      img.data[i + 1] = v < top ? 128 : 128 + 127 * edge(vy, bandY)
      img.data[i + 2] = 128
      img.data[i + 3] = 255
    }
  ctx.putImageData(img, 0, 0)
  return c.toDataURL()
}

const CH = [
  ['1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', 1],
  ['0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', 0.92],
  ['0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0', 0.84],
] as const

// chroma=false: 변위 1회만 (큰 표면용 테두리 렌즈 — 색수차 3회 대신)
function Lens({ id, map, scale, chroma = true }: { id: string; map: string; scale: number; chroma?: boolean }) {
  return (
    <filter id={id} x="0" y="0" width="1" height="1" primitiveUnits="objectBoundingBox" colorInterpolationFilters="sRGB">
      <feImage href={map} x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="map" />
      {!chroma && <feDisplacementMap in="SourceGraphic" in2="map" scale={scale} xChannelSelector="R" yChannelSelector="G" />}
      {chroma && CH.map(([m, k], i) => (
        <Fragment key={i}>
          <feDisplacementMap in="SourceGraphic" in2="map" scale={scale * k} xChannelSelector="R" yChannelSelector="G" result={`d${i}`} />
          <feColorMatrix in={`d${i}`} values={m} result={`c${i}`} />
        </Fragment>
      ))}
      {chroma && <feBlend in="c0" in2="c1" mode="screen" result="rg" />}
      {chroma && <feBlend in="rg" in2="c2" mode="screen" />}
    </filter>
  )
}

const HL = '.palette, .demo, .note'

export function GlassDefs() {
  const maps = useMemo(
    () => ({
      // 작은 요소: 좌우·위아래 가장자리 18%
      lens: lensMap(64, 64, 0.18, 0.22),
      // 독(시안): 세로 렌즈만 (바 너비가 바뀌므로). 바 = 레이어 아래 72/84 → 위 14% 는 변위 없음. 실제 앱은 paintWall 이 굽는다.
      dock: lensMap(2, 84, 0, 0.28, 12 / 84),
      // 패널·팔레트: ~10px 테두리 띠만 굴절 (가운데는 변위 0). 맵은 비율이라 표면 크기별로 하나씩.
      // ponytail: 높이가 바뀌는 팔레트는 대표 크기 기준 — 띠 폭이 몇 px 달라질 수 있음
      palette: lensMap(256, 256, 10 / 580, 10 / 420), // 580×~420
    }),
    [],
  )

  // 호버 중에만 pointermove 를 붙여 --mx/--my 갱신 (rAF 1회). 평소엔 리스너 1개(pointerover)뿐.
  useEffect(() => {
    let cur: HTMLElement | null = null, raf = 0, x = 0, y = 0
    const frame = () => {
      raf = 0
      if (!cur) return
      const r = cur.getBoundingClientRect()
      cur.style.setProperty('--mx', `${x - r.left}px`)
      cur.style.setProperty('--my', `${y - r.top}px`)
    }
    const move = (e: PointerEvent) => {
      x = e.clientX
      y = e.clientY
      if (!raf) raf = requestAnimationFrame(frame)
    }
    const stop = () => {
      if (!cur) return
      cancelAnimationFrame(raf)
      raf = 0
      cur.removeEventListener('pointermove', move)
      cur.removeEventListener('pointerleave', stop)
      delete cur.dataset.hl
      cur = null
    }
    const over = (e: PointerEvent) => {
      const el = (e.target as Element).closest?.<HTMLElement>(HL)
      if (!el || el === cur) return
      stop()
      cur = el
      el.dataset.hl = 'true'
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerleave', stop)
      move(e)
    }
    document.addEventListener('pointerover', over)
    return () => (document.removeEventListener('pointerover', over), stop())
  }, [])

  return (
    <svg width="0" height="0" aria-hidden style={{ position: 'absolute' }}>
      <Lens id="hera-lens" map={maps.lens} scale={0.07} />
      <Lens id="hera-lens-dock" map={maps.dock} scale={0.17} />
      {/* 테두리 렌즈: 처음 안의 ~65% 세기 (사용자 조정) */}
      <Lens id="hera-rim-palette" map={maps.palette} scale={0.016} chroma={false} />
    </svg>
  )
}
