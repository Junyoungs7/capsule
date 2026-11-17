import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import type { NextItem } from './Island'
import { fmtWhen, until } from './Island'
import { reducedMotion } from './Tile'
import { Ico, type IcoKey } from './Icons'

/* 허브 (a3, 승인 시안): 캡슐을 누르면 모서리에서 위·안쪽으로 펼쳐진다.
   위 = 오늘 (날짜 · 날씨 · 다음 일정 · 할 일 고리), 가운데 = 이름 붙은 아이콘 13개 (색 우물), 아래 = '앱 실행 · 검색'.
   아이콘 = 그 화면을 아일랜드 안에서 (‹ 뒤로). 떠 있는 창은 '떼어낼' 때만 (↗). LP = 바탕화면 소품 (떠 있는 플레이어). */

// (a6) 설정 = 별도 설정 창 (아일랜드 안 화면 아님) · LP = 아일랜드 안 런처 화면 · Link → '연결'
export type ViewKind = 'notes' | 'todo' | 'calendar' | 'chat' | 'term' | 'clips' | 'shelf' | 'ocr' | 'snippets' | 'team' | 'link' | 'lp'
export type HubKind = ViewKind | 'settings'
export const HUB: [HubKind, string, string][] = [
  ['notes', '메모', '--yellow'], ['todo', '할 일', '--orange'], ['calendar', '달력', '--red'], ['chat', '채팅', '--green'], ['term', '터미널', '--gray'],
  ['clips', '최근 복사', '--cyan'], ['shelf', '선반', '--indigo'], ['ocr', 'OCR', '--purple'], ['snippets', '스니펫', '--pink'], ['lp', 'LP', '--brown'],
  ['team', 'Team', '--blue'], ['link', '연결', '--teal'], ['settings', '설정', '--gray'],
]
export const NAME = Object.fromEntries(HUB.map(([k, l]) => [k, l])) as Record<HubKind, string>
export const COLOR = Object.fromEntries(HUB.map(([k, , c]) => [k, c])) as Record<HubKind, string>
/** 안의 화면 [폭, 최대 높이] (논리 px). 높이는 내용에 맞춘다 — 터미널·채팅만 고정 (안을 채우는 화면). 떼어내면 잰 크기로 창이 된다 */
export const FIXED_H = new Set<ViewKind>(['term', 'chat', 'lp', 'team']) // (a8) Team: 펼치고 접어도 크기가 튀지 않게 고정, 안에서 스크롤
export const VIEW_SIZE: Record<ViewKind, [number, number]> = {
  notes: [380, 560], todo: [380, 600], calendar: [480, 620], chat: [400, 480], term: [640, 300], clips: [380, 520], shelf: [360, 480],
  ocr: [360, 300], snippets: [380, 520], team: [400, 560], link: [420, 540], lp: [452, 612],
}
export const VIEWS = Object.keys(VIEW_SIZE) as ViewKind[]
export const DETACHABLE = (k: ViewKind) => k !== 'notes' && k !== 'link' // 메모 = '보드 열기' (보드 창이 떼어낸 모양) · 연결 = 설정 창이 자세한 곳
const ICON: Record<ViewKind, IcoKey> = { notes: 'notes', todo: 'todo', calendar: 'calendar', chat: 'chat', term: 'term', clips: 'clips', shelf: 'shelf', ocr: 'ocr', snippets: 'snippets', team: 'team', link: 'link', lp: 'lp' }

