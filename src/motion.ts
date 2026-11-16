/* Hera 모션 팩 (a6, 승인: motion-pack.html). 진짜 스프링(강성/감쇠 → CSS linear())을 시작할 때 한 번 계산해 :root 변수로.
   움직임은 '변화가 있을 때만' 합성기로 재생 (transform·opacity) — 쉬는 동안 도는 루프 없음, 움직이는 층에 필터 없음.
   '동작 줄이기'면 켜지 않는다 (html.mx 없음 → 예전의 차분한 곡선). 아일랜드 · 설정 · LP · 떠 있는 창 모두 이 파일 하나. */

/** 강성 k · 감쇠 c (질량 1) → CSS linear() + 정착 시간 */
export function spring(k: number, c: number) {
  const dt = 1 / 600, xs: number[] = []
  let x = 0, v = 0, settle = 0
  for (let i = 1; i <= 1800; i++) {
    v += (-k * (x - 1) - c * v) * dt
    x += v * dt
    xs.push(x)
    if (Math.abs(x - 1) > 0.003 || Math.abs(v) > 0.03) settle = i * dt
  }
  const T = Math.min(3, settle + 0.03), n = 40, pts: number[] = []
  for (let i = 0; i <= n; i++) pts.push(+xs[Math.max(0, Math.min(xs.length - 1, Math.round((T * i) / n / dt) - 1))].toFixed(4))
  pts[0] = 0
  pts[n] = 1
  return { ease: `linear(${pts.join(', ')})`, ms: Math.round(T * 1000) }
}
export const SP = { settle: spring(280, 22), soft: spring(260, 24), pop: spring(520, 16), fade: spring(420, 32), lead: spring(620, 36), w: spring(380, 24), h: spring(300, 22) }
export const STAGGER = 45

const RM = () => matchMedia('(prefers-reduced-motion: reduce)').matches
export const motionOn = () => !RM() && document.documentElement.classList.contains('mx')

const anim = (el: Element | null, kf: Keyframe[], o: KeyframeAnimationOptions) => (motionOn() && el ? el.animate(kf, { fill: 'backwards', ...o }) : null)
/** 줄 단위로 떠오르기 (perRow 개씩 45ms 차이) */
export const rise = (els: Element[], { dy = 8, scale = 1, delay = 0, step = STAGGER, perRow = 1, s = SP.fade } = {}) =>
  els.forEach((el, i) => anim(el, [{ opacity: 0, transform: `translateY(${dy}px) scale(${scale})` }, { opacity: 1, transform: 'none' }], { duration: s.ms, easing: s.ease, delay: delay + Math.floor(i / perRow) * step }))

/* 늘어나는 선택 알약: 예전 .on 자리에서 새 .on 자리로 날아가며 가는 방향으로 늘어났다 돌아온다 (≤1.6배) */
export const SEGS = '.seg, .pettabs, .navlist, .tabs2, .filters, .sizes'
function flyPill(c: HTMLElement, to: HTMLElement, from: DOMRect) {
  const cr = c.getBoundingClientRect(), tr = to.getBoundingClientRect(), sc = cr.width / c.offsetWidth || 1
  const pill = document.createElement('i')
  pill.className = 'mx-pill'
  const cs = getComputedStyle(to)
  pill.style.cssText = `left:${(tr.left - cr.left) / sc - c.clientLeft}px;top:${(tr.top - cr.top) / sc - c.clientTop}px;width:${tr.width / sc}px;height:${tr.height / sc}px;border-radius:${cs.borderRadius};${cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? '' : `background:${cs.backgroundColor};`}box-shadow:${cs.boxShadow}`
  c.classList.add('mx-pillhost')
  to.classList.add('mx-hidebg')
  c.prepend(pill)
  const dx = (from.left - tr.left) / sc, dy = (from.top - tr.top) / sc, sx = from.width / tr.width, sy = from.height / tr.height
  const vert = Math.abs(dy) > Math.abs(dx)
  const stretch = 1 + Math.min(0.6, (vert ? Math.abs(dy) / (tr.height / sc) : Math.abs(dx) / (tr.width / sc)) * 0.22)
  const mid = vert ? `translate(0, ${dy * 0.35}px) scale(1, ${stretch})` : `translate(${dx * 0.35}px, 0) scale(${stretch}, 1)`
  const a = pill.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { offset: 0.38, transform: mid }, { transform: 'none' }], { duration: SP.settle.ms, easing: SP.lead.ease })
  a.onfinish = a.oncancel = () => (pill.remove(), to.classList.remove('mx-hidebg'))
}

