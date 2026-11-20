import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri, onEvent, reportHitRects, useValue } from '../data/api'
import { Pet, PETS, petScale, type PetState } from '../surfaces/Pet'

/* 펫 (?surface=pet, 항상 — Rust pet.rs 가 만들고 자리를 잡는다). 창은 클릭 통과, 펫 모양만 누를 수 있다.
   누르기 = 패널 · 오른쪽 클릭 = 빠른 톡(펫 메뉴는 그 안 ⋯) · 6px 넘게 끌기 = 옮기기 (둘 다 Rust pet_press 가 커서로 판단).
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
  const quiet = () => (clearTimeout(timer.current), (timer.current = window.setTimeout(() => setState('sleep'), SLEEP_MS)))
  const react = (s: PetState) => {
    setState(s)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => (setState('idle'), quiet()), REACT_MS)
  }
  useEffect(() => {
    quiet()
    if (!isTauri) return
    return onEvent<'recv' | 'sent' | 'chat'>('pet-react', (k) => react(k === 'recv' ? 'shelf' : k === 'chat' ? 'chat' : 'done'))
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
      // 누르기 · 끌어 옮기기는 Rust 가 단추를 뗄 때까지 커서로 판단한다 (pet_press). onClick 은 키보드(Enter/Space)만
      onPointerDown={(e) => e.button === 0 && (wake(), isTauri && void invoke('pet_press'))}
      onClick={(e) => e.detail === 0 && (wake(), isTauri && void invoke('pet_click', { view: 'main' }))}
      onContextMenu={(e) => (e.preventDefault(), wake(), isTauri && void invoke('pet_click', { view: 'quick' }))}>
      {img ? <img className="pimg" src={img} alt="" draggable={false} />
        : <span className="pbx" style={{ '--pk': petScale(PETS[builtin].style, BIG) } as CSSProperties}><Pet kind={builtin} state={state} /></span>}
    </button>
  )
}
