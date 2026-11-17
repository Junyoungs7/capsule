import { useState, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import { deleteWithUndo } from './Undo'
import type { Todo } from '../data/types'
import { fmtWhen } from './Island'
import { todoWhen, WhenFields } from './DateRange'
import { defaults, toTodo, type When } from '../data/when'
import { useValue } from '../data/api'

/* 할 일 (아일랜드 안 화면 · 떼어낸 창). (a6) 예전 패널 창에서 옮겨 왔다 — 패널 창은 지웠다. */
const id = () => crypto.randomUUID()

export function TodoTab({ todos, setTodos, onAdded }: { todos: Todo[]; setTodos: Dispatch<SetStateAction<Todo[]>>; onAdded: () => void }) {
  const [title, setTitle] = useState('')
  // (a4) 기본 = 지금(다음 5분) ~ +1시간. 손대지 않았으면 저장하는 순간의 '지금'으로 (오래 열어 둔 화면에서도)
  const [when, setWhen] = useState<When>(() => defaults())
  const [touched, setTouched] = useState(false)
  const [quickAlarm] = useValue('todo.quickAlarm', true)
  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    // (a5) 날짜를 손대지 않고 저장 = 지금 ~ +1시간 (그 끝에 알림). 설정 '날짜 없이 저장한 할 일 알림' 을 끄면 날짜 없이 (알림 없음) — 이 한 곳
    setTodos((t) => [...t, { id: id(), title: title.trim(), ...(touched ? toTodo(when) : quickAlarm ? toTodo(defaults()) : {}), done: false, source: 'local' }])
    setTitle('')
    setWhen(defaults())
    setTouched(false)
    onAdded()
  }
  const sorted = [...todos].sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? '9').localeCompare(b.due ?? '9'))
  return (
    <>
      <form className="add" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="할 일 추가 · Enter" aria-label="할 일 제목" autoFocus onFocus={() => !touched && setWhen(defaults())} />
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
            <button className="icon-btn del" onClick={() => deleteWithUndo('할 일을 지웠어요', setTodos, t)} aria-label={`${t.title} 삭제`}>×</button>
          </li>
        ))}
      </ul>
    </>
  )
}
