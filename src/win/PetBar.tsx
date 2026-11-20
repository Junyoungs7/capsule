import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri, onEvent, reportHitRects, useValue } from '../data/api'
import { Pet, PETS, petScale, type PetState } from '../surfaces/Pet'

/* 펫 (?surface=pet, 항상 — Rust pet.rs 가 만들고 자리를 잡는다). 창은 클릭 통과, 펫 모양만 누를 수 있다.
   누르기 = 패널 · 오른쪽 클릭 = 펫 메뉴 · 6px 넘게 끌기 = 옮기기 (Rust 가 커서를 따라간다).
   그림 = 기본 펫 또는 내 이미지 (pet.kind = 'custom' → pet_image 의 data URL, pet.img 가 바뀌면 다시 읽음).
   상태: 평소 → 2분 동안 아무 일 없으면 잠 · 파일을 받으면 상자, 보내면 만세 (3초). */
export const SLEEP_MS = 120_000
const REACT_MS = 3000
const BIG = 1.8 // 기본 펫 44×40 → 84 창에 맞게

export function PetBar() {
  const [kind] = useValue('pet.kind', 'cat')
  const [ver] = useValue<number>('pet.img', 0)
  const [img, setImg] = useState<string | null>(null)
  const [state, setState] = useState<PetState>('idle')
  const box = useRef<HTMLButtonElement>(null)
  const timer = useRef(0)
  const down = useRef<[number, number] | null>(null)
  const moved = useRef(false)
  const quiet = () => (clearTimeout(timer.current), (timer.current = window.setTimeout(() => setState('sleep'), SLEEP_MS)))
  const react = (s: PetState) => {
    setState(s)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => (setState('idle'), quiet()), REACT_MS)
  }
  useEffect(() => {
    quiet()
    if (!isTauri) return
    return onEvent<'recv' | 'sent'>('pet-react', (k) => react(k === 'recv' ? 'shelf' : 'done'))
  }, [])
  useEffect(() => {
    if (kind !== 'custom') return setImg(null)
    if (isTauri) void invoke<string | null>('pet_image').then(setImg, () => setImg(null))
  }, [kind, ver])
  useLayoutEffect(() => void (box.current && reportHitRects([box.current.getBoundingClientRect()])), [])
  const wake = () => state === 'sleep' && (setState('idle'), quiet())
  const builtin = kind in PETS ? kind : 'cat'
  return (
    <button ref={box} className="petbar" data-state={state} aria-label="Hera 열기" title="Hera — 누르면 패널 · 오른쪽 클릭 = 펫 메뉴 · 끌어서 옮기기"
      onPointerDown={(e) => e.button === 0 && ((down.current = [e.screenX, e.screenY]), (moved.current = false))}
      onPointerMove={(e) => {
        const d = down.current
        if (!d || !(e.buttons & 1) || Math.hypot(e.screenX - d[0], e.screenY - d[1]) < 6) return
        down.current = null
        moved.current = true
        if (isTauri) void invoke('pet_drag')
      }}
      onPointerUp={() => (down.current = null)}
      onClick={() => {
        if (moved.current) return void (moved.current = false)
        wake()
        if (isTauri) void invoke('pet_click', { view: 'main' })
      }}
      onContextMenu={(e) => (e.preventDefault(), wake(), isTauri && void invoke('pet_click', { view: 'fx' }))}>
      {img ? <img className="pimg" src={img} alt="" draggable={false} />
        : <span className="pbx" style={{ '--pk': petScale(PETS[builtin].style, BIG) } as CSSProperties}><Pet kind={builtin} state={state} /></span>}
    </button>
  )
}
