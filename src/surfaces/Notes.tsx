import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import type { LpRecord } from '../data/types'
import { isTauri, onStore, storeGet, storeSet, useItems } from '../data/api'
import { Tile, reducedMotion, usePresence } from './Tile'
import { Ocr } from './Ocr'
import type { Tab } from './Panel'
import { Avatar, groupOf } from './Team'
import { EMPTY, STRESS } from '../data/mock'

/* v3 바탕화면 포스트잇 · 앱별 메모 · 화면 글자 복사(OCR) 레이어.
   표면 사이 상태(메모 펼침/접힘, OCR 열림)는 작은 모듈 저장소 — 독 아이템·팔레트·데모 바가 같은 값을 본다. */
type V3 = { notes: boolean; ocr: boolean }
let st: V3 = { notes: true, ocr: false }
const subs = new Set<() => void>()
const notify = (p: Partial<V3>) => ((st = { ...st, ...p }), subs.forEach((f) => f()))
// 실제 앱: 메모 펼침/접힘은 store `notes.shown` — 독 버튼·메모 창들·Rust(메모 창 생성/파괴)가 같은 값을 본다
export const setV3 = (p: Partial<V3>) => (notify(p), isTauri && p.notes !== undefined && storeSet('notes.shown', p.notes))
if (isTauri) {
  void storeGet<boolean>('notes.shown').then((v) => v !== undefined && v !== null && notify({ notes: v }))
  onStore((k, v) => k === 'notes.shown' && notify({ notes: v !== false }))
}
export const useV3 = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => st)

// 메모: 키 note:<id>. appId = 이 앱이 앞에 있을 때만 화면 오른쪽 가장자리에 붙는 메모 (바탕화면엔 안 보임)
// group = Hera Team 공유 메모판 id (그룹 색 테두리 + 마지막 편집자), by = 마지막 편집자
export type Note = { id: string; text: string; color: number; x: number; y: number; w: number; h: number; pinned: boolean; appId?: string; group?: string; by?: string }
export const NOTE_COLORS = ['#f5c542', '#f47fb0', '#5bb8f5', '#42c9a0', '#a78bfa', '#f59e6b']
const COLOR_NAMES = ['노랑', '분홍', '하늘', '민트', '라벤더', '살구']

const seedNotes: Note[] = [
  { id: 'n1', text: '오늘 3시 배너 QA\n디자인팀 피드백 반영본으로 확인', color: 0, x: 330, y: 96, w: 220, h: 150, pinned: false },
  { id: 'n2', text: '- [x] 주간 보고 초안\n- [ ] 휴가 신청 (12/24)\n- [ ] 노트북 반납\n- [ ] 회의록 공유', color: 3, x: 576, y: 128, w: 230, h: 170, pinned: true },
  { id: 'n3', text: '와이파이 HERA-5G\nhera2026!', color: 4, x: 360, y: 272, w: 196, h: 118, pinned: false },
  { id: 'n5', text: '배포 체크리스트\n- [x] QA 확인\n- [ ] 릴리즈 노트', color: 3, x: 590, y: 318, w: 220, h: 140, pinned: false, group: 'tg-dev', by: '민수' },
  { id: 'n4', text: '- [ ] PR #142 리뷰 코멘트 반영\n- [x] lint 통과\n배포 전 .env.production 확인!', color: 2, x: 0, y: 0, w: 248, h: 150, pinned: false, appId: 'vscode' },
]

if (STRESS)
  seedNotes.push(
    { id: 'qn1', text: '아주 긴 메모 — Hera Team 동기화 규칙 정리: 항목별 최종 수정 우선, 삭제는 표시만 하고 7일 뒤 정리, 늦게 켠 PC 는 온라인 그룹원 누구에게서든 따라잡는다. Long English line without spaces: https://example.com/a/very/long/url/that/should/wrap/inside/the/note/body/without/overflowing', color: 1, x: 830, y: 96, w: 210, h: 140, pinned: false },
    { id: 'qn2', text: '- [ ] 하나\n- [ ] 둘\n- [ ] 셋\n- [ ] 넷\n- [ ] 다섯\n- [ ] 여섯\n- [ ] 일곱\n- [ ] 여덟', color: 5, x: 860, y: 260, w: 200, h: 130, pinned: false },
    { id: 'qn3', text: '', color: 2, x: 1080, y: 120, w: 180, h: 110, pinned: false },
    { id: 'qn4', text: 'VS Code 두 번째 메모 — 앱 메모가 여러 장이면 아래로 쌓인다', color: 4, x: 0, y: 0, w: 248, h: 150, pinned: false, appId: 'vscode' },
  )
