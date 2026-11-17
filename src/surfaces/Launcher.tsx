import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react'
import type { AppGroup, LpRecord } from '../data/types'
import { asciiStop, fxStop, isTauri, onEvent, openAscii, openFx, startApps, useValue } from '../data/api'
import { Ico, type IcoKey } from './Icons'
import { ASCII_RECORDS } from './Lp'
import { Tile } from './Tile'

/* (a6) LP 런처 (승인 시안 lp-settings.html): 아일랜드 안 화면 452×612 · 떼어내면 떠 있는 LP.
   상자가 둘 — 앱 LP(앱 · URL · 세트 · 묶음) 와 효과·아스키 LP(화면 효과 5 + 아스키 5). 섞이지 않고, 고정(★)·순서도 따로.
   덱 = 판 하나: 마지막에 올린 판이 앞 판을 바꾼다. 앱 판을 꺼내도 앱은 닫히지 않는다. 효과·아스키는 화면 하나를 같이 쓰니 새 판이 앞 판을 멈춘다.
   ★ = 그 상자 맨 앞 + Ctrl+Alt+K 검색 맨 위 (store lp.star = { app: [], fx: [] }). 판은 쉬는 동안 돌지 않는다. */

export type FxRec = { id: string; title: string; cover: string; glyph: string; kind: 'fx' | 'ascii'; arg: string }
export const FX_RECORDS: FxRec[] = [
  ...([['snow', '눈', '#7dd3fc', '❅'], ['rain', '비', '#3b82f6', '☂'], ['leaves', '단풍', '#ea580c', '❦'], ['sunset', '노을', '#f97316', '☀'], ['moon', '달·별', '#4338ca', '☾']] as const).map(
    ([arg, title, cover, glyph]) => ({ id: 'fx:' + arg, title, cover, glyph, kind: 'fx' as const, arg }),
  ),
  ...ASCII_RECORDS.map((r) => ({ id: r.id, title: r.title.replace('아스키 · ', ''), cover: r.cover, glyph: { auto: '✦', xmas: '❄', city: '☾', autumn: '❦', calm: '☘' }[r.scene ?? 'auto'], kind: 'ascii' as const, arg: r.scene ?? 'auto' })),
]
export type Star = { app: string[]; fx: string[] }
export const useStar = () => useValue<Star>('lp.star', { app: [], fx: [] })

type Crate = 'app' | 'fx'
type Deck = { kind: 'app'; rec: LpRecord } | { kind: 'fx'; rec: FxRec }
const KIND: Record<string, string> = { single: '앱', set: '세트', fx: '화면 효과', ascii: '아스키 장면', group: '앱 묶음' }

/** 라벨 잉크: 커버 휘도로 (Lp.labelVars 와 같은 규칙) */
function ink(c: string): CSSProperties {
  const n = parseInt(c.slice(1), 16), lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  return (L < 0.08 ? { '--c': `color-mix(in oklab, ${c} 26%, white)`, '--ink': c } : L > 0.3 ? { '--c': c, '--ink': `color-mix(in oklab, ${c} 28%, black)` } : { '--c': c, '--ink': '#fff' }) as CSSProperties
}
function Disc({ d, cover, kind, glyph, rec, extra = '', set }: { d: number; cover: string; kind: string; glyph?: string; rec?: LpRecord; extra?: string; set?: [string, string] }) {
  const st = { '--d': `${d}px`, ...ink(cover), ...(set && { '--c2': set[0], '--c3': set[1] }) } as CSSProperties
  return (
    <span className={`disc ${set ? 'set' : ''} ${extra}`} data-kind={kind} style={st}>
      <span className="spin">{glyph ? <span className="gl">{glyph}</span> : kind === 'set' ? <Ico k="play" /> : rec ? <Tile rec={rec} size={Math.round(d * 0.3)} /> : null}</span>
    </span>
  )
}

