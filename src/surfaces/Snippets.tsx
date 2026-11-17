import { useRef, useState } from 'react'
import { deleteWithUndo } from './Undo'
import { isTauri, ocrStart, snippetPaste, useItems } from '../data/api'
import { expand, seedSnippets, type Snippet } from '../data/snippets'
import { setV3 } from './Notes'

/* v3 상용구: 팔레트 항목(';' 로 시작하면 상용구만) + 패널 '상용구' 탭 편집기. 화면 글자 복사 명령도 팔레트에 같이 넣는다. */
export const useSnippets = () => useItems<Snippet>('snippet', seedSnippets)

export type Extra = { kind: 'ocr' } | { kind: 'snip'; text: string }
type XItem = { key: string; title: string; sub: string; x: Extra }

const OCR_ITEM: XItem = { key: 'x:ocr', title: '화면 글자 복사', sub: '영역을 골라 글자를 인식 · Ctrl+Alt+T', x: { kind: 'ocr' } }

/** 팔레트 추가 항목: ';…' = 상용구만, 검색어 = 이름·본문 일치 + 명령, 빈 검색어 = 없음 */
export function useExtras(q: string): XItem[] {
  const [snips] = useSnippets()
  const semi = q.startsWith(';')
  const s = (semi ? q.slice(1) : q).trim().toLowerCase()
  if (!semi && !s) return []
  const hits: XItem[] = snips
    .filter((n) => `${n.title} ${n.body} 상용구`.toLowerCase().includes(s))
    .map((n) => ({ key: 'x:' + n.id, title: n.title, sub: `상용구 · ${n.body.replace(/\s+/g, ' ')}`, x: { kind: 'snip', text: expand(n.body) } }))
  return semi ? hits : [...(`${OCR_ITEM.title} ocr 글자 복사 캡처`.includes(s) ? [OCR_ITEM] : []), ...hits]
}

/** 실행: 명령 = 팔레트 닫고 실행, 상용구 = 1번째 선택은 미리보기, 2번째(붙여넣기)는 복사 표시 후 닫기 */
export function runExtra(key: string, x: Extra, pv: string | null, setPv: (k: string) => void, setCopied: (k: string) => void, close: (restore: boolean) => void) {
  // 실제 앱: OCR 은 Rust 가 화면을 먼저 캡처한 뒤 선택 창을 연다
  if (x.kind === 'ocr') return close(false), isTauri ? void ocrStart().catch(() => {}) : setV3({ ocr: true })
  if (pv !== key) return setPv(key)
  // 실제 앱: Rust 가 클립보드를 잠깐 빌려 이전 앱에 Ctrl+V (그 뒤 원래 클립보드로). 시안: 복사만
  if (isTauri) return setCopied(key), void snippetPaste(x.text).catch(() => {})
  void navigator.clipboard?.writeText(x.text).catch(() => {})
  setCopied(key)
  setTimeout(() => close(false), 620)
}

export const extraLabel = (x: Extra, previewing: boolean) => (x.kind === 'ocr' ? '실행' : previewing ? '붙여넣기 ↵' : '미리보기')

export function ExtraIcon({ x }: { x: Extra }) {
  return (
    <span className={`x-ico x-${x.kind}`} aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {x.kind === 'ocr' ? <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M8 9.5h8M12 9.5V15" /> : <path d="M7 6h10M7 10h10M7 14h6M15 14l2 2 3-4" />}
      </svg>
    </span>
  )
}

/* ── 패널 탭: 상용구 편집기 ── */
const VARS = ['{오늘}', '{시간}', '{이름}']

export function SnippetTab() {
  const [snips, setSnips] = useSnippets()
  const [ed, setEd] = useState<Snippet | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)

  const save = () => {
    if (!ed || !ed.title.trim()) return
    setSnips((all) => (all.some((x) => x.id === ed.id) ? all.map((x) => (x.id === ed.id ? ed : x)) : [...all, ed]))
    setEd(null)
  }
  // 변수 칩: 커서 위치에 넣기
  const insert = (v: string) => {
    const el = area.current!, a = el.selectionStart, b = el.selectionEnd
    setEd((e) => e && { ...e, body: e.body.slice(0, a) + v + e.body.slice(b) })
    requestAnimationFrame(() => (el.focus(), el.setSelectionRange(a + v.length, a + v.length)))
  }

  if (ed)
    return (
      <form className="snip-ed" onSubmit={(e) => (e.preventDefault(), save())}>
        <input autoFocus value={ed.title} onChange={(e) => setEd({ ...ed, title: e.target.value })} placeholder="이름 (팔레트에서 ; 뒤에 검색)" aria-label="상용구 이름" />
        <textarea ref={area} value={ed.body} onChange={(e) => setEd({ ...ed, body: e.target.value })} placeholder="본문" aria-label="상용구 본문" />
        <div className="snip-vars">
          {VARS.map((v) => <button key={v} type="button" onClick={() => insert(v)}>{v}</button>)}
          <small>변수는 붙여넣을 때 채워져요</small>
        </div>
        <div className="snip-preview">
          <small>미리보기</small>
          <p>{expand(ed.body) || '—'}</p>
        </div>
        <div className="snip-btns">
          <button type="button" className="picker-open" onClick={() => setEd(null)}>취소</button>
          <button className="primary" disabled={!ed.title.trim()}>저장</button>
        </div>
      </form>
    )
  return (
    <>
      <button className="picker-open" onClick={() => setEd({ id: crypto.randomUUID(), title: '', body: '' })}>＋ 새 상용구</button>
      <ul className="list snip-list">
        {snips.map((n) => (
          <li key={n.id} onClick={() => setEd(n)}>
            <span className="x-ico x-snip" aria-hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M7 6h10M7 10h10M7 14h6" /></svg></span>
            <span className="grow">
              <b>{n.title}</b>
              <small>{n.body.replace(/\s+/g, ' ')}</small>
            </span>
            <button className="icon-btn del" onClick={(e) => (e.stopPropagation(), deleteWithUndo('상용구를 지웠어요', setSnips, n))} aria-label={`${n.title} 삭제`}>×</button>
          </li>
        ))}
      </ul>
      <p className="snip-tip">검색(Ctrl+Alt+K)에서 <kbd>;</kbd> 를 치면 상용구만 보여요</p>
    </>
  )
}