if (EMPTY) seedNotes.length = 0

const CHECK = /^- \[( |x)\] ?/i

// 접힘 목표: 화면 맨 위 가운데 노치 (메모 창은 모니터 전체 — 노치는 다른 창이라 위치만 안다)
function dockTarget() {
  const isl = document.querySelector('.island-shape')?.getBoundingClientRect()
  return isl ? { x: isl.left + isl.width / 2, y: isl.top + isl.height / 2 } : { x: innerWidth / 2, y: 0 }
}

/* ── 앱 메모 자리: 붙은 앱 창(anchor) 옆 ──────────────────────────────
   오른쪽 → 안 되면 왼쪽 → 그래도 안 되면 창 안 오른쪽 위. 화면 가장자리·Island(위 가운데)·독(아래)과 띄우고 화면 밖으로 안 나간다.
   anchor 가 없으면 화면 오른쪽 가운데. 여러 장이면 아래로 쌓는다. */
export const APP_NOTE = { w: 248, h: 168, gap: 12, edge: 16 }
export function placeAppNote(a: DOMRect | null, i: number, W = innerWidth, H = innerHeight) {
  const { w, h, gap, edge } = APP_NOTE
  const top = 64 // Island 접힘(36) + 여백
  const bottom = H - (H < 820 ? 132 : 150) // 독 영역 위
  const island = { l: W / 2 - 220, r: W / 2 + 220, b: 150 } // 펼친 Island(알림 122 + 위 8) + 여백
  let x: number, y: number, side: 'right' | 'left' | 'inside'
  if (!a) {
    side = 'right'
    x = W - edge - w
    y = H / 2 - h / 2
  } else if (a.right + gap + w <= W - edge) {
    side = 'right'
    x = a.right + gap
    y = a.top + 44
  } else if (a.left - gap - w >= edge) {
    side = 'left'
    x = a.left - gap - w
    y = a.top + 44
  } else {
    side = 'inside'
    x = Math.min(a.right, W - edge) - w - 16
    y = a.top + 48
  }
  y += i * (h + 10)
  y = Math.max(top, Math.min(y, bottom - h))
  if (x < island.r && x + w > island.l && y < island.b) y = island.b
  return { x: Math.max(edge, x), y, side }
}

// 시안: 붙은 앱의 그럴듯한 창 자리 (데모 카드 오른쪽 영역에 창 + 메모가 함께 들어가게 가운데 정렬)
function mockWindow(W = innerWidth, H = innerHeight) {
  const left = 320, side = APP_NOTE.gap + APP_NOTE.w + APP_NOTE.edge + 8 // 오른쪽에 메모 자리
  const w = Math.max(420, Math.min(860, W * 0.56, W - left - side)), h = Math.min(580, H * 0.62)
  const x = left + Math.max(0, (W - left - side - w) / 2)
  return new DOMRect(x, Math.max(84, (H - h) / 2 - 40), w, h)
}

function useViewport() {
  const [, set] = useState(0)
  useEffect(() => {
    const f = () => set((n) => n + 1)
    addEventListener('resize', f)
    return () => removeEventListener('resize', f)
  }, [])
}

