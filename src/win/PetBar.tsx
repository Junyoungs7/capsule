import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri, onEvent, reportHitRects, useValue } from '../data/api'
import { Pet, PETS, petScale, type PetState } from '../surfaces/Pet'

/* 작업 표시줄 펫 (?surface=pet, 꾸미기 켜짐일 때만 Rust pet.rs 가 만든다). 창은 클릭 통과, 펫 모양만 누를 수 있다 → 패널.
   상태: 평소 → 2분 동안 아무 일 없으면 잠 (잠든 동안 애니메이션 없음) · 파일을 받으면 상자, 보내면 만세 (3초). */
export const SLEEP_MS = 120_000
const REACT_MS = 3000

export function PetBar() {
  const [kind] = useValue('pet.kind', 'cat')
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
    return onEvent<'recv' | 'sent'>('pet-react', (k) => react(k === 'recv' ? 'shelf' : 'done'))
  }, [])
  useLayoutEffect(() => void (box.current && reportHitRects([box.current.getBoundingClientRect()])), [kind])
  const k = petScale(PETS[kind]?.style ?? 'flat', 1)
  return (
    <button ref={box} className="petbar" data-state={state} aria-label="Hera 열기" title="Hera"
      onClick={() => (state === 'sleep' && (setState('idle'), quiet()), isTauri && void invoke('pet_click'))}
      style={{ '--pk': k } as CSSProperties}>
      <Pet kind={kind in PETS ? kind : 'cat'} state={state} />
    </button>
  )
}
