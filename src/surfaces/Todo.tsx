import { useState, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import type { Todo } from '../data/types'
import { fmtWhen } from './Island'
import { todoWhen, WhenFields } from './DateRange'
import { defaults, toTodo, type When } from '../data/when'

/* 할 일 (아일랜드 안 화면 · 떼어낸 창). (a6) 예전 패널 창에서 옮겨 왔다 — 패널 창은 지웠다. */
const id = () => crypto.randomUUID()

export function TodoTab({ todos, setTodos, onAdded }: { todos: Todo[]; setTodos: Dispatch<SetStateAction<Todo[]>>; onAdded: () => void }) {
  const [title, setTitle] = useState('')
  // (a4) 기본 = 지금(다음 5분) ~ +1시간. 손대지 않았으면 저장하는 순간의 '지금'으로 (오래 열어 둔 화면에서도)
  const [when, setWhen] = useState<When>(() => defaults())
  const [touched, setTouched] = useState(false)
  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setTodos((t) => [...t, { id: id(), title: title.trim(), ...toTodo(touched ? when : defaults()), done: false, source: 'local' }])
    setTitle('')
    setWhen(defaults())
    setTouched(false)
    onAdded()
  }
  const sorted = [...todos].sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? '9').localeCompare(b.due ?? '9'))
  return (
    <>
      <form className="add" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="할 일 추가 · Enter" aria-label="할 일 제목" onFocus={() => !touched && setWhen(defaults())} />
        <button className="primary" aria-label="추가">추가</button>
      </form>
      <WhenFields value={when} onChange={(w) => (setWhen(w), setTouched(true))} />
      <ul className="list">
        {sorted.map((t) => (
          <li key={t.id} data-done={t.done}>
            <label className="check">
              <input type="checkbox" checked={t.done} onChange={() => setTodos((all) => all.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))} />
              <span />
            </label>
            <span className="grow">
              <b>{t.title}</b>
              <small>{todoWhen(t, fmtWhen)}</small>
            </span>
            <button className="icon-btn del" onClick={() => setTodos((all) => all.filter((x) => x.id !== t.id))} aria-label={`${t.title} 삭제`}>×</button>
          </li>
        ))}
      </ul>
    </>
  )
}
