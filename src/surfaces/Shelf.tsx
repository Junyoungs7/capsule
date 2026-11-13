import { useState, type CSSProperties, type DragEvent } from 'react'

// 파일 선반 시안: HTML5 드롭으로 이름만 보관. 실제(C4)는 독 네이티브 드롭 → 경로 저장.
export function Shelf() {
  const [files, setFiles] = useState<string[]>(['기획서_v3.pdf', '배너_시안.png'])
  const [over, setOver] = useState(false)

  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const names = [...e.dataTransfer.files].map((f) => f.name)
    if (names.length) setFiles((f) => [...f, ...names].slice(-9))
  }

  return (
    <div
      className="dock-slot widget shelf"
      data-over={over}
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      title={files.join('\n') || '파일을 여기에 놓으세요'}
      aria-label={`파일 선반, ${files.length}개`}
    >
      <span className="shelf-stack" aria-hidden>
        {files.slice(-3).map((f, i) => (
          <i key={f + i} style={{ '--i': i } as CSSProperties}>{f.split('.').pop()}</i>
        ))}
      </span>
      <span className="shelf-text">
        <b>선반</b>
        <small>{over ? '놓으세요' : `${files.length}개 파일`}</small>
      </span>
    </div>
  )
}
