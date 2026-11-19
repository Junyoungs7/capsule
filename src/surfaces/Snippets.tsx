import { useRef, useState } from 'react'
import { deleteWithUndo } from './Undo'
import { useItems } from '../data/api'
import { expand, seedSnippets, type Snippet } from '../data/snippets'
import { Ico } from './Icons'

/* 상용구 (아일랜드 '스니펫' 화면, 한 화면): 줄을 누르면 앞 앱에 붙여 넣기 · 연필 = 그 자리에서 고치기 · ＋ 새 상용구 */
export const useSnippets = () => useItems<Snippet>('snippet', seedSnippets)

const VARS = ['{오늘}', '{시간}', '{이름}']

export function SnippetsView({ onPaste }: { onPaste: (text: string) => void }) {
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

  if (ed) {
    const old = snips.find((x) => x.id === ed.id)
    return (
      <form className="snip-ed" onSubmit={(e) => (e.preventDefault(), save())}>
        <input autoFocus value={ed.title} onChange={(e) => setEd({ ...ed, title: e.target.value })} placeholder="이름" aria-label="상용구 이름" />
        <textarea ref={area} value={ed.body} onChange={(e) => setEd({ ...ed, body: e.target.value })} placeholder="본문" aria-label="상용구 본문" />
        <div className="snip-vars">
          {VARS.map((v) => <button key={v} type="button" onClick={() => insert(v)}>{v}</button>)}
          <small>변수는 붙여 넣을 때 채워져요</small>
        </div>
        <div className="snip-preview">
          <small>미리보기</small>
          <p>{expand(ed.body) || '—'}</p>
        </div>
        <div className="snip-btns">
          {old && <button type="button" className="btn ghost" data-snip-del onClick={() => (deleteWithUndo('상용구를 지웠어요', setSnips, old), setEd(null))}>삭제</button>}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={() => setEd(null)}>취소</button>
          <button className="btn" disabled={!ed.title.trim()}>저장</button>
        </div>
      </form>
    )
  }
  return (
    <>
      <div className="sect">누르면 앞 앱에 붙여 넣어요</div>
      {snips.map((n) => (
        <div key={n.id} className="row snip" data-snip={n.id}>
          <button className="tt" data-snip-paste={n.id} onClick={() => onPaste(expand(n.body))}><b>{n.title}</b><small>{n.body.replace(/\s+/g, ' ')}</small></button>
          <button className="ib" data-snip-edit={n.id} onClick={() => setEd(n)} aria-label={`${n.title} 고치기`} title="고치기"><Ico k="edit" /></button>
        </div>
      ))}
      {!snips.length && <div className="empty">아직 상용구가 없어요</div>}
      <div className="foot">
        <small>상용구 {snips.length}개</small>
        <button className="btn ghost" data-snip-new onClick={() => setEd({ id: crypto.randomUUID(), title: '', body: '' })}><Ico k="plus" />새 상용구</button>
      </div>
    </>
  )
}
