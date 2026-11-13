import { useState, type KeyboardEvent } from 'react'
import type { LpRecord, Todo } from '../data/types'
import { Tile } from './Dock'

type Item = { key: string; title: string; sub: string; rec?: LpRecord }

type Props = {
  records: LpRecord[]
  todos: Todo[]
  onRun: (r: LpRecord) => void
  onOpenTodo: () => void
  onClose: () => void
}

// 시안: Ctrl+K (실제 단축키는 C3 / Open Question 2). 검색은 단순 부분 일치.
export function Palette({ records, todos, onRun, onOpenTodo, onClose }: Props) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)

  const all: Item[] = [
    ...records.map((r) => ({ key: r.id, title: r.title, sub: r.kind === 'set' ? 'LP 세트' : r.target, rec: r })),
    ...todos.filter((t) => !t.done).map((t) => ({ key: t.id, title: t.title, sub: '할 일' })),
  ]
  const s = q.trim().toLowerCase()
  const items = s ? all.filter((x) => `${x.title} ${x.sub}`.toLowerCase().includes(s)) : all
  const cur = Math.min(sel, items.length - 1)

  const run = (it?: Item) => {
    if (!it) return
    if (it.rec) onRun(it.rec)
    else onOpenTodo()
    onClose()
  }

  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'Enter') run(items[cur])
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((cur + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length))
    }
  }

  return (
    <div className="palette-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette glass-card" role="dialog" aria-label="검색">
        <div className="palette-input">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></svg>
          <input
            autoFocus
            value={q}
            onChange={(e) => (setQ(e.target.value), setSel(0))}
            onKeyDown={key}
            placeholder="앱, URL, 할 일 검색"
            aria-label="검색어"
            aria-activedescendant={items[cur] ? `pi-${items[cur].key}` : undefined}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-list" role="listbox">
          {items.length === 0 && <li className="empty">결과 없음</li>}
          {items.map((it, i) => (
            <li key={it.key} id={`pi-${it.key}`} role="option" aria-selected={i === cur} onPointerMove={() => i !== cur && setSel(i)} onClick={() => run(it)}>
              {it.rec ? <Tile rec={it.rec} size={28} /> : <span className="todo-ico" />}
              <span className="grow">
                <b>{it.title}</b>
                <small>{it.sub}</small>
              </span>
              <kbd>{it.rec ? '실행' : '열기'}</kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
