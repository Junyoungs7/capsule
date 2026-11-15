import { useEffect, useState, type ReactNode } from 'react'
import type { Clip, ShelfFile } from '../data/types'
import { dragOut, floatClose, floatPin, isTauri, storeGet, type FloatKind } from '../data/api'

/* 떠 있는 기능 창 (허브 아이콘 → 창 1개). 머리줄 = 끌기 영역 · 제목 · '항상 위' 핀 · 닫기(Esc 도).
   실제 앱: Tauri 창 `float-<f>` (닫으면 파괴). 시안: 같은 컴포넌트를 페이지 안에 띄운다. */

export const FLOAT_TITLE: Record<FloatKind, string> = { todo: '할 일', calendar: '달력', chat: '채팅', term: '터미널', clips: '최근 복사', shelf: '선반', lp: 'LP' }

export function FloatShell({ f, onClose, children, mock }: { f: FloatKind; onClose?: () => void; children: ReactNode; mock?: boolean }) {
  const [pin, setPin] = useState(false)
  useEffect(() => {
    if (isTauri) void storeGet<boolean>(`float.${f}.pin`).then((v) => setPin(v ?? f === 'lp'))
  }, [])
  const close = () => (onClose ? onClose() : void floatClose())
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && close()
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [onClose])
  return (
    <section className="float glass-card" data-f={f} data-mock={mock}>
      <header className="float-head" data-tauri-drag-region>
        <b data-tauri-drag-region>{FLOAT_TITLE[f]}</b>
        <button className="float-btn" aria-pressed={pin} title="항상 위" aria-label="항상 위" onClick={() => (setPin(!pin), isTauri && void floatPin(!pin))}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" /></svg>
        </button>
        <button className="float-btn" title="닫기 (Esc)" aria-label="닫기" onClick={close}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M7 7l10 10M17 7L7 17" /></svg>
        </button>
      </header>
      <div className="float-body">{children}</div>
    </section>
  )
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : `${Math.floor(m / 60)}시간 전`
}

/** 최근 복사: 누르면 다시 클립보드에 (메모리에만 — 재시작하면 사라짐) */
export function ClipsList({ clips, onCopy }: { clips: Clip[]; onCopy: (c: Clip) => void }) {
  const [done, setDone] = useState<string | null>(null)
  if (!clips.length) return <p className="float-empty">아직 복사한 글자가 없어요. 무엇이든 복사하면 여기 쌓여요 (최근 20개, 메모리에만).</p>
  return (
    <ul className="float-list">
      {clips.map((c) => (
        <li key={c.id}>
          <button onClick={() => (onCopy(c), setDone(c.id), setTimeout(() => setDone(null), 1200))}>
            <b>{c.text}</b>
            <small>{done === c.id ? '복사됨' : ago(c.at)}</small>
          </button>
        </li>
      ))}
    </ul>
  )
}

const fname = (p: string) => p.split(/[\\/]/).pop()!
/** 선반: 누르면 열기 · 끌면 밖으로 복사(OLE) · 우클릭/× = 빼기. 파일은 노치에 끌어 놓으면 들어온다. */
export function ShelfList({ files, onOpen, onRemove, onSend, peer }: { files: ShelfFile[]; onOpen: (f: ShelfFile) => void; onRemove: (f: ShelfFile) => void; onSend?: (f: ShelfFile) => void; peer?: string }) {
  const [down, setDown] = useState<{ x: number; y: number; id: string; dragged: boolean } | null>(null)
  if (!files.length) return <p className="float-empty">비어 있어요. 파일을 화면 위쪽 가운데 노치로 끌어 오면 담겨요 (최대 4개).</p>
  return (
    <ul className="float-list shelf-list">
      {[...files].sort((a, b) => b.at - a.at).map((f) => (
        <li key={f.id}>
          <button
            onPointerDown={(e) => setDown({ x: e.clientX, y: e.clientY, id: f.id, dragged: false })}
            onPointerMove={(e) => {
              if (!isTauri || !(e.buttons & 1) || !down || down.id !== f.id || down.dragged || Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) return
              setDown({ ...down, dragged: true })
              void dragOut(f.path)
            }}
            onClick={() => (down?.dragged ? setDown(null) : onOpen(f))}
            onContextMenu={(e) => (e.preventDefault(), onRemove(f))}
            title={`${f.path}\n클릭: 열기 · 끌기: 밖으로 복사 · 우클릭: 빼기`}
          >
            <i className="ext">{/\.([a-z0-9]{1,4})$/i.exec(f.path)?.[1] ?? '폴더'}</i>
            <span><b>{fname(f.path)}</b><small>{f.path}</small></span>
          </button>
          {onSend && <button className="mini" onClick={() => onSend(f)} title={`${peer ?? 'Mac'}으로 보내기`}>{peer ?? 'Mac'}</button>}
          <button className="mini" onClick={() => onRemove(f)} aria-label="선반에서 빼기">×</button>
        </li>
      ))}
    </ul>
  )
}