let installed = false
/** 한 번: 변수 · 클릭 가로채기(알약·스위치) · DOM 변화 관찰(새 허브·화면·알림·섹션) */
export function installMotion() {
  if (installed) return
  installed = true
  const root = document.documentElement
  if (RM()) return
  for (const [k, s] of Object.entries(SP)) (root.style.setProperty(`--sp-${k}`, s.ease), root.style.setProperty(`--sp-${k}-ms`, `${s.ms}ms`))
  root.classList.add('mx')

  addEventListener('click', (e) => {
    if (!motionOn()) return
    const btn = (e.target as Element).closest?.('button')
    const c = btn?.parentElement?.matches(SEGS) ? btn.parentElement : null
    const cur = c?.querySelector<HTMLElement>(':scope > .on, :scope > [aria-current="true"], :scope > [aria-pressed="true"]')
    if (!c || !cur || cur === btn) return
    const from = cur.getBoundingClientRect(), idx = [...c.children].indexOf(btn!)
    requestAnimationFrame(() => {
      if (!c.isConnected) return
      const to = c.querySelector<HTMLElement>(':scope > .on, :scope > [aria-current="true"], :scope > [aria-pressed="true"]')
      if (to && [...c.children].indexOf(to) === idx) flyPill(c, to, from)
    })
  }, true)

  /* 스위치 손잡이: 가는 쪽으로 늘어났다 작게 튕기며 자리 */
  addEventListener('click', (e) => {
    if (!motionOn()) return
    const sw = (e.target as Element).closest?.('.sw') as HTMLElement | null
    if (!sw) return
    const was = sw.classList.contains('on')
    requestAnimationFrame(() => {
      const now = sw.classList.contains('on')
      if (!sw.isConnected || now === was) return
      const [a, b] = now ? [0, 16] : [16, 0]
      sw.animate([{ transform: `translateX(${a}px)` }, { offset: 0.4, transform: `translateX(${(a + b) / 2 + (now ? -2 : 2)}px) scaleX(1.34)` }, { transform: `translateX(${b}px)` }],
        { duration: SP.settle.ms, easing: SP.settle.ease, pseudoElement: '::after', fill: 'forwards' }).onfinish = function (this: Animation) { this.cancel() }
    })
  }, true)

  /* DOM 변화 → 새로 나타난 것만 한 번 (제자리 갱신은 건드리지 않음) */
  const seen = new WeakSet<Element>()
  let lastAlert = ''
  const scan = () => {
    const hub = document.querySelector('.isl .hub')
    if (hub && !seen.has(hub)) {
      seen.add(hub)
      rise([...hub.querySelectorAll('.app')], { dy: 6, scale: 0.94, perRow: 5, s: SP.settle, delay: 90 })
      rise([...hub.children].filter((x) => !x.matches('.grid')), { dy: 4, step: 60 })
    }
    document.querySelectorAll('.isl .content .view, .swin .pane-in, .lpv .crate-in').forEach((v) => {
      if (seen.has(v)) return
      seen.add(v)
      const body = v.matches('.view') ? v.querySelector('.vbody') : v
      if (body) rise([...body.children].filter((x) => !x.matches('.vtoast, .toast')).slice(0, 8), { dy: 6, delay: v.matches('.view') ? 120 : 30, perRow: v.matches('.crate-in') ? 4 : 1, scale: v.matches('.crate-in') ? 0.94 : 1, s: v.matches('.crate-in') ? SP.settle : SP.fade })
    })
    // 캡슐 알림: 두 줄이 차례로 굴러 올라온다
    const isl = document.querySelector<HTMLElement>('.isl')
    const pt = document.querySelector('.isl .ptext:not(.measure)'), t = pt?.textContent ?? ''
    if (isl?.dataset.mode === 'alert' && pt && t && t !== lastAlert) (lastAlert = t, rise([...pt.children].slice(0, 2), { dy: 10, delay: 140, s: SP.settle }))
    if (isl && isl.dataset.mode !== 'alert') lastAlert = ''
  }
  new MutationObserver(() => motionOn() && scan()).observe(document.body, { childList: true, subtree: true })
}

/** 숫자 굴리기 (스테퍼): 오르면 아래에서, 내리면 위에서 · 한계에서 누르면 옆으로 툭 */
export function rollNumber(el: HTMLElement | null, dir: 1 | -1, atLimit: boolean) {
  if (!el || !motionOn()) return
  if (atLimit) return void el.animate([{ transform: 'none' }, { transform: `translateX(${dir * 5}px)` }, { transform: `translateX(${-dir * 2}px)` }, { transform: 'none' }], { duration: 320, easing: 'ease-out' })
  el.animate([{ opacity: 0, transform: `translateY(${dir * 12}px)` }, { opacity: 1, transform: 'none' }], { duration: SP.settle.ms, easing: SP.settle.ease })
}

/** 페어링 숫자: 하나씩 떨어지기 · '같아요' → 가운데로 모여 초록 '연결됨' 알약 */
export function dropDigits(code: HTMLElement | null) {
  if (!code) return
  rise([...code.querySelectorAll('span')], { dy: -14, s: SP.pop, delay: 60 })
}
export function mergeDigits(code: HTMLElement, then: () => void) {
  if (!motionOn()) return then()
  const cr = code.getBoundingClientRect(), cx = cr.left + cr.width / 2
  const ds = [...code.querySelectorAll('span')]
  ds.forEach((s, i) => {
    const r = s.getBoundingClientRect()
    s.animate([{ transform: 'none', opacity: 1 }, { transform: `translateX(${cx - (r.left + r.width / 2)}px) scale(.5)`, opacity: 0 }], { duration: 260, delay: Math.abs(i - (ds.length - 1) / 2) * 22, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' })
  })
  setTimeout(() => {
    const ok = document.createElement('span')
    ok.className = 'mx-ok'
    ok.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5.5 12.5l4 4 9-9"/></svg>연결됨'
    code.style.position = 'relative'
    ok.style.cssText = 'position:absolute;left:50%;top:50%;translate:-50% -50%'
    code.append(ok)
    ok.animate([{ transform: 'scale(.4)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: SP.pop.ms, easing: SP.pop.ease })
    setTimeout(then, 620)
  }, 300)
}