type Props = {
  records: LpRecord[]
  groups: AppGroup[]
  onRun: (r: LpRecord) => Promise<void> | void // 앱 · 세트 실행 (세트는 차례로)
  onAddRecord: (target: string, title?: string) => void
  onRemoveRecord: (id: string) => void
  onAddSet: (title: string, ids: string[]) => void
  onSaveGroup: (g: AppGroup) => void
  onRemoveGroup: (id: string) => void
  // 시안: 실제 창 대신 부모가 재생
  onPlayFx?: (r: FxRec) => void
  onStopFx?: (r: FxRec) => void
}

/* 덱은 화면을 닫아도 남는다 (허브를 접었다 다시 열어도 같은 판) — 효과가 끝났다는 소식은 화면이 없을 때도 받는다 */
const mem: { deck: Deck | null; play: boolean; wait: { kind: FxRec['kind']; next: FxRec } | null; kick: null | (() => void) } = { deck: null, play: false, wait: null, kick: null }
let hooked = false
const fxStart = (r: FxRec) => (r.kind === 'fx' ? void openFx(r.arg) : void openAscii(null, r.arg === 'auto' ? undefined : r.arg))
function hookEnds() {
  if (hooked || !isTauri) return
  hooked = true
  const end = (k: FxRec['kind']) => () => {
    // 판을 바꾸며 멈춘 앞 효과가 다 닫혔다 → 새 효과 (효과 창은 하나라 앞 창이 닫힌 뒤에만 열린다)
    if (mem.wait?.kind === k) {
      const next = mem.wait.next
      mem.wait = null
      if (mem.deck?.rec.id === next.id) ((mem.play = true), fxStart(next), mem.kick?.())
      return
    }
    if (mem.deck?.kind !== 'fx' || mem.deck.rec.kind !== k) return
    mem.play = false
    mem.deck = null
    mem.kick?.()
  }
  onEvent('fx-closed', end('fx'))
  onEvent('ascii-closed', end('ascii'))
}

