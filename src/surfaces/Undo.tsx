import { useEffect, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'

/* (a9) 지우기 = 바로 사라지고 5초 동안 '되돌리기' (확인 창 대신). 할 일 · 일정 · 메모가 같이 쓴다.
   되돌리면 같은 id·내용·자리 그대로 다시 넣는다 (store 키도 그대로 다시 쓰인다). 창마다 하나 (<UndoToast/>). */
type Undo = { text: string; undo: () => void; n: number }
let cur: Undo | null = null
let seq = 0
const subs = new Set<() => void>()
const set = (u: Undo | null) => ((cur = u), subs.forEach((f) => f()))

export function deleteWithUndo<T extends { id: string }>(text: string, update: Dispatch<SetStateAction<T[]>>, item: T) {
  let at = -1
  update((all) => ((at = all.findIndex((x) => x.id === item.id)), all.filter((x) => x.id !== item.id)))
  set({ text, n: ++seq, undo: () => update((all) => (all.some((x) => x.id === item.id) ? all : [...all.slice(0, Math.max(0, at)), item, ...all.slice(Math.max(0, at))])) })
}

export function UndoToast() {
  const u = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => cur)
  useEffect(() => {
    if (!u) return
    const t = setTimeout(() => cur?.n === u.n && set(null), 5000)
    return () => clearTimeout(t)
  }, [u?.n])
  if (!u) return null
  return (
    <div key={u.n} className="undo-toast" role="status">
      <span>{u.text}</span>
      <button data-undo onClick={() => (u.undo(), set(null))}>되돌리기</button>
    </div>
  )
}
