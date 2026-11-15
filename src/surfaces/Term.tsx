import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { isTauri, onEvent, useValue } from '../data/api'

/* 미니 터미널 (떠 있는 창 · 허브 '터미널'): xterm.js 는 이 창이 열릴 때만 불러온다 (평소 메모리 영향 없음).
   셸(ConPTY, 기본 PowerShell)은 Rust 가 들고 있어 창을 닫아도 계속 돈다 — 다시 열면 지금까지의 출력이 그대로.
   '아라에서 이어서 하기' = 아라 CLI 로 같은 폴더에 새 탭 (새 셸이라 스크롤 기록은 안 넘어가고 폴더 · 마지막 명령만). */

type St = { running: boolean; cmd: string; cwd: string; alive: boolean }

export function TermWindow() {
  const box = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLElement>(null)
  const [st, setSt] = useState<St>({ running: false, cmd: '', cwd: '', alive: true })
  const [withCmd, setWithCmd] = useValue('term.araCmd', false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauri) return
    let disposed = false
    const offs: (() => void)[] = []
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')])
      if (disposed || !box.current) return
      const dark = matchMedia('(prefers-color-scheme: dark)').matches
      const t = new Terminal({
        fontFamily: "'Cascadia Mono', Consolas, 'D2Coding', 'Malgun Gothic', monospace",
        fontSize: 13,
        cursorBlink: true,
        allowTransparency: true,
        scrollback: 5000,
        theme: dark ? { background: '#00000000', foreground: '#e6e9ef', cursor: '#34e0a1', selectionBackground: '#34e0a155' } : { background: '#00000000', foreground: '#1b2230', cursor: '#0f9f6e', selectionBackground: '#0f9f6e33' },
      })
      const fit = new FitAddon()
      t.loadAddon(fit)
      t.open(box.current)
      fit.fit()
      const back = await invoke<string>('term_start', { cols: t.cols, rows: t.rows })
      if (back) t.write(back)
      t.onData((d) => void invoke('term_write', { data: d }).catch((e) => setErr(String(e))))
      offs.push(onEvent<string>('term-out', (s) => t.write(s)))
      offs.push(onEvent('term-exit', () => t.write('\r\n\x1b[90m[셸이 끝났어요 — 창을 다시 열면 새로 시작해요]\x1b[0m\r\n')))
      const ro = new ResizeObserver(() => {
        fit.fit()
        void invoke('term_resize', { cols: t.cols, rows: t.rows })
      })
      ro.observe(box.current)
      offs.push(() => (ro.disconnect(), t.dispose()))
      t.focus()
      void invoke<St>('term_state').then(setSt)
    })().catch((e) => setErr(String(e)))
    offs.push(onEvent<St>('term-state', setSt))
    return () => ((disposed = true), offs.forEach((f) => f()))
  }, [])

  const toAra = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    pane.current!.dataset.handoff = 'true'
    void emit('island-flash', { text: '아라로 넘기는 중 → 아라', icon: 'spin', ms: 6000 })
    try {
      const cwd = await invoke<string>('term_to_ara', { withCmd })
      void emit('island-flash', { text: `아라 · 'Hera에서' 탭 · ${cwd.split(/[\\/]/).pop()}`, icon: 'ok', ms: 2200 })
    } catch (e) {
      setErr(String(e))
      void emit('island-flash', { text: '아라로 넘기지 못했어요', icon: 'fail', ms: 2600 })
    } finally {
      setBusy(false)
      setTimeout(() => pane.current && delete pane.current.dataset.handoff, 500)
    }
  }

  const crumbs = (st.cwd || '~').split(/[\\/]/).filter(Boolean)
  return (
    <section ref={pane} className="term">
      <div className="term-head">
        <span className="term-crumbs" title={st.cwd}>{crumbs.map((c, i) => <span key={i}>{c}</span>)}</span>
        {st.running && <span className="term-run"><i className="hub-spin" />{st.cmd || '실행 중'}</span>}
        <label className="term-opt" title="마지막 명령을 아라 탭에서 다시 실행"><input type="checkbox" checked={withCmd} onChange={(e) => setWithCmd(e.target.checked)} />명령도</label>
        <button className="term-ara" onClick={() => void toAra()} disabled={busy}>{busy ? '넘기는 중…' : '아라에서 이어서 하기 ↗'}</button>
      </div>
      <div className="term-out" ref={box} onClick={() => box.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()}>
        {!isTauri && <p className="float-empty">브라우저 시안에는 셸이 없어요 — 실제 앱에서 PowerShell 이 열려요.</p>}
      </div>
      {err && <p className="term-err">{err}</p>}
      <p className="term-legend">아라에 새 탭 = 새 셸이라 스크롤 기록은 안 넘어가요 — 지금 폴더(+ 체크하면 마지막 명령)만 이어져요.</p>
    </section>
  )
}
