import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type TransitionEvent } from 'react'
import type { LpRecord } from '../data/types'
import { iconFor } from '../data/api'

/* ── 공용: 둥근 사각형 clip-path (dock·island 가 공유) ──────────────────────
   글라스 레이어는 최대 크기로 고정하고 모양만 clip-path 로 바꾼다.
   1px 하이라이트 테두리는 같은 모양의 링(evenodd)으로 그린다 — 명령 구성이 같아서 path() 끼리 보간된다. */
const rr = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}` +
  `H${x + r}A${r},${r} 0 0 1 ${x},${y + h - r}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}Z`

export function shape(x: number, y: number, w: number, h: number, r: number, t = 1) {
  return {
    glass: `path("${rr(x, y, w, h, r)}")`,
    ring: `path(evenodd, "${rr(x, y, w, h, r)}${rr(x + t, y + t, w - 2 * t, h - 2 * t, Math.max(0, r - t))}")`,
  }
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** 열기·닫기 모두 애니메이션 (패널과 같은 방식): 마운트 → reflow → data-show=true.
    닫기 → data-show=false → opacity transitionend → 언마운트. 숨김 상태 CSS 는 각 표면이 정한다. */
export function usePresence<T extends HTMLElement>(open: boolean) {
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.getBoundingClientRect()
    el.dataset.show = String(open)
  }, [open, mounted])
  const onTransitionEnd = (e: TransitionEvent) => e.target === e.currentTarget && e.propertyName === 'opacity' && !open && setMounted(false)
  return { mounted, ref, onTransitionEnd }
}

/* ── 레코드 타일 (크레이트·라이브러리 공용) ── */
export function Tile({ rec, size }: { rec: LpRecord; size?: number }) {
  const g = rec.glyph
  // 실제 앱: 추출 아이콘(app) / favicon(fav). 실패하면 아래 글리프·이니셜로 폴백.
  const [img, setImg] = useState<{ src: string; kind: string } | null>(null)
  useEffect(() => {
    let live = true
    setImg(null)
    void iconFor(rec.kind === 'single' ? rec.target : '')?.then((i) => live && setImg(i))
    return () => void (live = false)
  }, [rec.target])
  return (
    <span className="tile" data-img={img?.kind} style={{ '--c': rec.cover, width: size, height: size, fontSize: size } as CSSProperties} aria-hidden>
      {img ? (
        <img src={img.src} alt="" draggable={false} onError={() => setImg(null)} />
      ) : g === 'text' ? (
        <b>{rec.title.slice(0, 1)}</b>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          {g === 'calc' && (<><rect x="5" y="3.5" width="14" height="17" rx="3" /><path d="M8 7.5h8" /><path d="M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h.01" strokeWidth="2.4" /></>)}
          {g === 'notepad' && (<><path d="M6.5 3.5h8l3 3v14h-11z" /><path d="M9 10h6M9 13.5h6M9 17h3.5" /></>)}
          {g === 'code' && (<><path d="M9 7l-5 5 5 5M15 7l5 5-5 5" /><path d="M13.2 5.5l-2.4 13" /></>)}
          {g === 'chrome' && (<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.2" /><path d="M12 8.8h7.6M9.2 13.6L5.4 7M14.8 13.6l-3.8 6.9" /></>)}
          {g === 'set' && (<><circle cx="9" cy="12" r="5.5" /><circle cx="15" cy="12" r="5.5" /><circle cx="15" cy="12" r="1.2" /></>)}
        </svg>
      )}
    </span>
  )
}
