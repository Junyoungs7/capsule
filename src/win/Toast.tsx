import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri, onEvent } from '../data/api'
import { Ico, type IcoKey } from './icons'

/* 알림 카드 (오른쪽 아래, 작업 표시줄 위). Rust 가 그때만 만들고, 사라지면 toast_done 으로 파괴한다.
   kind: recv 받음 · sent 보냄 · fail 실패 · link 연결 바뀜 · pair 페어링(누르면 패널 — 숫자 확인). */
type T = { kind: 'recv' | 'sent' | 'fail' | 'link' | 'pair'; title: string; sub: string }
const ICON: Record<T['kind'], IcoKey> = { recv: 'down', sent: 'send', fail: 'x', link: 'laptop', pair: 'link' }
const MS = 4000

export function Toast() {
  const [t, setT] = useState<T | null>(null)
  const [n, setN] = useState(0)
  const [out, setOut] = useState(false)
  const timer = useRef(0)
  const show = (v: T | null) => void (v && (setT(v), setOut(false), setN((x) => x + 1)))
  useEffect(() => {
    if (!isTauri) return void show({ kind: 'recv', title: '맥에서 파일을 받았어요', sub: 'IMG_2041.png · 선반과 다운로드\Hera에 있어요' })
    void invoke<T | null>('toast_next').then(show)
    return onEvent<T>('toast', show)
  }, [])
  useEffect(() => {
    if (!t) return
    clearTimeout(timer.current)
    // 페어링은 누르거나 끝날 때까지 (최대 60초)
    timer.current = window.setTimeout(() => setOut(true), t.kind === 'pair' ? 60_000 : MS)
    return () => clearTimeout(timer.current)
  }, [n])
  useEffect(() => (isTauri ? onEvent<{ kind: string; state?: string }>('link-files', (e) => e.kind === 'peer' && e.state !== 'pairing' && setT((x) => (x?.kind === 'pair' ? (setOut(true), x) : x))) : undefined), [])
  if (!t) return null
  return (
    <div key={n} className={`toast ${out ? 'out' : 'in'} ${t.kind === 'pair' ? 'click' : ''}`} data-kind={t.kind} role="status"
      onAnimationEnd={() => out && isTauri && void invoke('toast_done')}
      onClick={() => t.kind === 'pair' && isTauri && void invoke('toast_click')}>
      <span className="ti"><Ico k={ICON[t.kind]} /></span>
      <span className="tx"><b>{t.title}</b><small>{t.sub}</small></span>
    </div>
  )
}
