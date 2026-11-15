import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { isTauri, onEvent, useValue } from '../data/api'

/* 미니 터미널: 아일랜드 안 드롭다운(Ctrl+`, 640×300) · 떼어내면 떠 있는 창. xterm.js 는 처음 열 때만 불러온다 (평소 메모리 영향 없음).
   셸(ConPTY, 기본 PowerShell)은 Rust 가 들고 있어 접어도·창을 닫아도 계속 돈다 — 다시 열면 지금까지의 출력이 그대로.
   '아라에서 이어서 하기' = 아라 CLI 로 같은 폴더에 새 탭 (새 셸이라 스크롤 기록은 안 넘어가고 폴더 · 마지막 명령만). */

type St = { running: boolean; cmd: string; cwd: string; alive: boolean }

export function useTermState() {
  const [st, setSt] = useState<St>({ running: false, cmd: '', cwd: '', alive: true })
  useEffect(() => {
    if (!isTauri) return
    void invoke<St>('term_state').then(setSt)
    return onEvent<St>('term-state', setSt)
  }, [])
  return st
}

/** 아라로 넘기기 (Island 에 '넘기는 중 → 아라' · 결과) */
export async function toAra(withCmd: boolean, pane?: HTMLElement | null) {
  if (pane) pane.dataset.handoff = 'true'
  void emit('island-flash', { text: '아라로 넘기는 중 → 아라', icon: 'spin', ms: 6000 })
  try {
    const cwd = await invoke<string>('term_to_ara', { withCmd })
    void emit('island-flash', { text: `아라 · 'Hera에서' 탭 · ${cwd.split(/[\\/]/).pop()}`, icon: 'ok', ms: 2200 })
  } catch (e) {
    void emit('island-flash', { text: '아라로 넘기지 못했어요', icon: 'fail', ms: 2600 })
    throw e
  } finally {
    setTimeout(() => pane && delete pane.dataset.handoff, 500)
  }
}

/** 머리줄: 작은 폴더 경로 · 실행 중 · (명령도) · 아라 */
export function TermHead({ pane }: { pane?: () => HTMLElement | null }) {
  const st = useTermState()
  const [withCmd, setWithCmd] = useValue('term.araCmd', false)
  const [busy, setBusy] = useState(false)
  const crumbs = (st.cwd || '~').split(/[\\/]/).filter(Boolean)
  return (
    <span className="term-head">
      <span className="term-crumbs" title={st.cwd}>{crumbs.map((c, i) => <span key={i}>{c}</span>)}</span>
      {st.running && <span className="term-run"><i className="hub-spin" />{st.cmd || '실행 중'}</span>}
      <label className="term-opt" title="마지막 명령을 아라 탭에서 다시 실행"><input type="checkbox" checked={withCmd} onChange={(e) => setWithCmd(e.target.checked)} />명령도</label>
      <button className="term-ara" disabled={busy} title="아라에서 이어서 하기 (같은 폴더에 새 탭)" aria-label="아라에서 이어서 하기"
        onClick={() => (setBusy(true), void toAra(withCmd, pane?.()).catch(() => {}).finally(() => setBusy(false)))}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-8 8M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></svg>
        아라
      </button>
    </span>
  )
}

export function TermWindow({ inIsland, onEsc }: { inIsland?: boolean; onEsc?: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLElement>(null)
  const [err, setErr] = useState<string | null>(null)
  const esc = useRef(onEsc)
  esc.current = onEsc

  useEffect(() => {
    if (!isTauri) return
    let disposed = false
    const offs: (() => void)[] = []
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')])
      if (disposed || !box.current) return
      const t = new Terminal({
        fontFamily: "'Cascadia Mono', Consolas, 'D2Coding', 'Malgun Gothic', monospace",
        fontSize: 13,
        cursorBlink: true,
        allowTransparency: true,
        scrollback: 5000,
        theme: { background: '#00000000', foreground: '#e6e9ef', cursor: '#34e0a1', selectionBackground: '#34e0a155' },
      })
      const fit = new FitAddon()
      t.loadAddon(fit)
      t.open(box.current)
      fit.fit()
      // 아일랜드 드롭다운: Esc = 접기 (셸에는 보내지 않음). 떼어낸 창에서는 Esc 도 셸로.
      t.attachCustomKeyEventHandler((e) => !(inIsland && e.type === 'keydown' && e.key === 'Escape' && (esc.current?.(), true)))
      const back = await invoke<string>('term_start', { cols: t.cols, rows: t.rows })
      if (back) t.write(back)
      t.onData((d) => void invoke('term_write', { data: d }).catch((e) => setErr(String(e))))
      offs.push(onEvent<string>('term-out', (s) => t.write(s)))
      offs.push(onEvent('term-exit', () => t.write('\r\n\x1b[90m[셸이 끝났어요 — 다시 열면 새로 시작해요]\x1b[0m\r\n')))
      const ro = new ResizeObserver(() => {
        fit.fit()
        void invoke('term_resize', { cols: t.cols, rows: t.rows })
      })
      ro.observe(box.current)
      offs.push(() => (ro.disconnect(), t.dispose()))
      t.focus()
    })().catch((e) => setErr(String(e)))
    return () => ((disposed = true), offs.forEach((f) => f()))
  }, [])

  return (
    <section ref={pane} className="term" data-island={!!inIsland}>
      {!inIsland && <TermHead pane={() => pane.current} />}
      <div className="term-out" ref={box} onClick={() => box.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()}>
        {!isTauri && <p className="float-empty">브라우저 시안에는 셸이 없어요 — 실제 앱에서 PowerShell 이 열려요.</p>}
      </div>
      {err && <p className="term-err">{err}</p>}
      {!inIsland && <p className="term-legend">아라에 새 탭 = 새 셸이라 스크롤 기록은 안 넘어가요 — 지금 폴더(+ 체크하면 마지막 명령)만 이어져요.</p>}
    </section>
  )
}

/** 유령(떼어내기·흡수 애니메이션)용 가벼운 터미널 그림 — xterm 을 또 띄우지 않는다 */
export function TermPreview() {
  const st = useTermState()
  return (
    <section className="term">
      <div className="term-out term-preview"><span>PS {st.cwd || '~'}&gt; {st.running ? st.cmd : ''}</span></div>
    </section>
  )
}