/** 시안 전용 앱 창 (앱 메모가 붙을 자리를 보여 주기 위한 가짜 창) */
function MockWindow({ rec, rect }: { rec?: LpRecord; rect: DOMRect }) {
  const p = usePresence<HTMLDivElement>(true)
  return (
    <div ref={p.ref} className="mock-win" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} aria-hidden>
      <header>
        {rec && <Tile rec={rec} size={16} />}
        <b>{rec ? `hera — ${rec.title}` : '앱'}</b>
        <span className="mock-ctl"><i /><i /><i /></span>
      </header>
      <div className="mock-body">
        {Array.from({ length: 14 }, (_, i) => <span key={i} style={{ width: `${30 + ((i * 37) % 55)}%`, marginLeft: `${(i % 4) * 4}%` }} />)}
      </div>
    </div>
  )
}

/* ── 레이어 (시안: 가짜 바탕화면 위) ── */
// anchor = 지금 앞에 있는 앱 창 rect (실제 앱에서 넘겨줌). 없으면 시안은 가짜 창을 그려 그 옆에 붙인다.
// 허브 시안: 바깥(허브 '새 메모'·'앱 메모')에서 메모 만들기
let addReq: ((appId?: string, text?: string, group?: string, by?: string) => void) | null = null
export const newNote = (appId?: string, text?: string, group?: string, by?: string) => addReq?.(appId, text, group, by)
export function V3Layer({ records, fgId, anchor }: { records: LpRecord[]; fgId?: string; anchor?: DOMRect }) {
  const { notes: shown, ocr } = useV3()
  const [notes, setNotes] = useItems<Note>('note', seedNotes)
  const [front, setFront] = useState<string | null>(null)
  const [fresh, setFresh] = useState<string | null>(null) // 방금 만든 메모 → 바로 편집
  const [toast, setToast] = useState<{ msg: string; n: number } | null>(null)
  const layer = useRef<HTMLDivElement>(null)

  const patch = (id: string, p: Partial<Note>) => setNotes((all) => all.map((n) => (n.id === id ? { ...n, ...p } : n)))
  const add = (from?: Note, appId?: string, text = '', group?: string, by?: string) => {
    const id = crypto.randomUUID()
    setNotes((all) => [...all, { id, color: from ? (from.color + 1) % 6 : appId ? 3 : 0, x: (from?.x ?? 420) + 28, y: (from?.y ?? 140) + 28, w: appId ? 248 : 210, h: appId ? 150 : 140, pinned: false, appId, text, group, by }])
    setFront(id)
    setFresh(id)
    setV3({ notes: true })
  }
  addReq = (appId, text, group, by) => add(undefined, appId, text, group, by)
  // 실제 앱: 허브 '+ 새 메모' 는 아일랜드 창이 store 에 메모를 쓰고 `note.edit` = id → 메모 창이 그 메모를 바로 편집 상태로
  useEffect(() => {
    if (!isTauri) return
    const edit = (id: unknown) => typeof id === 'string' && id && (setFront(id), setFresh(id))
    void storeGet<string>('note.edit').then(edit)
    return onStore((k, v) => k === 'note.edit' && edit(v))
  }, [])
  const say = (msg: string) => setToast((t) => ({ msg, n: (t?.n ?? 0) + 1 }))

  // 시안 단축키: Ctrl+Alt+T = 화면 글자 복사 (실제 앱 = Rust 전역 단축키)
  useEffect(() => {
    if (isTauri) return
    const k = (e: KeyboardEvent) => e.ctrlKey && e.altKey && e.key.toLowerCase() === 't' && (e.preventDefault(), setV3({ ocr: true }))
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [])

  // 접기 = 각 메모가 독 아이콘으로 빨려 들어감(지니 느낌: 먼저 세로로 늘며 좁아지고 → 점으로), 펼치기 = 같은 경로 역재생
  const first = useRef(true)
  useLayoutEffect(() => {
    if (first.current) return void (first.current = false)
    const t = dockTarget()
    const cards = [...layer.current!.querySelectorAll<HTMLElement>('.desk-notes .note')]
    cards.forEach((card, i) => {
      card.getAnimations().forEach((a) => a.cancel())
      const r = card.getBoundingClientRect()
      const dx = t.x - (r.left + r.width / 2), dy = t.y - (r.top + r.height / 2)
      const frames = reducedMotion()
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { transform: 'none', opacity: 1 },
            { transform: `translate(${dx * 0.18}px, ${dy * 0.42}px) scale(0.62, 0.9)`, opacity: 1, offset: 0.42 },
            { transform: `translate(${dx}px, ${dy}px) scale(0.05, 0.1)`, opacity: 0 },
          ]
      const a = card.animate(frames, {
        duration: reducedMotion() ? 180 : 560,
        delay: (shown ? cards.length - 1 - i : i) * 45,
        easing: 'cubic-bezier(0.5, 0, 0.75, 0.25)',
        direction: shown ? 'reverse' : 'normal',
        fill: 'both',
      })
      if (shown) a.onfinish = () => a.cancel()
    })
  }, [shown])

  const desk = notes.filter((n) => !n.appId)
  useViewport()
  const appNotes = notes.filter((n) => n.appId && n.appId === fgId)
  const mock = !anchor && !isTauri && appNotes.length > 0
  const win = anchor ?? (mock ? mockWindow() : null)
  return (
    <div ref={layer} className="v3-layer">
      <div className="desk-notes" data-shown={shown}>
        {desk.map((n) => (
          <NoteCard key={n.id} n={n} records={records} z={n.pinned ? (front === n.id ? 41 : 40) : front === n.id ? 7 : 6} edit={fresh === n.id}
            onFront={() => setFront(n.id)} onPatch={(p) => patch(n.id, p)} onNew={() => add(n)} onDelete={() => setNotes((all) => all.filter((x) => x.id !== n.id))} />
        ))}
      </div>
      {mock && win && <MockWindow rec={records.find((r) => r.id === fgId)} rect={win} />}
      {notes.filter((n) => n.appId).map((n) => {
        const i = appNotes.indexOf(n)
        return (
          <AppNote key={n.id} open={i >= 0} at={placeAppNote(win, Math.max(0, i))}>
            <NoteCard n={n} records={records} edge onPatch={(p) => patch(n.id, p)} onDelete={() => setNotes((all) => all.filter((x) => x.id !== n.id))} />
          </AppNote>
        )
      })}
      <Ocr open={ocr} onClose={() => setV3({ ocr: false })} onToast={say} />
      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  )
}

