import { useEffect, useRef, type CSSProperties, type RefObject } from 'react'
import type { LpRecord } from '../data/types'
import { reducedMotion, Tile } from './Tile'

/* LP = 글라스 레코드 (떠 있는 LP 플레이어 · Player.tsx 가 쓴다).
   - 회전: 턴테이블의 계단식 가속/감속 + 정속 30°/150ms 규칙 (useSpin). */

/* 라벨 대비: 아이콘이 항상 읽히게 커버 휘도로 라벨/잉크를 고른다 (LP 라벨 공용).
   어두운 커버 → 밝은 라벨 + 커버색 아이콘, 밝은 커버 → 짙은 아이콘, 그 사이 → 흰 아이콘 */
export function labelVars(cover = '#64748B'): CSSProperties {
  const n = parseInt(cover.slice(1), 16)
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  const [lab, ink] = L < 0.08 ? [`color-mix(in oklab, ${cover} 26%, white)`, cover] : L > 0.3 ? [cover, `color-mix(in oklab, ${cover} 28%, black)`] : [cover, '#fff']
  return { '--c': cover, '--lab': lab, '--ink': ink } as CSSProperties
}

const PERIOD = 1800 // 33⅓rpm = 1.8s/회전
const STEPS = 60 // 회전당 60컷: 가속·감속 구간은 60Hz 에서 2프레임마다 6°
// 정속(앱이 살아 있는 동안 계속)은 5컷씩 묶어 30°/150ms (6.7Hz) — 갱신 1회마다 웹뷰·GPU 프레임 비용이 들어 idle CPU <1% 를 맞춘다(계획 C 측정)
const CRUISE = 5

/** on 이 true 면 가속(1.4s) 후 정속 컷 회전, false 면 감속(1.7s) 후 그 각도에서 정지. steps() WAAPI 1개 재사용.
    정속에서는 애니메이션을 멈추고 컷마다 currentTime 을 민다 — 재생 중 WAAPI 는 컷이 안 바뀌어도 매 vsync 프레임을 만든다. */
export function useSpin(el: RefObject<HTMLElement | null>, on: boolean) {
  const anim = useRef<Animation | null>(null)
  const rate = useRef(0)
  const ramp = useRef(0)
  const tick = useRef(0)
  useEffect(() => () => (cancelAnimationFrame(ramp.current), clearInterval(tick.current), anim.current?.cancel()), [])
  useEffect(() => {
    if (reducedMotion() || !el.current) return
    const to = on ? 1 : 0
    if (!to && rate.current <= 0.001) return
    const a = (anim.current ??= el.current.animate([{ transform: 'rotate(0turn)' }, { transform: 'rotate(1turn)' }], {
      duration: PERIOD,
      iterations: Infinity,
      easing: `steps(${STEPS})`,
    }))
    clearInterval(tick.current)
    if (to) a.playbackRate = rate.current = Math.max(rate.current, 0.001)
    a.play()
    const from = rate.current, t0 = performance.now(), dur = to ? 1400 : 1700
    cancelAnimationFrame(ramp.current)
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur)
      rate.current = from + (to - from) * (1 - (1 - k) * (1 - k))
      a.playbackRate = Math.max(rate.current, 0.001)
      if (k < 1) ramp.current = requestAnimationFrame(step)
      else if (!to) a.pause() // 정지 각도 유지, 이후 프레임 0
      else {
        a.pause()
        const q = (PERIOD / STEPS) * CRUISE
        tick.current = window.setInterval(() => (a.currentTime = ((Math.round(Number(a.currentTime) / q) + 1) * q) % PERIOD), q)
      }
    }
    ramp.current = requestAnimationFrame(step)
  }, [on])
}

/* 아스키 LP: LP 플레이어의 레코드. 플래터에 올리면 전체화면 아스키. */
const ASCII_GLYPH = { xmas: '❄', city: '☾', autumn: '❦', calm: '☘', auto: '✦' } as const
export const ASCII_RECORDS: LpRecord[] = (
  [['auto', '자동(계절)', '#0f766e'], ['xmas', '크리스마스', '#b91c1c'], ['city', '밤 도시', '#312e81'], ['autumn', '단풍', '#c2410c'], ['calm', '클로버', '#15803d']] as const
).map(([scene, name, cover]) => ({ id: 'ascii:' + scene, title: `아스키 · ${name}`, target: '', kind: 'ascii', scene, cover, glyph: 'ascii' }))

/** 글라스 LP: 홈(회전) + 라벨(앱 아이콘, 회전) + 정적 반사(회전 안 함). 아스키 LP 는 라벨에 장면 기호 + ASCII 글자 */
export function Disc({ rec, size, spinRef, glyph }: { rec?: LpRecord; size: number; spinRef?: RefObject<HTMLSpanElement>; glyph?: string }) {
  return (
    <span className="lp" data-kind={rec?.kind} style={{ width: size, height: size, fontSize: size, ...labelVars(rec?.cover) }} aria-hidden>
      <span ref={spinRef} className="lp-spin">
        <span className="lp-label">
          {glyph || rec?.kind === 'ascii' ? <b className="lp-ascii">{glyph ?? ASCII_GLYPH[rec?.scene ?? 'auto']}</b> : rec && <Tile rec={rec} size={Math.round(size * 0.34)} />}
        </span>
      </span>
      <i className="lp-sheen" />
    </span>
  )
}
