import { useEffect, useState } from 'react'
import { isTauri, linkApply, linkDevices, linkImport, linkPair, linkStatus, linkTrust, linkUnpair, onEvent, useValue, type LinkCfg, type LinkDev, type LinkFilesEv, type LinkStatus } from '../data/api'

/* Hera Link 상태 묶음 — 패널 · 설정 창이 같이 쓴다. 엔진 상태 'link-status', 파일 채널 'link-files'. */
export const LINK_DEFAULT: LinkCfg = { me: '', peer: 'MacBook', side: 'right', port: 24800, tls: true, doubleTap: false, filePort: 24810, keymap: 'habit', keyRows: [], ime: 'hera', role: 'main', server: '' }
const SIDE: Record<LinkCfg['side'], string> = { left: '왼쪽', right: '오른쪽', top: '위쪽', bottom: '아래쪽' }

export function useLink() {
  const [on, setOnRaw] = useValue('link.enabled', false)
  const [cfg, setCfgRaw] = useValue<LinkCfg | null>('link.cfg', null)
  const [pairedName] = useValue<string | null>('link.peerName', null)
  const [serverName] = useValue<string | null>('link.serverName', null)
  const devs = useDevices()
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
    on, cfg, status, filesPeer, pair, pairedName, serverName, devs,
    setOn: (v: boolean) => (setOnRaw(v), apply()),
    setCfg: (c: LinkCfg) => (setCfgRaw(c), apply()),
    onPair: (ok: boolean) => (setPair(null), void linkPair(ok)),
    onImport: () => linkImport().then(setCfgRaw),
    onTrust: (fp: string) => linkTrust(fp),
    onUnpair: (id?: string) => linkUnpair(id),
  }
}
export type Link = ReturnType<typeof useLink>

/** 이어질 기기 목록 (Rust link_devices — 'link-devices' · 'link-files' 때 다시 읽음) */
export function useDevices() {
  const [devs, setDevs] = useState<LinkDev[]>([])
  useEffect(() => {
    if (!isTauri) return
    const load = () => void linkDevices().then((d) => setDevs(d ?? []), () => {})
    load()
    const offs = [onEvent('link-devices', load), onEvent('link-files', load)]
    return () => offs.forEach((f) => f())
  }, [])
  return devs
}

/** 상태 → 점(ok/warn/off) · 한 줄 제목 · 설명 (짧고 자연스러운 말) */
export function linkLook(b: Pick<Link, 'on' | 'status' | 'pair' | 'cfg' | 'filesPeer' | 'pairedName'> & { serverName?: string | null; devs?: LinkDev[] }) {
  const peer = b.status?.peer || b.pairedName || b.cfg?.peer || '맥'
  const st = b.status?.state ?? 'off'
  const side = SIDE[b.cfg?.side ?? 'right']
  if (b.pair) return { st: 'warn', title: `${b.pair.name} 연결 확인`, sub: '양쪽 숫자가 같으면 같아요를 누르세요', peer }
  if (!b.on) return { st: 'off', title: '연결 꺼짐', sub: '켜면 같은 네트워크의 기기를 기다려요', peer }
  // 받는 쪽: 중심 PC 가 이 PC 를 움직인다
  if (b.cfg?.role === 'sub') {
    const srv = b.serverName || '중심 PC'
    if (st === 'connected') return { st: 'ok', title: `${srv}에 연결됨`, sub: `이 PC를 ${srv}의 마우스·키보드로 써요`, peer: srv }
    if (st === 'error') return { st: 'warn', title: '연결에 문제가 있어요', sub: b.status?.detail || '설정 → 연결을 확인하세요', peer: srv }
    return { st: 'off', title: `${srv} 기다리는 중`, sub: b.status?.detail || '중심 PC의 Hera 연결이 켜지면 이어져요', peer: srv }
  }
  // 여러 기기: 이어진 기기 이름들
  const live = (b.devs ?? []).filter((d) => d.files).map((d) => d.name)
  if (live.length > 1) return { st: 'ok', title: `${live.join(' · ')} 연결됨`, sub: '마우스를 그 기기 쪽 끝으로 밀면 넘어가요', peer: live[0] }
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
