import { useLayoutEffect, useRef, useState, type TransitionEvent } from 'react'

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** 열기·닫기 모두 애니메이션: 마운트 → reflow → data-show=true. 닫기 → data-show=false → opacity transitionend → 언마운트. */
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