export function Launcher(p: Props) {
  const [crate, setCrate] = useValue<Crate>('lp.crate', 'app')
  const [star, setStar] = useStar()
  const [deck, setDeckS] = useState<Deck | null>(mem.deck)
  const [play, setPlayS] = useState(mem.play)
  const setDeck = (d: Deck | null) => ((mem.deck = d), setDeckS(d))
  const setPlay = (v: boolean) => ((mem.play = v), setPlayS(v))
  useEffect(() => {
    hookEnds()
    mem.kick = () => (setPlayS(mem.play), mem.deck ? setDeckS(mem.deck) : setTimeout(() => setDeckS(mem.deck), 360))
    return () => void (mem.kick = null)
  }, [])
  const [step, setStep] = useState(0)
  const [over, setOver] = useState(false)
  const [group, setGroup] = useState<string | null>(null)
  const [sheet, setSheet] = useState<null | 'add' | 'set' | 'group'>(null)
  const [editG, setEditG] = useState<AppGroup | null>(null) // 편집 중인 묶음
  const [toast, setToast] = useState<{ t: string; n: number } | null>(null)
  const say = (t: string) => setToast((x) => ({ t, n: (x?.n ?? 0) + 1 }))
  useEffect(() => {
    if (!toast) return
    const h = setTimeout(() => setToast(null), 1800)
    return () => clearTimeout(h)
  }, [toast?.n])
  const platter = useRef<HTMLDivElement>(null)
  const cur = useRef(deck)
  cur.current = deck
  const byId = (id: string) => p.records.find((r) => r.id === id)

  /* 재생 · 정지 */
  const stopFx = (r: FxRec) => (p.onStopFx ? p.onStopFx(r) : r.kind === 'fx' ? void fxStop() : void asciiStop())
  const start = (d: Deck) => {
    setPlay(true)
    if (d.kind === 'fx') {
      const r = d.rec
      return p.onPlayFx ? p.onPlayFx(r) : fxStart(r)
    }
    const r = d.rec
    setStep(0)
    // 세트 = 차례로 (단계 막대) · 단일 = 바로. 앱은 Hera 가 닫지 않는다
    const members = r.kind === 'set' ? (r.targets ?? []).map(byId).filter((x): x is LpRecord => !!x) : [r]
    void (async () => {
      for (let i = 0; i < members.length; i++) {
        await p.onRun(members[i])
        setStep(i + 1)
      }
    })()
  }
  const put = (d: Deck) => {
    const prev = cur.current
    const replacing = prev?.kind === 'fx' && play // 판 하나: 새 판이 앞 효과를 멈춘다
    setDeck(d)
    setPlay(false)
    if (replacing && isTauri && !p.onStopFx && d.kind === 'fx') {
      // 앞 효과 창이 닫힌 뒤 새 효과 (Rust 는 효과 창이 열려 있으면 새로 열지 않는다) · 3.5초 안에 소식이 없으면 그냥 연다
      mem.wait = { kind: prev.rec.kind, next: d.rec }
      stopFx(prev.rec)
      setTimeout(() => mem.wait?.next.id === d.rec.id && ((mem.wait = null), cur.current?.rec.id === d.rec.id && start(d)), 3500)
      return
    }
    if (replacing) stopFx(prev.rec)
    // 판이 내려앉는 동안 잠깐 뒤 재생
    setTimeout(() => cur.current?.rec.id === d.rec.id && start(d), 380)
  }
  const stop = () => {
    const d = cur.current
    if (!d) return
    setPlay(false)
    if (d.kind === 'fx') stopFx(d.rec)
  }
  const eject = () => {
    stop()
    setDeck(null)
    if (cur.current?.kind === 'app') say('판을 꺼냈어요 · 앱은 그대로 열려 있어요')
  }

  /* 상자 목록: ★ 먼저, 그다음 넣은 순서 */
  const starOf = (k: Crate) => star[k] ?? []
  const toggleStar = (k: Crate, id: string) => setStar({ ...star, [k]: starOf(k).includes(id) ? starOf(k).filter((x) => x !== id) : [...starOf(k), id] })
  const order = <T extends { id: string }>(k: Crate, xs: T[]) => [...starOf(k).map((id) => xs.find((x) => x.id === id)).filter((x): x is T => !!x), ...xs.filter((x) => !starOf(k).includes(x.id))]
  const apps = p.records.filter((r) => r.kind === 'single' || r.kind === 'set')
  const appItems = order('app', [...apps, ...p.groups.map((g) => ({ ...g, kind: 'group' as const }))])
  const g = group ? p.groups.find((x) => x.id === group) : null
  const onDeck = deck?.rec.id

  /* 끌어서 플래터에 (6px 미만 = 누르기 → 바로) */
  const drag = (d: Deck, e: RPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('.acts')) return
    const el = e.currentTarget
    const [x0, y0] = [e.clientX, e.clientY]
    let ghost: HTMLElement | null = null
    let hit = false
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return
      if (!ghost) {
        ghost = el.querySelector('.disc')!.cloneNode(true) as HTMLElement
        ghost.classList.add('dragghost')
        ghost.style.position = 'fixed'
        el.closest('.lpv')!.append(ghost)
        el.classList.add('lifted')
      }
      ghost.style.transform = `translate(${ev.clientX - 28}px, ${ev.clientY - 28}px)`
      const r = platter.current!.getBoundingClientRect()
      hit = Math.hypot(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2)) < r.width / 2 + 16
      setOver(hit)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.classList.remove('lifted')
      setOver(false)
      ghost?.remove()
      if (!ghost || hit) put(d)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  // URL 을 끌어 놓으면 앱 상자에 추가
  const drop = (e: DragEvent) => {
    const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).split(/\r?\n/).find((l) => /^https?:\/\//i.test(l))
    if (!url) return
    e.preventDefault()
    p.onAddRecord(url.trim())
    setCrate('app')
    say('앱 상자에 넣었어요')
  }
  const keys = (e: KeyboardEvent) => {
    if (e.key !== ' ' || (e.target as Element).closest('input, button')) return
    e.preventDefault()
    if (deck) play ? stop() : start(deck)
  }

  const r = deck?.rec
  const cover = r?.cover ?? '#3a3a42'
  const info = !deck ? { kind: '플래터', t: '레코드를 올려 주세요', s: '끌어다 놓거나 누르면 재생 · 앱은 실행, 효과는 화면에' }
    : deck.kind === 'app'
      ? { kind: KIND[deck.rec.kind] + (play ? ' · 재생 중' : ''), t: deck.rec.title, s: deck.rec.kind === 'set' ? (play ? `차례로 여는 중 · ${(deck.rec.targets ?? []).map((x) => byId(x)?.title).filter(Boolean).join(' → ')}` : `${deck.rec.targets?.length ?? 0}개를 차례로 실행`) : play ? '실행했어요 · 판을 꺼내도 앱은 닫히지 않아요' : '암을 내리면 실행' }
      : { kind: KIND[deck.rec.kind] + (play ? ' · 재생 중' : ''), t: deck.rec.title, s: deck.rec.kind === 'fx' ? (play ? '바탕화면에 25초 · 끝나면 상자로 돌아가요' : '화면 효과 25초') : play ? '전체화면 · Esc로 닫기' : '전체화면 아스키 장면' }
  const deckDisc = (d: number, extra: string) => deck?.kind === 'fx'
    ? <Disc d={d} cover={deck.rec.cover} kind={deck.rec.kind} glyph={deck.rec.glyph} extra={extra} />
    : deck ? <Disc d={d} cover={deck.rec.cover} kind={deck.rec.kind} rec={deck.rec} extra={extra} set={setCovers(deck.rec)} /> : null
  const setCovers = (x: LpRecord): [string, string] | undefined => (x.kind === 'set' ? [byId(x.targets?.[1] ?? '')?.cover ?? x.cover, byId(x.targets?.[2] ?? x.targets?.[0] ?? '')?.cover ?? x.cover] : undefined)

  return (
    <div className="hx a6 lpv" tabIndex={-1} onKeyDown={keys} onDragOver={(e) => e.preventDefault()} onDrop={drop}>
      <div className={`deck ${over ? 'over' : ''}`} data-play={play} style={{ '--dc': cover } as CSSProperties}>
        <div className="platter" ref={platter} aria-label={r ? `${r.title}${play ? ' 재생 중' : ''}` : '빈 플래터 — 레코드를 끌어 놓으세요'}>
          {deck ? <button className="ondisc" data-eject onClick={eject} title="판 꺼내기" aria-label={`${r!.title} 꺼내기`} key={r!.id}>{deckDisc(112, `drop ${play ? (deck.kind === 'fx' ? 'turn' : 'turn1') : ''}`)}</button> : <span className="mat">레코드를<br />여기로</span>}
          {deck && <i className="spindle" />}
        </div>
        <span className="arm"><svg viewBox="0 0 22 104"><circle cx="11" cy="11" r="9" fill="#2a2a30" stroke="rgba(255,255,255,.25)" strokeWidth=".8" /><circle cx="11" cy="11" r="3.4" fill="#9a9aa2" /><path d="M11 11 L11 78 Q11 86 6 92" fill="none" stroke="#c8c8d0" strokeWidth="2.6" strokeLinecap="round" /><rect x="1" y="88" width="9" height="13" rx="2" transform="rotate(28 5.5 94.5)" fill="#d6d6dc" /></svg></span>
        <div className="info">
          <span className="kind">{info.kind}</span><b>{info.t}</b><small>{info.s}</small>
          {deck?.kind === 'app' && deck.rec.kind === 'set'
            ? <div className="steps">{(deck.rec.targets ?? []).map((_, i) => <i key={i} className={play && i < step ? 'on' : ''} />)}</div>
            : <div className={`prog ${deck?.kind === 'fx' && deck.rec.kind === 'fx' && play ? 'on' : ''}`} style={{ '--dcl': cover } as CSSProperties}><i /></div>}
          <div className="ctl">
            <button className="round main" data-arm disabled={!deck} onClick={() => (play ? stop() : deck && start(deck))} aria-label={play ? '정지 (암 들기)' : '재생 (암 내리기)'} title={play ? '정지' : '재생'}><Ico k={play ? 'stop' : 'play'} /></button>
            <button className="round" data-eject disabled={!deck} onClick={eject} aria-label="판 꺼내기" title="판 꺼내기"><Ico k="eject" /></button>
          </div>
        </div>
      </div>

      {g ? (
        <div className="crumb"><button onClick={() => setGroup(null)}><Ico k="back" />앱 상자</button><span>{g.title} 묶음 · {g.recordIds.length}개</span></div>
      ) : (
        <div className="filters">
          <div className="seg" role="tablist" aria-label="LP 상자">
            <button role="tab" aria-selected={crate === 'app'} className={crate === 'app' ? 'on' : ''} data-crate="app" onClick={() => setCrate('app')}>앱 LP<small>{appItems.length}</small></button>
            <button role="tab" aria-selected={crate === 'fx'} className={crate === 'fx' ? 'on' : ''} data-crate="fx" onClick={() => setCrate('fx')}>효과 · 아스키 LP<small>{FX_RECORDS.length}</small></button>
          </div>
          {crate === 'app' && <button className="ib" data-sheet="add" onClick={() => setSheet('add')} aria-label="레코드 추가" title="앱·URL 추가, 세트·묶음 만들기"><Ico k="plus" /></button>}
        </div>
      )}

      <div className="crate crate-in" role="list" data-crate={g ? 'group' : crate} key={g ? 'g' + g.id : crate}>
        {g ? g.recordIds.map(byId).filter((x): x is LpRecord => !!x).map((x) => (
          <div key={x.id} className={`rec ${onDeck === x.id ? 'ondeck' : ''}`} data-rec={x.id} role="listitem" onPointerDown={(e) => drag({ kind: 'app', rec: x }, e)} title={`${x.title} — 끌어서 플래터에, 누르면 실행`}>
            <Disc d={56} cover={x.cover} kind={x.kind} rec={x} /><small>{x.title}</small>
          </div>
        ))
        : crate === 'app' ? appItems.map((x) => x.kind === 'group' ? (
          <div key={x.id} className="rec folder" data-grp={x.id} role="listitem" onClick={(e) => !(e.target as Element).closest('.acts') && setGroup(x.id)} title={`${x.title} 묶음 — 눌러서 열기`}>
            <span className="stack">{x.recordIds.slice(0, 4).map(byId).filter((y): y is LpRecord => !!y).map((y) => <Disc key={y.id} d={19} cover={y.cover} kind="single" />)}</span><small>{x.title}</small>
            {starOf('app').includes(x.id) && <span className="star"><Ico k="star" /></span>}
            <span className="acts">
              <button data-star={x.id} onClick={() => toggleStar('app', x.id)} aria-label={`${x.title} 고정`} title={starOf('app').includes(x.id) ? '고정 풀기' : '맨 앞에 고정 · 검색에서도 위로'}><Ico k="star" /></button>
              <button onClick={() => (setEditG({ id: x.id, title: x.title, recordIds: x.recordIds }), setSheet('group'))} aria-label={`${x.title} 묶음 편집`}><Ico k="edit" /></button>
              <button className="del" onClick={() => p.onRemoveGroup(x.id)} aria-label={`${x.title} 묶음 삭제`}><Ico k="close" /></button>
            </span>
          </div>
        ) : (
          <div key={x.id} className={`rec ${onDeck === x.id ? 'ondeck' : ''}`} data-rec={x.id} role="listitem" onPointerDown={(e) => drag({ kind: 'app', rec: x }, e)} aria-label={`${x.title} ${KIND[x.kind]} — 끌어서 플래터에, 누르면 재생`}>
            <Disc d={56} cover={x.cover} kind={x.kind} rec={x} set={setCovers(x)} /><small>{x.title}</small>
            {starOf('app').includes(x.id) && <span className="star"><Ico k="star" /></span>}
            <span className="acts">
              <button data-star={x.id} onClick={() => toggleStar('app', x.id)} aria-label={`${x.title} 고정`} title={starOf('app').includes(x.id) ? '고정 풀기' : '맨 앞에 고정 · 검색에서도 위로'}><Ico k="star" /></button>
              <button className="del" data-del={x.id} onClick={() => (onDeck === x.id && setDeck(null), p.onRemoveRecord(x.id))} aria-label={`${x.title} 삭제`} title="삭제"><Ico k="close" /></button>
            </span>
          </div>
        ))
        : order('fx', FX_RECORDS).map((x) => (
          <div key={x.id} className={`rec ${onDeck === x.id ? 'ondeck' : ''}`} data-rec={x.id} role="listitem" onPointerDown={(e) => drag({ kind: 'fx', rec: x }, e)} aria-label={`${x.title} ${KIND[x.kind]} — 끌어서 플래터에, 누르면 재생`}>
            <Disc d={56} cover={x.cover} kind={x.kind} glyph={x.glyph} /><small>{x.title}</small>
            {starOf('fx').includes(x.id) && <span className="star"><Ico k="star" /></span>}
            <span className="acts"><button data-star={x.id} onClick={() => toggleStar('fx', x.id)} aria-label={`${x.title} 고정`} title={starOf('fx').includes(x.id) ? '고정 풀기' : '맨 앞에 고정 · 검색에서도 위로'}><Ico k="star" /></button></span>
          </div>
        ))}
      </div>
      <div className="lpfoot"><Ico k="search" /><span>Ctrl+Alt+K 검색에서도 이름으로 재생</span><span className="spacer" /><span>{crate === 'app' ? 'URL을 여기로 끌어 놓으면 추가' : '★ = 맨 앞 · 검색 맨 위'}</span></div>
      <Sheet mode={sheet} setMode={setSheet} {...p} apps={p.records.filter((x) => x.kind === 'single')} edit={editG} clearEdit={() => setEditG(null)} say={say} />
      {toast && <div key={toast.n} className="toast on" role="status">{toast.t}</div>}
    </div>
  )
}

