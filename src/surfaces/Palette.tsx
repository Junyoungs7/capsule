import { useEffect, useState, type KeyboardEvent } from 'react'
import type { LpRecord, Todo } from '../data/types'
import { isTauri } from '../data/api'
import { Tile } from './Dock'

type Item = { key: string; title: string; sub: string; rec?: LpRecord; target?: string }

type Props = {
  records: LpRecord[]
  todos: Todo[]
  apps: [string, string][] // 시작 메뉴 앱 (이름, 대상)
  onRun: (r: LpRecord) => void
  onLaunch: (target: string) => void
  onOpenTodo: () => void
  onClose: (restore: boolean) => void // restore = 이전 앱으로 포커스 반환 (Esc·바깥 클릭)
}

const LIMIT = 30 // 목록 DOM 상한 (시작 메뉴 앱 300여 개)

// 실제 앱: Ctrl+Alt+K 전역 단축키(C3) → 팔레트 창. 시안: Ctrl+K. 검색은 단순 부분 일치.
export function Palette({ records, todos, apps, onRun, onLaunch, onOpenTodo, onClose }: Props) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const close = onClose

  // 팔레트 창이 포커스를 잃으면(다른 앱 클릭) 숨긴다 — 포커스는 그 앱에 그대로 (이미 숨긴 뒤의 blur 는 무해)
  useEffect(() => {
    if (!isTauri) return
    const f = () => close(false)
    addEventListener('blur', f)
    return () => removeEventListener('blur', f)
  }, [])

  const known = new Set(records.map((r) => r.target.toLowerCase()))
  const all: Item[] = [
    ...records.map((r) => ({ key: r.id, title: r.title, sub: r.kind === 'set' ? 'LP 세트' : r.target, rec: r })),
    ...todos.filter((t) => !t.done).map((t) => ({ key: t.id, title: t.title, sub: '할 일' })),
    ...apps.filter(([, t]) => !known.has(t.toLowerCase())).map(([title, target]) => ({ key: target, title, sub: '시작 메뉴 앱', target })),
  ]
  const s = q.trim().toLowerCase()
  const items = (s ? all.filter((x) => `${x.title} ${x.sub}`.toLowerCase().includes(s)) : all).slice(0, LIMIT)
  const cur = Math.min(sel, items.length - 1)

  const run = (it?: Item) => {
    if (!it) return
    if (it.rec) onRun(it.rec)
    else if (it.target) onLaunch(it.target)
    else onOpenTodo()
    close(false)
  }

  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close(true)
    else if (e.key === 'Enter') run(items[cur])
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((cur + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length))
    }
  }

  return (
    <div className="palette-scrim" onPointerDown={(e) => e.target === e.currentTarget && close(true)}>
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
              {it.rec ? <Tile rec={it.rec} size={28} /> : <span className={it.target ? 'todo-ico app-ico' : 'todo-ico'} />}
              <span className="grow">
                <b>{it.title}</b>
                <small>{it.sub}</small>
              </span>
              <kbd>{it.target || it.rec ? '실행' : '열기'}</kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