const ring = (p: number, c: string) => {
  const r = 11, L = 2 * Math.PI * r
  return (
    <svg className="ringp" viewBox="0 0 28 28" aria-hidden>
      <circle cx="14" cy="14" r={r} fill="none" stroke="rgba(255,255,255,.14)" strokeWidth="3" />
      <circle cx="14" cy="14" r={r} fill="none" stroke={c} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${L * p} ${L}`} transform="rotate(-90 14 14)" />
    </svg>
  )
}
const todayLabel = (d = new Date()) => `${d.getMonth() + 1}월 ${d.getDate()}일 ${'일월화수목금토'[d.getDay()]}요일`
const hm = (d = new Date()) => `${d.getHours() < 12 ? '오전' : '오후'} ${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`

type HomeProps = {
  next: NextItem | null
  events: number
  todos: { left: number; total: number }
  unread: number
  weather?: { city: string; text: string; temp: number } | null
  onGo: (k: HubKind) => void
  onPalette: () => void
  link?: { cls: string; label: string; title: string; sub: string } | null // (a6) 연결 아이콘 점 + 한 줄
}

export function HubHome({ next, events, todos, unread, weather, onGo, onPalette, link }: HomeProps) {
  return (
    <div className="hub" role="dialog" aria-label="Hera 허브">
      <div className="today">
        <div>
          <div className="date">{todayLabel()}</div>
          <div className="sub">{hm()} · 일정 {events} · 할 일 {todos.left}</div>
        </div>
        {weather && (
          <div className="weather"><Ico k="sun" /><div>{weather.city} {Math.round(weather.temp)}°<small>{weather.text}</small></div></div>
        )}
        <div className="nexts">
          <button className="nx" onClick={() => onGo(next?.kind === 'todo' ? 'todo' : 'calendar')}>
            <i className="bar" style={{ background: next?.kind === 'todo' ? 'var(--orange)' : 'var(--red)' }} />
            <div style={{ minWidth: 0 }}>
              <b>{next ? next.title : '예정된 일정이 없어요'}</b>
              <small>{next ? `${fmtWhen(next.at)}${next.at ? ` · ${until(next.at)}` : ''}` : '달력에서 추가'}</small>
            </div>
          </button>
          <button className="nx" onClick={() => onGo('todo')}>
            {ring(todos.total ? 1 - todos.left / todos.total : 0, 'var(--orange)')}
            <div><b>할 일 {todos.left}개</b><small>{todos.total}개 중 {todos.total - todos.left}개 완료</small></div>
          </button>
        </div>
      </div>
      <div className="grid">
        {HUB.map(([k, l, c]) => (
          <button key={k} className="app" data-go={k} onClick={() => onGo(k)} aria-label={l}>
            <span className="well" style={{ '--c': `var(${c})` } as CSSProperties}>
              <Ico k={k} />
              {k === 'chat' && unread > 0 && <i className="badge">{unread}</i>}
              {k === 'link' && link && <i className={`sdot ${link.cls}`} data-sdot={link.cls} />}
            </span>
            <span>{l}</span>
          </button>
        ))}
      </div>
      {link && link.cls !== 'off' && (
        <button className="linkline" data-go="link" onClick={() => onGo('link')}>
          <span className="well sm" style={{ '--c': 'var(--teal)' } as CSSProperties}><Ico k="link" /></span>
          <span className="tt"><b>{link.title}</b><small>{link.sub}</small></span>
          <span className={`chp lchip ${link.cls}`}><i />{link.label}</span>
        </button>
      )}
      <button className="search" onClick={onPalette}>
        <Ico k="search" />
        <span>앱 실행 · 검색</span>
        <kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>K</kbd>
      </button>
    </div>
  )
}

/** 아일랜드 안 화면 = 머리줄(‹ · 색 우물 · 이름 · ↗) + 몸 */
export function ViewShell({ k, extra, title, onBack, onDetach, children }: { k: ViewKind; extra?: ReactNode; title?: ReactNode; onBack: () => void; onDetach?: () => void; children: ReactNode }) {
  const [w, h] = VIEW_SIZE[k]
  return (
    <div className="view" data-k={k} style={FIXED_H.has(k) ? { width: w, height: h } : { width: w, maxHeight: h }}>
      <div className="vhead">
        <button className="ib" data-back onClick={onBack} aria-label="뒤로"><Ico k="back" /></button>
        <span className="well sm" style={{ '--c': `var(${COLOR[k]})` } as CSSProperties}><Ico k={ICON[k]} /></span>
        {title ?? <b>{NAME[k]}</b>}
        <span className="spacer" />
        {extra}
        {onDetach && DETACHABLE(k) && <button className="ib" data-detach onClick={onDetach} aria-label="떼어내기" title="떼어내기 · 창으로"><Ico k="detach" /></button>}
      </div>
      <div className="vbody">{children}</div>
    </div>
  )
}

/** 떼어낸 창 = 머리줄 40 (손잡이 · 이름 · 'Island로' · 핀 · 닫기 — 최소화 없음) + 몸. 머리줄 끌기는 onBarDown (OS 캡션 끌기 아님) */
export function WinChrome({ k, pin, onPin, onAbsorb, onClose, onBarDown, children, moving, enter }: {
  k: ViewKind; pin?: boolean; onPin?: () => void; onAbsorb?: () => void; onClose?: () => void; onBarDown?: (e: React.PointerEvent<HTMLElement>) => void; children: ReactNode; moving?: boolean
  enter?: 'pre' | 'in' // 떼어내기 등장: 첫 그림 = 'pre' (숨긴 채 그려 둔다) → 보이면 'in'
}) {
  return (
    <div className={`hx win ${moving ? 'moving' : ''}`} data-kind={k} data-enter={enter}>
      <div className="wbar" onPointerDown={onBarDown} onDoubleClick={(e) => e.preventDefault()} title="끌어서 옮기기 · 캡슐에 놓으면 캡슐로 돌아가요">
        <span className="grip" />
        <span className="wt"><span className="well sm" style={{ '--c': `var(${COLOR[k]})` } as CSSProperties}><Ico k={ICON[k]} /></span>{NAME[k]}</span>
        <span className="act">
          <button className="ret" data-absorb onClick={onAbsorb}><Ico k="dock" />캡슐로</button>
          <button data-pin aria-label="항상 위" aria-pressed={!!pin} onClick={onPin}><Ico k="pin" /></button>
          <button className="close" data-wclose aria-label="닫기" onClick={onClose}><Ico k="close" /></button>
        </span>
      </div>
      <div className="wbody"><div className="view" data-k={k}><div className="vbody">{children}</div></div></div>
    </div>
  )
}

/* ── 프레임 기록 (유령이 움직이는 동안만 — 헤드리스 시험이 읽는다) ── */
type W = Window & { __heraFrames?: number[] }
export function recordFrames() {
  const w = window as W
  w.__heraFrames ??= []
  let last = performance.now()
  let on = true
  const tick = (t: number) => {
    if (!on) return
    w.__heraFrames!.push(t - last)
    last = t
    requestAnimationFrame(tick)
  }
  requestAnimationFrame((t) => ((last = t), requestAnimationFrame(tick)))
  return () => void (on = false)
}

/* ── 떼어내기 · 흡수 유령: 단색 판 (흐림 없음), transform/opacity 만 ──
   떼어내기 = 진짜 창이 설 자리(to)에 유령을 두고, 캡슐 모서리에서 출발한 듯 (translate · 0.96 · 반투명) → 제자리. 끝나면 진짜 창을 보이고 유령을 지운다.
   흡수 = 창 자리(from)에서 캡슐로 지니 (가로가 먼저 좁아지고, 모서리로 빨려 들며 사라짐) → 캡슐 '꿀꺽'. */
export type Ghost = { kind: ViewKind; mode: 'detach' | 'absorb'; rect: DOMRect; capsule: DOMRect; hold?: boolean } // hold = 그려 두기만 (바꿔치기 전)
export function GhostLayer({ ghost, render, onDone }: { ghost: Ghost | null; render: (k: ViewKind) => ReactNode; onDone: (g: Ghost) => void }) {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!ghost || !el || ghost.hold) return
    const { rect: r, capsule: c } = ghost
    const rm = reducedMotion()
    const stop = recordFrames()
    let a: Animation
    if (ghost.mode === 'detach') {
      el.style.transformOrigin = '100% 100%'
      a = el.animate(
        rm ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: `translate(${c.right - r.right}px, ${c.bottom - r.bottom}px) scale(.96)`, opacity: 0.5 }, { transform: 'none', opacity: 1 }],
        { duration: rm ? 120 : 480, easing: 'cubic-bezier(.2, 1.2, .35, 1)', fill: 'forwards' },
      )
    } else {
      el.style.transformOrigin = '50% 100%'
      const dx = c.left + c.width / 2 - (r.left + r.width / 2), dy = c.bottom - r.bottom
      a = el.animate(
        rm
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { transform: 'none', opacity: 1 },
              { transform: `translate(${dx * 0.22}px, ${dy * 0.3}px) scale(0.56, 0.9)`, opacity: 1, offset: 0.42 },
              { transform: `translate(${dx}px, ${dy}px) scale(${(c.width / r.width) * 0.7}, ${(c.height / r.height) * 0.7})`, opacity: 0 },
            ],
        { duration: rm ? 160 : 540, easing: 'cubic-bezier(.55, 0, .75, .3)', fill: 'forwards' },
      )
    }
    a.onfinish = () => (stop(), onDone(ghost))
    return () => (stop(), a.cancel())
  }, [ghost])
  if (!ghost) return null
  const r = ghost.rect
  return (
    <div className="ghost-layer hx" aria-hidden>
      <div ref={box} className="ghost-win" data-mode={ghost.mode} style={{ left: r.left, top: r.top, width: r.width, height: r.height }}>
        {render(ghost.kind)}
      </div>
    </div>
  )
}
