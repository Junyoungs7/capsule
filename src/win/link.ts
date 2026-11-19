import { useEffect, useState } from 'react'
import { isTauri, linkApply, linkImport, linkPair, linkStatus, linkTrust, linkUnpair, onEvent, useValue, type LinkCfg, type LinkFilesEv, type LinkStatus } from '../data/api'

/* Hera Link 상태 묶음 — 패널 · 설정 창이 같이 쓴다. 엔진 상태 'link-status', 파일 채널 'link-files'. */
export const LINK_DEFAULT: LinkCfg = { me: '', peer: 'MacBook', side: 'right', port: 24800, tls: true, doubleTap: false, filePort: 24810, keymap: 'habit', keyRows: [], ime: 'hera' }
const SIDE: Record<LinkCfg['side'], string> = { left: '왼쪽', right: '오른쪽', top: '위쪽', bottom: '아래쪽' }

export function useLink() {
  const [on, setOnRaw] = useValue('link.enabled', false)
  const [cfg, setCfgRaw] = useValue<LinkCfg | null>('link.cfg', null)
  const [pairedName] = useValue<string | null>('link.peerName', null)
  const [status, setStatus] = useState<LinkStatus | null>(null)
  const [filesPeer, setFilesPeer] = useState<string | null>(null)
  const [pair, setPair] = useState<{ code: string; name: string } | null>(null)
  useEffect(() => {
    if (!isTauri) return
    void linkStatus().then(([s, f]) => (setStatus(s), setFilesPeer(f)))
    const offs = [
      onEvent<LinkStatus>('link-status', setStatus),
      onEvent<LinkFilesEv>('link-files', (e) => e.kind === 'peer' && (setFilesPeer(e.state === 'ready' ? e.name : null), setPair(e.state === 'pairing' ? { code: e.code, name: e.name } : null))),
    ]
    return () => offs.forEach((f) => f())
  }, [])
  // store 에 비동기로 쓰인다 → 잠깐 뒤에 Rust 가 다시 읽게
  const apply = () => isTauri && window.setTimeout(() => void linkApply(), 250)
  return {
    on, cfg, status, filesPeer, pair, pairedName,
    setOn: (v: boolean) => (setOnRaw(v), apply()),
    setCfg: (c: LinkCfg) => (setCfgRaw(c), apply()),
    onPair: (ok: boolean) => (setPair(null), void linkPair(ok)),
    onImport: () => linkImport().then(setCfgRaw),
    onTrust: (fp: string) => linkTrust(fp),
    onUnpair: () => linkUnpair(),
  }
}
export type Link = ReturnType<typeof useLink>

/** 상태 → 점(ok/warn/off) · 한 줄 제목 · 설명 (짧고 자연스러운 말) */
export function linkLook(b: Pick<Link, 'on' | 'status' | 'pair' | 'cfg' | 'filesPeer' | 'pairedName'>) {
  const peer = b.status?.peer || b.pairedName || b.cfg?.peer || '맥'
  const st = b.status?.state ?? 'off'
  const side = SIDE[b.cfg?.side ?? 'right']
  if (b.pair) return { st: 'warn', title: `${b.pair.name} 연결 확인`, sub: '양쪽 숫자가 같으면 같아요를 누르세요', peer }
  if (!b.on) return { st: 'off', title: '연결 꺼짐', sub: '켜면 같은 네트워크의 맥을 기다려요', peer }
  if (st === 'connected') return { st: 'ok', title: `${peer} 연결됨`, sub: `${side} · 마우스를 ${side} 끝으로 밀면 넘어가요`, peer }
  if (st === 'blocked') return { st: 'warn', title: 'Deskflow가 실행 중이에요', sub: 'Deskflow를 끄면 Hera가 이어 받아요', peer }
  if (st === 'error') return { st: 'warn', title: '연결에 문제가 있어요', sub: b.status?.detail || '설정 → 연결을 확인하세요', peer }
  return { st: 'off', title: `${peer} 기다리는 중`, sub: '맥이 켜지면 자동으로 이어져요', peer }
}

/** 함께 쓰기 스위치 (store link.share.<k>, 없으면 켬 — Rust link::shared 와 같은 규칙) */
export function useShare() {
  const [share, setShare] = useValue<Partial<Record<'clip', boolean>>>('link.share', {})
  return [(k: 'clip') => share[k] ?? true, (k: 'clip', v: boolean) => setShare({ ...share, [k]: v })] as const
}
