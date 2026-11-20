import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri, linkSend, onEvent, useItems } from '../data/api'

/* 사람에게 보내기 (Rust people.rs). 등록한 사람 = store `people:<pk>`, 근처 = 비콘 (10초 안에 들린 사람). */
export type Person = { id: string; name: string; at: number }
export type Near = { pk: string; name: string; known: boolean }
export type Pair = { name: string; code: string } | null
/** 보낼 곳 하나 (패널 · 받침 · 펫 둘레 · 가장자리 포탈 공통). id = 'mac' 이면 내 맥 */
export type Target = { id: string; name: string; on: boolean }

const COLORS = ['#d97706', '#7c3aed', '#0f9d58', '#db2777', '#2563eb', '#0891b2', '#b45309', '#9333ea']
export const colorFor = (id: string) => COLORS[[...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length]
export const initial = (name: string) => [...name.trim()].find((c) => /\S/.test(c)) ?? '?'

export function usePeople() {
  const [people] = useItems<Person>('people', [])
  const [near, setNear] = useState<Near[]>([])
  const [pair, setPair] = useState<Pair>(null)
  useEffect(() => {
    if (!isTauri) return
    void invoke<Near[]>('people_near').then(setNear, () => {})
    const offs = [onEvent<Near[]>('people-near', setNear), onEvent<Pair>('people-pair', setPair)]
    return () => offs.forEach((f) => f())
  }, [])
  const online = (id: string) => near.some((n) => n.pk === id)
  const sorted = [...people].sort((a, b) => Number(online(b.id)) - Number(online(a.id)) || a.at - b.at)
  return { people: sorted, near, pair, online }
}

/** 보낼 곳 목록: 내 맥(연결돼 있을 때) + 등록한 사람 (켜진 사람 먼저) */
export function targets(mac: string | null, people: Person[], online: (id: string) => boolean): Target[] {
  return [...(mac ? [{ id: 'mac', name: mac, on: true }] : []), ...people.map((p) => ({ id: p.id, name: p.name, on: online(p.id) }))]
}

/** 파일들을 보낼 곳으로 */
export function sendTo(id: string, paths: string[]) {
  if (!isTauri) return
  if (id === 'mac') paths.forEach((f) => void linkSend(f).catch(() => {}))
  else void invoke('people_send', { pk: id, paths })
}

export const peoplePair = (pk: string) => invoke('people_pair', { pk })
export const peopleConfirm = (ok: boolean) => invoke('people_confirm', { ok })
export const peopleForget = (pk: string) => invoke('people_forget', { pk })
