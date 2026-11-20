import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri, linkSend, onEvent, useItems, type LinkDev } from '../data/api'

/* 사람에게 보내기 (Rust people.rs). 등록한 사람 = store `people:<pk>`, 근처 = 비콘 (10초 안에 들린 사람). */
/** fav = 친한 친구 ⭐ (빠른 톡을 받는 사람), via = 초대로 등록됨 (누가 초대했는지) */
export type Person = { id: string; name: string; at: number; fav?: boolean; via?: string }
export type Near = { pk: string; name: string; known: boolean }
export type Pair = { name: string; code: string } | null
/** 보낼 곳 하나 (패널 · 받침 · 펫 둘레 · 가장자리 포탈 공통). id = 'mac' 이면 첫 연결 기기(예전), 'dev:<pk>' 이면 이어진 기기, 그 밖은 사람 pk */
export type Target = { id: string; name: string; on: boolean; os?: 'mac' | 'win' }

const COLORS = ['#d97706', '#7c3aed', '#0f9d58', '#db2777', '#2563eb', '#0891b2', '#b45309', '#9333ea']
export const colorFor = (id: string) => COLORS[[...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length]
export const initial = (name: string) => [...name.trim()].find((c) => /\S/.test(c)) ?? '?'

export function usePeople() {
  const [people, setPeople] = useItems<Person>('people', [])
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
  const toggleFav = (id: string) => setPeople((all) => all.map((p) => (p.id === id ? { ...p, fav: !p.fav } : p)))
  return { people: sorted, near, pair, online, toggleFav }
}

/** 보낼 곳 목록: 이어진 기기(맥 · 다른 Windows) + 등록한 사람 (켜진 사람 먼저) */
export function targets(devs: LinkDev[], people: Person[], online: (id: string) => boolean): Target[] {
  const d = devs.filter((x) => x.files).map((x) => ({ id: `dev:${x.id}`, name: x.name, on: true, os: x.os }))
  return [...d, ...people.filter((p) => !devs.some((x) => x.id === p.id)).map((p) => ({ id: p.id, name: p.name, on: online(p.id) }))]
}
/** 기기 대상인가 (맥 · 다른 Windows — 사람 아님) */
export const isDev = (id: string) => id === 'mac' || id.startsWith('dev:')

/** 파일들을 보낼 곳으로 */
export function sendTo(id: string, paths: string[]) {
  if (!isTauri) return
  if (id === 'mac') paths.forEach((f) => void linkSend(f).catch(() => {}))
  else if (id.startsWith('dev:')) paths.forEach((f) => void linkSend(f, undefined, undefined, id.slice(4)).catch(() => {}))
  else void invoke('people_send', { pk: id, paths })
}

export const peoplePair = (pk: string) => invoke('people_pair', { pk })
export const peoplePairIp = (ip: string) => invoke('people_pair_ip', { ip })
export const peopleMyIp = () => invoke<string | null>('people_my_ip')
export const peopleConfirm = (ok: boolean) => invoke('people_confirm', { ok })
export const peopleForget = (pk: string) => invoke('people_forget', { pk })
