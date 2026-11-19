import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/win.css'
import './styles/pet.css'
import './styles/kept.css'
import './styles/board.css'
import { closeSelf, coverCloseAll, isTauri, noteNotepad, onEvent } from './data/api'
import { SettingsWin } from './win/Settings'
import { Panel } from './win/Panel'
import { Toast } from './win/Toast'
import { DragLayer } from './win/Drag'
import { NoteBoard } from './surfaces/Notes'
import { UndoToast } from './surfaces/Undo'
import { AsciiFull, SCENES, seasonOf, type SceneId } from './surfaces/Ascii'
import { FX_LABEL, Fx, type FxKind } from './surfaces/Fx'

/* 창 1개 = 표면 1개 (?surface=). panel(트레이 패널) · toast(알림 카드) · drag(받침·포탈) · settings · notes(메모 보드) · ascii(자리 비움 화면) · fx(화면 효과) */
const q = new URLSearchParams(location.search)
const surface = q.get('surface') ?? 'settings'
const dark = matchMedia('(prefers-color-scheme: dark)')
const theme = () => (document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light')
theme()
dark.addEventListener('change', theme)

function Cover() {
  const sc = q.get('scene') as SceneId | FxKind | null
  const [open, setOpen] = useState(true)
  useEffect(() => (isTauri ? onEvent('ascii-close', () => setOpen(false)) : undefined), [])
  const now = new Date()
  return (
    <AsciiFull open={open} id={sc && (sc in SCENES || sc in FX_LABEL) ? sc : 'calm'} from={null} saver
      caption={`${now.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} · ${seasonOf(now)}`}
      onClose={() => (setOpen(false), isTauri && void coverCloseAll())} onClosed={() => void closeSelf()} />
  )
}

function App() {
  if (surface === 'panel') return <Panel />
  if (surface === 'toast') return <Toast />
  if (surface === 'drag') return <DragLayer />
  if (surface === 'notes')
    return (
      <div className="hx boardwin">
        <NoteBoard onNotepad={(id) => void noteNotepad(id).catch(() => {})} />
        <UndoToast />
      </div>
    )
  if (surface === 'ascii') return <Cover />
  if (surface === 'fx') return <Fx kind={(q.get('fx') as FxKind) ?? 'snow'} onDone={() => void closeSelf()} />
  return <SettingsWin sec={q.get('sec')} />
}

createRoot(document.getElementById('root')!).render(<App />)
