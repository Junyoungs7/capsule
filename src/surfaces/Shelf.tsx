import { useState, type DragEvent } from 'react'
import { dragOut, isTauri } from '../data/api'
import type { ShelfFile } from '../data/types'

export const SHELF_MAX = 4 // ponytail: 칸 4개, 넘치면 가장 오래된 것부터 뺀다 — 더 필요하면 목록 팝오버
const name = (p: string) => p.split(/[\\/]/).pop()!

type Props = { files: ShelfFile[]; onOpen: (f: ShelfFile) => void; onRemove: (f: ShelfFile) => void; onDrop: (paths: string[]) => void }

// C4 파일 선반: 실제 앱은 독 네이티브 드롭(경로) → Dock 이 넘겨준다. 시안은 HTML5 드롭(이름만).
// 클릭 = 열기, 우클릭 = 선반에서 빼기, 6px 이상 끌면 = 밖으로 끌어내기(네이티브 드래그, 복사).
export function Shelf({ files, onOpen, onRemove, onDrop }: Props) {
  const [over, setOver] = useState(false)
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    onDrop([...e.dataTransfer.files].map((f) => f.name))
  }
  const html5 = isTauri ? {} : { onDragOver: (e: DragEvent) => (e.preventDefault(), setOver(true)), onDragLeave: () => setOver(false), onDrop: drop }
  const sorted = [...files].sort((a, b) => a.at - b.at)
  // 누른 위치 → 6px 넘게 움직이면 네이티브 드래그 시작(이후 click 무시)
  const [down, setDown] = useState<{ x: number; y: number; dragged: boolean } | null>(null)

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
          onPointerDown={(e) => setDown({ x: e.clientX, y: e.clientY, dragged: false })}
          onPointerMove={(e) => {
            if (!isTauri || !(e.buttons & 1) || !down || down.dragged || Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) return
            setDown({ ...down, dragged: true })
            void dragOut(f.path)
          }}
          onClick={() => (down?.dragged ? setDown(null) : onOpen(f))}
          onContextMenu={(e) => (e.preventDefault(), onRemove(f))}
          title={`${name(f.path)}\n클릭: 열기 · 끌기: 밖으로 복사 · 우클릭: 선반에서 빼기`}
          aria-label={`${name(f.path)} 열기`}
        >
          {/\.([a-z0-9]{1,4})$/i.exec(f.path)?.[1] ?? '폴더'}
        </button>
      ))}
    </div>
  )
}
