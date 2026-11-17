import { useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'

/* (a9) 지우기 = 바로 사라지고 5초 동안 '되돌리기' (확인 창 대신). 할 일 · 일정 · 메모 · 상용구 · 팀 그룹이 같이 쓴다.
   되돌리면 같은 id·내용·자리 그대로 다시 넣는다 (store 키도 그대로 다시 쓰인다). 창마다 하나 (<UndoToast/>).
   (a10) onCommit = 5초가 지나야(또는 다음 지우기·창 닫힘) 하는 진짜 일 — 남에게 보이는 일(팀 그룹 나가기)은 기다렸다가 한다. */
type Undo = { text: string; undo: () => void; n: number }
type Opts = { onCommit?: () => void; onUndo?: () => void }
let cur: Undo | null = null
let pending: { n: number; commit: () => void } | null = null
let seq = 0
let timer = 0
const subs = new Set<() => void>()
const set = (u: Undo | null) => ((cur = u), subs.forEach((f) => f()))
/** 기다리던 진짜 일을 지금 한다 (한 번만) */
const flush = () => {
  const p = pending
  pending = null
  p?.commit()
}
addEventListener('pagehide', flush)

export function deleteWithUndo<T extends { id: string }>(text: string, update: Dispatch<SetStateAction<T[]>>, item: T, opts: Opts = {}) {
  flush() // 앞의 것은 되돌릴 기회가 끝났다
  clearTimeout(timer)
  let at = -1
  update((all) => ((at = all.findIndex((x) => x.id === item.id)), all.filter((x) => x.id !== item.id)))
  const n = ++seq
  if (opts.onCommit) pending = { n, commit: opts.onCommit }
  set({
    text,
    n,
    undo: () => {
      if (pending?.n === n) pending = null
      opts.onUndo?.()
      update((all) => (all.some((x) => x.id === item.id) ? all : [...all.slice(0, Math.max(0, at)), item, ...all.slice(Math.max(0, at))]))
    },
  })
  timer = window.setTimeout(() => (pending?.n === n && flush(), cur?.n === n && set(null)), 5000)
}

export function UndoToast() {
  const u = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => cur)
  if (!u) return null
  return (
    <div key={u.n} className="undo-toast" role="status">
      <span>{u.text}</span>
      <button data-undo onClick={() => (clearTimeout(timer), u.undo(), set(null))}>되돌리기</button>
    </div>
  )
}
