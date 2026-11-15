import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { reducedMotion, shape, usePresence } from './Dock'

/* v3 화면 글자 복사: 화면 어둡게 → 십자선으로 영역 드래그(움직이는 점선 + 크기) → 놓으면 스캔 줄이 훑고 → 결과 카드.
   시안: 인식 결과는 가짜 텍스트. 실제 앱 = Rust 가 영역 캡처 → Windows.Media.Ocr (ko/en). */
type Rect = { x: number; y: number; w: number; h: number }
const FAKE = '배너 노출 기간: 2026-11-16 ~ 2026-11-30\n담당: 웹관리팀 · 우선순위 2\n문의 02-1234-5678 / help@example.com\nhttps://example.com/event/winter-sale'

const hole = (r: Rect) =>
  `path(evenodd, "M0,0H${innerWidth}V${innerHeight}H0Z M${r.x},${r.y}h${r.w}v${r.h}h${-r.w}Z")`

export function Ocr({ open, onClose, onToast }: { open: boolean; onClose: () => void; onToast: (msg: string) => void }) {
  const p = usePresence<HTMLDivElement>(open)
  const [phase, setPhase] = useState<'select' | 'scan' | 'result'>('select')
  const [rect, setRect] = useState<Rect | null>(null)
  const dim = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const ants = useRef<HTMLDivElement>(null)
  const size = useRef<HTMLSpanElement>(null)
  const drag = useRef<{ sx: number; sy: number; r: Rect } | null>(null)

  const reset = () => {
    setPhase('select')
    setRect(null)
    drag.current = null
    // 드래그 중 직접 쓴 style 되돌리기 (React 는 같은 prop 이면 DOM 을 건드리지 않는다)
    if (dim.current) dim.current.style.clipPath = ''
    if (box.current) box.current.hidden = true
  }
  useEffect(() => void (open && reset()), [open])
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [open])

  // 드래그 중엔 React 렌더 없이 style 만 쓴다
  const paint = (r: Rect) => {
    dim.current!.style.clipPath = hole(r)
    box.current!.style.transform = `translate(${r.x}px, ${r.y}px)`
    box.current!.style.width = r.w + 'px'
    box.current!.style.height = r.h + 'px'
    box.current!.hidden = false
    ants.current!.style.clipPath = shape(0, 0, r.w, r.h, 3).ring
    size.current!.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`
  }
  const down = (e: PointerEvent) => {
    if (phase !== 'select' || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { sx: e.clientX, sy: e.clientY, r: { x: e.clientX, y: e.clientY, w: 0, h: 0 } }
  }
  const move = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    d.r = { x: Math.min(d.sx, e.clientX), y: Math.min(d.sy, e.clientY), w: Math.abs(e.clientX - d.sx), h: Math.abs(e.clientY - d.sy) }
    paint(d.r)
  }
  const up = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.r.w < 12 || d.r.h < 12) return reset()
    setRect(d.r)
    setPhase(reducedMotion() ? 'result' : 'scan')
  }

  const done = (msg: string, copy: boolean) => {
    if (copy) void navigator.clipboard?.writeText(FAKE).catch(() => {})
    onToast(msg)
    onClose()
  }

  if (!p.mounted) return null
  // 결과 카드: 영역 아래(공간 없으면 위), 화면 안으로
  const cw = rect ? Math.min(420, Math.max(300, rect.w)) : 0
  const below = rect && rect.y + rect.h + 230 < innerHeight
  const card = rect && { left: Math.max(12, Math.min(innerWidth - cw - 12, rect.x)), top: below ? rect.y + rect.h + 12 : Math.max(12, rect.y - 222), width: cw }
  return (
    <div ref={p.ref} className="ocr" data-phase={phase} onTransitionEnd={p.onTransitionEnd} onPointerDown={down} onPointerMove={move} onPointerUp={up} role="dialog" aria-label="화면 글자 복사">
      <div ref={dim} className="ocr-dim" style={rect ? { clipPath: hole(rect) } : undefined} />
      {phase === 'select' && !rect && <div className="ocr-hint glass-card">드래그해서 글자를 읽을 영역을 고르세요 <kbd>Esc</kbd></div>}
      <div ref={box} className="ocr-box" hidden={!rect} style={rect ? { transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w, height: rect.h } : undefined}>
        <div ref={ants} className="ocr-ants" style={rect ? { clipPath: shape(0, 0, rect.w, rect.h, 3).ring } : undefined} />
        <span ref={size} className="ocr-size" />
        {phase === 'scan' && <i className="ocr-scan" style={{ '--h': `${rect!.h}px` } as React.CSSProperties} onAnimationEnd={() => setPhase('result')} />}
      </div>
      {phase === 'result' && card && (
        <div className="ocr-card glass-card" style={card} onPointerDown={(e) => e.stopPropagation()}>
          <header>
            <b>인식한 글자</b>
            <small>한국어 · 영어 · 4줄</small>
          </header>
          <pre className="ocr-text">{FAKE}</pre>
          <div className="ocr-actions">
            <button onClick={reset}>다시</button>
            <button onClick={() => done('선반에 저장했어요 · 인식한 글자.txt', false)}>선반에 저장</button>
            <button className="primary" autoFocus onClick={() => done('복사했어요', true)}>복사</button>
          </div>
        </div>
      )}
    </div>
  )
}