/** 앱 메모 한 장: 자리(left/top)는 고정값, 등장은 붙은 쪽에서 살짝 밀려 나오는 스프링 (transform·opacity 만) */
function AppNote({ open, at, children }: { open: boolean; at: { x: number; y: number; side: string }; children: React.ReactNode }) {
  const p = usePresence<HTMLDivElement>(open)
  if (!p.mounted) return null
  return (
    <div ref={p.ref} className="app-note" data-side={at.side} style={{ left: at.x, top: at.y, width: APP_NOTE.w, height: APP_NOTE.h }} onTransitionEnd={p.onTransitionEnd}>
      {children}
    </div>
  )
}

/* 메모 카드. 바(위 22px)를 끌어 이동, 오른쪽 아래 모서리로 크기. 이동·크기 중엔 style 직접 쓰고 놓을 때 저장. */
function NoteCard({ n, records, z, edge, edit: edit0, onFront, onPatch, onNew, onDelete }: {
  n: Note
  records: LpRecord[]
  z?: number
  edge?: boolean
  edit?: boolean
  onFront?: () => void
  onPatch: (p: Partial<Note>) => void
  onNew?: () => void
  onDelete: () => void
}) {
  const pos = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const [edit, setEdit] = useState(!!edit0)
  const [pop, setPop] = useState<'color' | 'app' | null>(null)
  const app = n.appId ? records.find((r) => r.id === n.appId) : undefined
  const g = groupOf(n.group)
  const editor = g?.members.find((m) => m.name === n.by)

  // 새 메모: 살짝 튀어나오며 등장
  useLayoutEffect(() => {
    if (edit0 && !reducedMotion()) card.current!.animate([{ transform: 'scale(0.86)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 600, easing: getComputedStyle(document.documentElement).getPropertyValue('--spring-bouncy') })
  }, [])

  // 사라짐(삭제·앱에 붙이기)도 애니메이션 후 반영
  const leave = (then: () => void) => {
    const a = card.current!.animate([{ opacity: 1 }, { transform: reducedMotion() ? 'none' : 'scale(0.9) translateY(6px)', opacity: 0 }], { duration: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' })
    a.onfinish = then
  }

  const grab = (e: RPointerEvent, kind: 'move' | 'size') => {
    if (edge || (e.target as Element).closest('button') && kind === 'move') return
    onFront?.()
    const el = pos.current!, sx = e.clientX, sy = e.clientY
    let { x, y, w, h } = n
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy
      if (kind === 'move') {
        x = Math.max(0, Math.min(innerWidth - 60, n.x + dx))
        y = Math.max(0, Math.min(innerHeight - 40, n.y + dy))
        el.style.transform = `translate(${x}px, ${y}px)`
      } else {
        w = Math.max(160, n.w + dx)
        h = Math.max(96, n.h + dy)
        el.style.width = w + 'px'
        el.style.height = h + 'px'
      }
    }
    const up = () => (removeEventListener('pointermove', move), removeEventListener('pointerup', up), onPatch({ x, y, w, h }))
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  const lines = n.text.split('\n')
  const toggle = (i: number) => onPatch({ text: lines.map((l, j) => (j === i ? l.replace(CHECK, (m) => (/x/i.test(m) ? '- [ ] ' : '- [x] ')) : l)).join('\n') })

  return (
    <div ref={pos} className="note-pos" style={edge ? undefined : { transform: `translate(${n.x}px, ${n.y}px)`, width: n.w, height: n.h, zIndex: z }} onPointerDown={onFront}>
      <div ref={card} className="note" data-pinned={n.pinned} data-group={!!g} style={{ '--nc': NOTE_COLORS[n.color], ...(g && { '--g': g.color }) } as CSSProperties}>
        {g && <i className="note-gbar" aria-hidden />}
        <header className="note-bar" onPointerDown={(e) => grab(e, 'move')}>
          {g && <span className="note-group" title={`${g.name} 공유 메모 · ${n.by} 마지막 편집`}><Avatar m={editor ?? { name: n.by ?? '?', online: false }} color={g.color} size={16} /><small>{g.name}</small></span>}
          {app && <span className="note-app" title={`${app.title} 메모`}><Tile rec={app} size={18} /><small>{app.title}</small></span>}
          {!edge && <button onClick={onNew} aria-label="새 메모" title="새 메모"><Ico d="M12 6v12M6 12h12" /></button>}
          <span className="grow" />
          <button onClick={() => setPop(pop === 'color' ? null : 'color')} aria-label="색 바꾸기" title="색"><i className="note-swatch" /></button>
          <button onClick={() => setPop(pop === 'app' ? null : 'app')} aria-label="앱에 붙이기" title="앱에 붙이기" aria-pressed={!!n.appId}><Ico d="M9.5 14.5l5-5M8 11l-2 2a3.5 3.5 0 0 0 5 5l2-2M16 13l2-2a3.5 3.5 0 0 0-5-5l-2 2" /></button>
          {!edge && <button onClick={() => onPatch({ pinned: !n.pinned })} aria-pressed={n.pinned} aria-label="항상 위" title={n.pinned ? '항상 위 끄기' : '항상 위'}><Ico d="M9 4h6l-1 5 3 3H7l3-3zM12 12v8" /></button>}
          <button onClick={() => leave(onDelete)} aria-label="메모 삭제" title="삭제"><Ico d="M7 7l10 10M17 7L7 17" /></button>
        </header>
        {pop === 'color' && (
          <div className="note-pop note-colors" role="group" aria-label="메모 색">
            {NOTE_COLORS.map((c, i) => (
              <button key={c} style={{ '--nc': c } as CSSProperties} aria-pressed={n.color === i} aria-label={COLOR_NAMES[i]} onClick={() => (onPatch({ color: i }), setPop(null))} />
            ))}
          </div>
        )}
        {pop === 'app' && (
          <div className="note-pop note-apps" role="menu" aria-label="앱에 붙이기">
            <small>이 앱이 앞에 있을 때만 화면 가장자리에 보여요</small>
            {records.filter((r) => r.kind === 'single').map((r) => (
              <button key={r.id} role="menuitem" aria-pressed={n.appId === r.id} onClick={() => (setPop(null), n.appId === r.id || (edge ? onPatch({ appId: r.id }) : leave(() => onPatch({ appId: r.id }))))}>
                <Tile rec={r} size={18} /> {r.title}
              </button>
            ))}
            {n.appId && <button role="menuitem" onClick={() => (setPop(null), onPatch({ appId: undefined, x: innerWidth / 2 - 120, y: 160 }))}>바탕화면으로 떼기</button>}
          </div>
        )}
        {edit ? (
          <textarea className="note-body" autoFocus value={n.text} onChange={(e) => onPatch({ text: e.target.value })} onBlur={() => setEdit(false)} placeholder="메모 · '- [ ] ' 로 시작하면 체크리스트" aria-label="메모 내용" />
        ) : (
          <div className="note-body" onClick={(e) => (e.target as Element).closest('label') || setEdit(true)}>
            {!n.text && <p className="note-ph">메모를 입력하세요</p>}
            {lines.map((l, i) =>
              CHECK.test(l) ? (
                <label key={i} className="note-check" data-done={/x/i.test(l.slice(3, 4))}>
                  <input type="checkbox" checked={/x/i.test(l.slice(3, 4))} onChange={() => toggle(i)} />
                  <span>{l.replace(CHECK, '')}</span>
                </label>
              ) : (
                <p key={i}>{l || ' '}</p>
              ),
            )}
          </div>
        )}
        {!edge && <i className="note-resize" onPointerDown={(e) => grab(e, 'size')} aria-hidden />}
      </div>
    </div>
  )
}

const Ico = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>

function Toast({ toast, onDone }: { toast: { msg: string; n: number } | null; onDone: () => void }) {
  const p = usePresence<HTMLDivElement>(!!toast)
  const last = useRef('')
  if (toast) last.current = toast.msg
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(onDone, 1800)
    return () => clearTimeout(t)
  }, [toast?.n])
  if (!p.mounted) return null
  return <div ref={p.ref} className="v3-toast glass-card" role="status" onTransitionEnd={p.onTransitionEnd}><span className="v3-ok" />{last.current}</div>
}

/* ── 데모 바 'v3' 묶음 (시안 전용) ── */
export function V3Demo({ records, fgId, onApp, onPanel, onPalette }: {
  records: LpRecord[]
  fgId?: string
  onApp: (r: LpRecord) => void
  onPanel: (t: Tab) => void
  onPalette: () => void
}) {
  const { notes } = useV3()
  // 앱 메모 데모: 메모가 붙은 VS Code ↔ Chrome 을 번갈아 앞으로
  const appSwitch = () => {
    const r = records.find((x) => x.id === (fgId === 'vscode' ? 'chrome' : 'vscode'))
    if (r) onApp(r)
  }
  const snippets = () => {
    onPalette()
    // 팔레트 입력에 ';' 를 넣어 상용구 목록을 연다 (React onChange 가 받도록 네이티브 setter + input 이벤트)
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLInputElement>('.palette-input input')
      if (!el) return
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, ';')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  return (
    <>
      <header className="demo-sub">
        <b>v3</b>
        <small>메모 · 달력 · 글자 복사 · 상용구</small>
      </header>
      <div className="demo-btns v3">
        <button aria-pressed={notes} onClick={() => setV3({ notes: !notes })}>메모 {notes ? '접기' : '펼치기'}</button>
        <button aria-pressed={fgId === 'vscode'} onClick={appSwitch}>앱 메모 ({fgId === 'vscode' ? 'VS Code' : '다른 앱'})</button>
        <button onClick={() => onPanel('calendar')}>월간 달력</button>
        <button onClick={() => setV3({ ocr: true })}>글자 복사 <kbd>Ctrl Alt T</kbd></button>
        <button onClick={snippets}>상용구 <kbd>;</kbd></button>
        <button onClick={() => onPanel('snippets')}>상용구 편집</button>
      </div>
    </>
  )
}
