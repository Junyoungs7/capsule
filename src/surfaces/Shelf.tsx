import { useState, type DragEvent } from 'react'
import { isTauri } from '../data/api'
import type { ShelfFile } from '../data/types'

export const SHELF_MAX = 4 // ponytail: 칸 4개, 넘치면 가장 오래된 것부터 뺀다 — 더 필요하면 목록 팝오버
const name = (p: string) => p.split(/[\\/]/).pop()!

type Props = { files: ShelfFile[]; onOpen: (f: ShelfFile) => void; onRemove: (f: ShelfFile) => void; onDrop: (paths: string[]) => void }

// C4 파일 선반: 실제 앱은 독 네이티브 드롭(경로) → Dock 이 넘겨준다. 시안은 HTML5 드롭(이름만).
// 클릭 = 열기, 우클릭 = 선반에서 빼기. 밖으로 끌어내기는 없음(Open Question 3).
export function Shelf({ files, onOpen, onRemove, onDrop }: Props) {
  const [over, setOver] = useState(false)
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    onDrop([...e.dataTransfer.files].map((f) => f.name))
  }
  const html5 = isTauri ? {} : { onDragOver: (e: DragEvent) => (e.preventDefault(), setOver(true)), onDragLeave: () => setOver(false), onDrop: drop }
  const sorted = [...files].sort((a, b) => a.at - b.at)

  return (
    <div className="dock-slot widget shelf" data-over={over} aria-label={`파일 선반, ${files.length}개`} {...html5}>
      {sorted.length === 0 && (
        <span className="shelf-text">
          <b>선반</b>
          <small>파일을 놓으세요</small>
        </span>
      )}
      {sorted.map((f) => (
        <button
          key={f.id}
          className="shelf-file"
          onClick={() => onOpen(f)}
          onContextMenu={(e) => (e.preventDefault(), onRemove(f))}
          title={`${name(f.path)}\n클릭: 열기 · 우클릭: 선반에서 빼기`}
          aria-label={`${name(f.path)} 열기`}
        >
          {/\.([a-z0-9]{1,4})$/i.exec(f.path)?.[1] ?? '폴더'}
        </button>
      ))}
    </div>
  )
}