/* 추가 · 세트 · 묶음 (LP 화면 안에서 올라오는 시트) */
function Sheet({ mode, setMode, apps, onAddRecord, onAddSet, onSaveGroup, edit, clearEdit, say }: Props & { mode: null | 'add' | 'set' | 'group'; setMode: (m: null | 'add' | 'set' | 'group') => void; apps: LpRecord[]; edit: AppGroup | null; clearEdit: () => void; say: (t: string) => void }) {
  const [url, setUrl] = useState('')
  const [q, setQ] = useState('')
  const [start, setStart] = useState<[string, string][] | null>(null)
  const [failed, setFailed] = useState(false)
  const [pick, setPick] = useState<string[]>([])
  const [name, setName] = useState('')
  useEffect(() => {
    if (mode === 'group' && edit) (setPick([...edit.recordIds]), setName(edit.title))
    else if (mode === 'set' || mode === 'group') (setPick([]), setName(''))
    if (mode === 'add' && !start && isTauri) void startApps().then(setStart, () => setFailed(true))
  }, [mode])
  const close = () => (setMode(null), clearEdit())
  const first = useRef<HTMLInputElement>(null)
  // (a8) 시트를 열면 첫 칸에 커서 (시트는 늘 그려져 있어 autoFocus 가 안 먹는다)
  useEffect(() => void (mode && requestAnimationFrame(() => first.current?.focus())), [mode])
  const add = () => url.trim() && (onAddRecord(url.trim()), setUrl(''), say('앱 상자에 넣었어요'))
  const make = () => {
    if (pick.length < 2) return
    if (mode === 'set') onAddSet(name.trim() || 'LP 세트', pick)
    else onSaveGroup({ id: edit?.id ?? crypto.randomUUID(), title: name.trim() || '묶음', recordIds: pick })
    say(mode === 'set' ? '세트를 만들었어요' : '묶음을 저장했어요')
    close()
  }
  const hits = (start ?? []).filter(([n]) => n.toLowerCase().includes(q.toLowerCase())).slice(0, 40)
  return (
    <div className={`sheet ${mode ? 'on' : ''}`} aria-hidden={!mode} onKeyDown={(e) => mode && e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), close())}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div className="seg">{([['add', '앱 · URL'], ['set', '세트 만들기'], ['group', '앱 묶음']] as const).map(([k, l]) => <button key={k} className={mode === k ? 'on' : ''} data-sheet={k} onClick={() => (clearEdit(), setMode(k))}>{l}</button>)}</div>
        <span className="spacer" />
        <button className="ib" data-sheet="" onClick={close} aria-label="닫기"><Ico k="close" /></button>
      </div>
      {mode === 'add' || !mode ? (
        <>
          <div className="addrow"><input ref={mode === 'add' || !mode ? first : undefined} className="inp" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="URL 또는 .exe 경로" aria-label="URL 또는 경로" /><button className="btn sm" data-lpadd onClick={add}>추가</button></div>
          <div className="dropz"><Ico k="upload" />브라우저 주소를 LP 화면으로 끌어 놓아도 돼요 · exe·바로가기는 캡슐로</div>
          <div className="sect">시작 메뉴에서</div>
          <label className="inp" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}><Ico k="search" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={start ? `앱 검색 (${start.length}개)` : failed ? '불러오지 못했어요' : isTauri ? '불러오는 중…' : '시안: 실제 앱에서만'} aria-label="시작 메뉴 앱 검색" style={{ flex: 1 }} /></label>
          <div className="list">
            {hits.map(([n, t]) => (
              <div key={t} className="lrow"><span className="well md" style={{ '--c': 'var(--gray)' } as CSSProperties}><Ico k={'doc' as IcoKey} /></span><span className="tt"><b>{n}</b><small>시작 메뉴 바로가기</small></span>
                <button className="ib" onClick={() => (onAddRecord(t, n), say(`앱 상자에 넣었어요 · ${n}`))} aria-label={`${n} 추가`}><Ico k="plus" /></button></div>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="snote" style={{ padding: 0 }}>{mode === 'set' ? <>고른 <b>순서대로</b> 하나씩 실행돼요 · 2개 이상 골라 주세요</> : '여러 앱을 한 칸에 모아 둬요 · 열어서 골라 실행해요'}</p>
          <div className="addrow"><input ref={mode === 'set' || mode === 'group' ? first : undefined} className="inp" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && make()} placeholder={`${mode === 'set' ? '세트' : '묶음'} 이름`} aria-label="이름" /><button className="btn sm" data-lpmake disabled={pick.length < 2} onClick={make}>{pick.length}개로 {edit ? '저장' : '만들기'}</button></div>
          <div className="list">
            {apps.map((a) => {
              const k = pick.indexOf(a.id)
              return (
                <button key={a.id} className="lrow" data-pick={a.id} onClick={() => setPick((x) => (x.includes(a.id) ? x.filter((y) => y !== a.id) : [...x, a.id]))}>
                  <Disc d={32} cover={a.cover} kind="single" rec={a} /><span className="tt"><b>{a.title}</b><small>{a.target}</small></span><span className={`ord ${k >= 0 ? 'on' : ''}`}>{k >= 0 ? (mode === 'set' ? k + 1 : '✓') : ''}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
