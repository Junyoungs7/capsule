import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { appDataDir } from '@tauri-apps/api/path'
import { autostart, closeSelf, isTauri, launch, linkAmbient, onEvent, petExport, petImport, storeDelete, useValue, type LinkCfg } from '../data/api'
import { rollNumber } from '../motion'
import { barDrag } from './Float'
import { Ico, type IcoKey } from './Icons'
import { LINK_DEFAULT, PairCode, SHARES, devicesOf, linkLook, useShare, type LinkBundle } from './Connect'
import { AMBIENT, KeyRows, MAC_LABEL, MonitorCanvas, PRESETS, WIN_LABEL, mapped } from './LinkExtras'
import { McpSettings } from './Mcp'
import { Pet, PETS, PET_STATES, SIZES_CAP, STYLES, petScale, type CapSize, type PetStyle } from './Pet'
import { customOf, draftOf, newDraft, pick, PetImportView, refreshPets, removePet, useCustomPets, type Draft, type IslandPrefs } from './PetSettings'
import { TeamSection } from './Team'
import { UndoToast } from './Undo'
import type { Weather } from './Fx'
import { moonName, moonPhase } from './Ascii'

/* (a6) 설정 창 (승인 시안 lp-settings.html): 940×680 · 왼쪽 목록 + 검색. 처음 열 때만 만들어지고 닫으면 파괴 (평소 메모리 0).
   모든 항목은 진짜 설정(store 키·Rust 명령)에 이어져 있다. 아직 없는 기능은 흐리게 '준비 중'. */

type Sec = 'general' | 'island' | 'pet' | 'link' | 'chat' | 'term' | 'keys' | 'about'
const SECS: [Sec, string, IcoKey, string][] = [
  ['general', '일반', 'power', '--gray'], ['island', '캡슐', 'island', '--indigo'], ['pet', '펫', 'paw', '--pink'], ['link', '연결', 'link', '--teal'],
  ['chat', '채팅', 'chat', '--green'], ['term', '터미널 · 아라', 'term', '--gray'], ['keys', '단축키', 'key', '--orange'], ['about', '정보', 'info', '--blue'],
]
const SEC_WORDS: Record<Sec, string> = {
  general: '할 일 알림 날짜 시작 자동 실행 윈도우 트레이 상단 공간 메뉴막대 날씨 계절 효과 도시 화면보호기 자리 비움 아스키 폴더',
  island: 'island 아일랜드 위치 자리 끌기 옮기기 처음 크기 작게 보통 크게 아주 전체화면 숨기기 알림 펫 캡슐',
  pet: '펫 내 펫 추가 픽셀 플랫 클레이 라인 잠들기 이미지 zip 가져오기 내보내기',
  link: '연결 페어링 기기 맥 pc 마우스 키보드 클립보드 파일 동기화 모니터 배치 키 매핑 한/영 tls 포트 deskflow 코드 해제 함께',
  chat: '채팅 보관 기간 파일 크기 사진 팀 team 그룹 초대 코드 알림 소리',
  term: '터미널 아라 셸 powershell 시작 폴더 글꼴 명령 끝나면 알림 ai mcp claude',
  keys: '단축키 키 터미널 ocr 허브',
  about: '정보 버전 업데이트 라이선스 로그 데이터 개인정보',
}
type LinkTab = 'devices' | 'share' | 'layout' | 'keyboard' | 'adv'
const LTABS: [LinkTab, string][] = [['devices', '기기'], ['share', '함께 쓰기'], ['layout', '화면 배치'], ['keyboard', '키보드'], ['adv', '고급']]
const SIZE_PX: Record<CapSize, [number, number]> = { s: [64, 48], m: [80, 60], l: [96, 72], xl: [112, 84] }
export const parseSec = (s: string | null): [Sec, LinkTab] => {
  const [a, b] = (s ?? 'general').split(':')
  return [(SECS.some(([k]) => k === a) ? a : 'general') as Sec, (LTABS.some(([k]) => k === b) ? b : 'devices') as LinkTab]
}

export type SettingsProps = {
  sec: string | null
  prefs: IslandPrefs
  setPref: <K extends keyof IslandPrefs>(k: K, v: IslandPrefs[K]) => void
  fx: { on: boolean; setOn: (v: boolean) => void; city: string; setCity: (c: string) => void; weather: Weather | null; now: () => void }
  idleMin: number
  setIdleMin: (m: number) => void
  link: LinkBundle
  onClose?: () => void // 시안: 페이지 안 창 닫기
}

/* ── 작은 부품 ── */
const Row = ({ t, s, children, lead, soon, hit }: { t: ReactNode; s?: ReactNode; children?: ReactNode; lead?: ReactNode; soon?: boolean; hit?: boolean }) => (
  <div className={`srow ${hit ? 'hit' : ''}`} data-soon={soon || undefined}>{lead}<span className="tt"><b>{t}{soon && <span className="soon">준비 중</span>}</b>{s && <small>{s}</small>}</span>{children}</div>
)
const Sw = ({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) => (
  <button className={`sw ${on ? 'on' : ''}`} aria-pressed={on} aria-label={label} onClick={() => set(!on)} />
)
function Sel<T extends string | number>({ value, set, opts, label }: { value: T; set: (v: T) => void; opts: [T, string][]; label: string }) {
  return (
    <span className="sel">
      <select value={String(value)} aria-label={label} onChange={(e) => set((typeof value === 'number' ? Number(e.target.value) : e.target.value) as T)}>
        {opts.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
      </select>
      <Ico k="chevd" />
    </span>
  )
}
/** 스테퍼: 숫자가 굴러 바뀌고 한계에서 누르면 옆으로 툭 */
function Step({ value, set, min = 0, max, step = 1, unit, label }: { value: number; set: (v: number) => void; min?: number; max: number; step?: number; unit: string; label: string }) {
  const b = useRef<HTMLElement>(null)
  const go = (d: 1 | -1) => {
    const n = Math.min(max, Math.max(min, value + d * step))
    rollNumber(b.current, d, n === value)
    if (n !== value) set(n)
  }
  return (
    <span className="step" role="group" aria-label={label}>
      <button onClick={() => go(-1)} aria-label="줄이기"><Ico k="minus" /></button>
      <b ref={b} data-v={value}>{value === 0 ? '끔' : value + unit}</b>
      <button onClick={() => go(1)} aria-label="늘리기"><Ico k="plus" /></button>
    </span>
  )
}
const Head = ({ k, sub, extra }: { k: Sec; sub: string; extra?: ReactNode }) => {
  const [, l, ic, c] = SECS.find((s) => s[0] === k)!
  return <div className="ph"><span className="well" style={{ '--c': `var(${c})` } as CSSProperties}><Ico k={ic} /></span><div><h1>{l}</h1><p>{sub}</p></div><span className="spacer" />{extra}</div>
}
const Grp = ({ h, children, cls }: { h?: ReactNode; children: ReactNode; cls?: string }) => <div className={`grp ${cls ?? ''}`}>{h && <h2>{h}</h2>}{children}</div>
const Keys = ({ combo }: { combo: string }) => <>{combo.split('+').map((x) => <kbd key={x}>{x === 'Backquote' ? '`' : x}</kbd>)}</>

export function SettingsWin(p: SettingsProps) {
  const [[sec, ltab], setNav] = useState(() => parseSec(p.sec))
  const [q, setQ] = useState('')
  const [toast, setToast] = useState<{ t: string; n: number } | null>(null)
  const say = (t: string) => setToast((x) => ({ t, n: (x?.n ?? 0) + 1 }))
  useEffect(() => {
    if (!toast) return
    const h = setTimeout(() => setToast(null), 1800)
    return () => clearTimeout(h)
  }, [toast?.n])
  const pane = useRef<HTMLDivElement>(null)
  const go = (s: Sec, t?: LinkTab) => (s !== sec && pane.current && (pane.current.scrollTop = 0), setNav([s, t ?? ltab]))
  // 이미 열린 창에 다른 섹션 요청 (허브 '연결' → 'link:devices' 등)
  useEffect(() => (isTauri ? onEvent<string>('settings-sec', (s) => setNav(parseSec(s))) : undefined), [])
  const close = () => (p.onClose ? p.onClose() : void closeSelf())
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && !(e.target as Element).closest?.('input, select') && close()
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [])
  // 검색: 맞지 않는 섹션은 흐리게, 지금 섹션이 안 맞으면 처음 맞는 섹션으로
  const qv = q.trim().toLowerCase()
  const match = (k: Sec) => !qv || SECS.find((s) => s[0] === k)![1].toLowerCase().includes(qv) || SEC_WORDS[k].includes(qv)
  useEffect(() => {
    if (qv && !match(sec)) {
      const first = SECS.find(([k]) => match(k))
      if (first) go(first[0])
    }
  }, [qv])
  const look = linkLook(p.link)
  const idx = SECS.findIndex(([k]) => k === sec)
  return (
    <div className="hx a6 swin">
      <section className="sbox pop" role="dialog" aria-label="Hera 설정">
        <div className="wtitle" onPointerDown={barDrag}>
          <span className="mark"><i /></span><b>Hera 설정</b>
          <label className="wsearch"><Ico k="search" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="설정 검색 (예: 단축키, 페어링, 보관)" aria-label="설정 검색" /></label>
          <span className="spacer" />
          <button className="wbtn" data-sclose onClick={close} aria-label="설정 닫기"><Ico k="close" /></button>
        </div>
        <div className="wbody">
          <nav className="nav" aria-label="설정 섹션">
            <i className="ind" style={{ transform: `translateY(${idx * 40}px)` }} />
            {SECS.map(([k, l, ic, c]) => (
              <button key={k} className={`${sec === k ? 'on' : ''} ${match(k) ? '' : 'dim'}`} data-sec={k} aria-current={sec === k ? 'page' : 'false'} style={{ marginBottom: 2 }} onClick={() => go(k)}>
                <span className="well sm" style={{ '--c': `var(${c})` } as CSSProperties}><Ico k={ic} /></span>{l}
                {k === 'link' && <i className="stat" style={{ background: look.cls === 'ok' ? 'var(--green)' : look.cls === 'warn' ? 'var(--orange)' : '#55555c' }} />}
              </button>
            ))}
            <div className="foot">설정은 이 PC에만 저장돼요</div>
          </nav>
          <div className="pane" ref={pane}>
            <div className="pin pane-in" key={sec + (sec === 'link' ? ltab : '')} data-pane={sec}>
              {sec === 'general' && <General {...p} say={say} />}
              {sec === 'island' && <IslandPane {...p} />}
              {sec === 'pet' && <PetPane {...p} say={say} />}
              {sec === 'link' && <LinkPane b={p.link} tab={ltab} setTab={(t) => go('link', t)} say={say} />}
              {sec === 'chat' && <ChatPane />}
              {sec === 'term' && <TermPane />}
              {sec === 'keys' && <KeysPane />}
              {sec === 'about' && <About />}
            </div>
          </div>
        </div>
        {toast && <div key={toast.n} className="toast on" role="status">{toast.t}</div>}
        <UndoToast />
      </section>
    </div>
  )
}

/* ── 일반 ── */
function General({ fx, idleMin, setIdleMin, say }: SettingsProps & { say: (t: string) => void }) {
  const [auto, setAuto] = useState(false)
  useEffect(() => void (isTauri && autostart().then(setAuto, () => {})), [])
  const [appbar, setAppbar] = useValue('appbar.on', false)
  const [quickAlarm, setQuickAlarm] = useValue('todo.quickAlarm', true)
  const [draft, setDraft] = useState(fx.city)
  useEffect(() => setDraft(fx.city), [fx.city]) // 저장된 도시는 창이 열린 뒤에 읽힌다 (예전: '서울'이 남아 있다가 그대로 덮어씀)
  const save = () => draft.trim() && draft.trim() !== fx.city && fx.setCity(draft.trim())
  const folder = () => void appDataDir().then((d) => launch(d)).then(() => say('탐색기에서 열었어요'), (e) => say(String(e)))
  return (
    <>
      <Head k="general" sub="Hera가 켜지는 방식과 바탕화면 효과" />
      <Grp h="시작"><div className="card">
        <Row t="Windows 시작 시 Hera 실행" s="기본은 꺼짐 — 켜면 로그인할 때 트레이로 조용히 시작해요"><Sw on={auto} label="Windows 시작 시 실행" set={(v) => (isTauri ? void autostart(v).then(setAuto) : setAuto(v))} /></Row>
        <Row t="트레이 아이콘" s="알림 영역에서 효과 끄기·종료 · 지금은 항상 켜져 있어요" soon><Sw on label="트레이 아이콘" set={() => {}} /></Row>
      </div></Grp>
      <Grp h="화면"><div className="card">
        <Row t="상단 공간 확보" s="맥 메뉴막대처럼 위쪽 28px 비우기 · 최대화한 창이 그 아래에서 시작해요. 기본 꺼짐"><Sw on={appbar} set={setAppbar} label="상단 공간 확보" /></Row>
      </div></Grp>
      <Grp h="날씨 · 계절 효과"><div className="card">
        <Row t="날씨·시간 효과" s="눈·비가 오기 시작할 때, 노을, 달이 뜰 때 20~30초 동안 바탕화면에 보여요"><Sw on={fx.on} set={fx.setOn} label="효과 이벤트" /></Row>
        <Row t="도시" s={`${fx.city} · ${fx.weather ? `${fx.weather.text} ${fx.weather.temp}°` : '날씨 정보 없음'} · 달 ${moonName(moonPhase(new Date()))}`}>
          <input className="inp" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && save()} style={{ width: 140 }} aria-label="도시" />
        </Row>
        <Row t="지금 한 번 보기" s="지금 날씨·시간대에 맞는 효과를 바로 띄워요"><button className="btn ghost sm" onClick={() => (fx.now(), say('바탕화면에 효과를 띄웠어요'))}><Ico k="play" />보기</button></Row>
      </div></Grp>
      <Grp h="할 일"><div className="card">
        <Row t="날짜 없이 저장한 할 일 알림" s="날짜를 고르지 않고 저장하면 지금부터 1시간 뒤에 알려 줘요 · 끄면 날짜·알림 없이 저장해요"><Sw on={quickAlarm} set={setQuickAlarm} label="날짜 없이 저장한 할 일 알림" /></Row>
      </div></Grp>
      <Grp h="자리 비움"><div className="card">
        <Row t="화면보호기" s="한동안 입력이 없으면 모든 모니터를 아스키·효과 그림으로 가려요 · 마우스를 움직이면 사라져요"><Step value={idleMin} set={setIdleMin} max={120} unit="분" label="대기 시간" /></Row>
      </div></Grp>
      <Grp h="데이터"><div className="card">
        <Row t="설정 폴더" s={<span className="mono">%APPDATA%\com.hera.app</span>}><button className="btn ghost sm" onClick={folder} disabled={!isTauri}><Ico k="folder" />열기</button></Row>
      </div></Grp>
    </>
  )
}

/* ── Island ── */
function IslandPane({ prefs, setPref }: SettingsProps) {
  const list = useCustomPets()
  const [pos, setPos] = useValue<{ fx: number; fy: number } | null>('island.pos', null) // 캡슐을 끌어 놓은 자리 (Rust 가 저장)
  const [w, h] = SIZE_PX[prefs.size]
  const K = SIZES_CAP[prefs.size][1]
  const c = customOf(prefs.pet, list)
  const style = c ? 'custom' : PETS[prefs.pet]?.style ?? 'flat'
  return (
    <>
      <Head k="island" sub="바탕화면에 떠 있는 캡슐 — 크기는 캡슐과 펫만 바뀌어요 (허브·화면은 그대로)" />
      <div className="ipv">
        <span className="lbl"><b>미리보기</b> · {SIZES_CAP[prefs.size][0]} {w}×{h}</span><i className="tbar" />
        <span className="mcap" data-pos={pos ? 'saved' : 'home'} style={{ width: w * 0.62, height: h * 0.62, borderRadius: h * 0.31, ...(pos ? { left: `${pos.fx * 100}%`, top: `calc(${pos.fy} * (100% - 18px))`, bottom: 'auto', translate: '-50% -50%' } : { right: 14 }) }}>
          <span className="petbox" style={{ '--pk': K * 0.62 } as CSSProperties}><Pet kind={c ? prefs.pet : prefs.pet in PETS ? prefs.pet : 'cat'} custom={c} state="idle" pk={c ? 0.62 : petScale(style as PetStyle, prefs.size) * 0.62} /></span>
        </span>
      </div>
      <Grp h="위치"><div className="card">
        <Row t="캡슐을 끌어서 원하는 곳에 두세요" s="놓은 자리를 기억해요 · 허브와 알림은 화면 안쪽으로 펼쳐져요">
          <button className="btn ghost sm" data-pos-reset disabled={!pos} onClick={() => (isTauri ? storeDelete('island.pos') : setPos(null))}>처음 자리로</button>
        </Row>
      </div></Grp>
      <Grp h="크기"><div className="sizes">
        {(Object.keys(SIZES_CAP) as CapSize[]).map((k) => (
          <button key={k} className={prefs.size === k ? 'on' : ''} data-size-set={k} onClick={() => setPref('size', k)}><b>{SIZES_CAP[k][0]}</b><small>{SIZE_PX[k][0]}×{SIZE_PX[k][1]}</small></button>
        ))}
      </div><p className="snote">픽셀 펫은 크기를 바꿔도 흐려지지 않아요.</p></Grp>
      <Grp h="동작"><div className="card">
        <Row t="전체화면 앱에서 자동으로 숨기기" s="게임·발표·영상 전체화면일 때"><Sw on={prefs.autohide} set={(v) => setPref('autohide', v)} label="전체화면에서 숨기기" /></Row>
        <Row t="펫으로 알림 받기" s="캡슐이 넓어지며 짧은 글 + 펫 자세 · 일정·채팅·터미널·선반"><Sw on={prefs.alerts} set={(v) => setPref('alerts', v)} label="펫 알림" /></Row>
        <Row t="알려 줄 것 고르기" s="종류마다 끄고 켜기 (일정 · 채팅 · 터미널 끝남 · 선반 · 파일 받기 · 연결 바뀜)" soon />
      </div></Grp>
    </>
  )
}

/* ── 펫 ── */
function PetPane({ prefs, setPref, say }: SettingsProps & { say: (t: string) => void }) {
  const list = useCustomPets()
  const cur = customOf(prefs.pet, list)
  const [tab, setTab] = useState<PetStyle | 'custom'>(cur ? 'custom' : PETS[prefs.pet]?.style ?? 'flat')
  const [draft, setDraft] = useState<Draft | null>(null)
  const zip = () => pick('.zip,application/zip', false, false, async (fs) => {
    try {
      const id = await petImport(fs[0])
      await refreshPets()
      setPref('pet', `custom:${id}`)
      say('펫을 가져왔어요')
    } catch (e) {
      say(`가져오지 못했어요 · ${e}`)
    }
  })
  if (draft)
    return (
      <>
        <Head k="pet" sub={draft.id ? '내 펫 편집 · 이름 · 이미지 · 상태 칸' : '펫 추가 · 이미지 1장이면 충분해요'} />
        <div className="petimp" data-k="petimport">
          <PetImportView draft={draft} setDraft={setDraft} size={prefs.size} onCancel={() => setDraft(null)} onSaved={(id) => (setPref('pet', `custom:${id}`), setDraft(null), setTab('custom'), say('저장했어요'))} />
        </div>
      </>
    )
  const shown = cur ? prefs.pet : prefs.pet in PETS ? prefs.pet : 'cat'
  return (
    <>
      <Head k="pet" sub={`캡슐에 사는 친구 · 기본 ${Object.keys(PETS).length}종 + 내 펫`} />
      <div className="pettabs">
        {(Object.keys(STYLES) as (PetStyle | 'custom')[]).map((k) => <button key={k} className={tab === k ? 'on' : ''} data-pettab={k} onClick={() => setTab(k)}>{STYLES[k]}</button>)}
      </div>
      <div className="petgrid">
        {tab !== 'custom'
          ? Object.entries(PETS).filter(([, x]) => x.style === tab).map(([k, x]) => (
            <button key={k} className={`ptile ${prefs.pet === k ? 'on' : ''}`} data-pet-set={k} onClick={() => setPref('pet', k)}>
              <span className="pbx"><span className="petbox"><Pet kind={k} state="idle" pk={petScale(x.style, 's')} /></span></span><small>{x.name}</small>
            </button>
          ))
          : (
            <>
              {list.map((c) => (
                <div key={c.id} className={`ptile ctile ${prefs.pet === `custom:${c.id}` ? 'on' : ''}`}>
                  <button className="pbx" data-pet-set={`custom:${c.id}`} onClick={() => setPref('pet', `custom:${c.id}`)} aria-label={c.name}><span className="petbox"><Pet kind={c.id} custom={c} state="idle" pk={1} /></span></button>
                  <small>{c.name}</small>
                  <span className="cact">
                    <span role="button" onClick={() => void draftOf(c).then(setDraft)} aria-label={`${c.name} 편집·이름 바꾸기`} title="편집·이름 바꾸기"><Ico k="edit" /></span>
                    <span role="button" onClick={() => void petExport(c.id).then((x) => say(`내보냈어요 · ${x}`), (e) => say(String(e)))} aria-label={`${c.name} 내보내기`} title=".herapet.zip으로 내보내기"><Ico k="download" /></span>
                    <span role="button" className="del" data-cpet-del={c.id} onClick={() => void removePet(c.id).then(() => prefs.pet === `custom:${c.id}` && setPref('pet', 'cat'))} aria-label={`${c.name} 삭제`} title="삭제"><Ico k="trash" /></span>
                  </span>
                </div>
              ))}
              <button className="ptile add" data-cpet="add" onClick={() => setDraft(newDraft())}><Ico k="plus" /><small>펫 추가</small></button>
              <button className="ptile add" onClick={zip} title=".herapet.zip 가져오기"><Ico k="upload" /><small>zip 가져오기</small></button>
            </>
          )}
      </div>
      {tab === 'custom' && <p className="snote">내 펫 이미지는 이 PC의 <span className="mono">%APPDATA%\com.hera.app\pets</span> 에만 저장돼요. 업로드하지 않아요.</p>}
      <Grp h={`${cur?.name ?? PETS[shown]?.name ?? ''} · 상태별 모습`}><div className="pstrip">
        {PET_STATES.map(([s, l]) => <div key={s}><span className="petbox"><Pet kind={shown} custom={cur} state={s} pk={cur ? 0.6 : petScale(PETS[shown]?.style ?? 'flat', 's') * 0.8} /></span><small>{l}</small></div>)}
      </div></Grp>
      <Grp h="동작"><div className="card">
        <Row t="조용하면 잠들기" s="2분 동안 아무 일이 없으면 잠들어요 · 잠든 동안은 거의 쉬어요 · 지금은 항상 켜져 있어요" soon />
        <Row t="움직임 줄이기" s="Windows 설정 '애니메이션 효과'를 따라요 — 끄면 자세만 바뀌어요"><span className="chip">시스템 따름</span></Row>
      </div></Grp>
    </>
  )
}

/* ── 연결 ── */
function LinkPane({ b, tab, setTab, say }: { b: LinkBundle; tab: LinkTab; setTab: (t: LinkTab) => void; say: (t: string) => void }) {
  const c: LinkCfg = { ...LINK_DEFAULT, ...b.cfg }
  const put = (patch: Partial<LinkCfg>) => b.setCfg({ ...c, ...patch })
  const look = linkLook(b)
  const [get, set] = useShare(b)
  const [locator, setLocator] = useValue('locator.enabled', true)
  const live = b.on && b.status?.state === 'connected'
  const devs = devicesOf(b)
  const m = mapped(c)
  return (
    <>
      <Head k="link" sub="내 PC와 맥이 마우스·키보드·클립보드·파일을 함께 써요" />
      <div className="hero">
        <div className="pcs">
          <span className="pc"><span className="well" style={{ '--c': 'var(--teal)' } as CSSProperties}><Ico k="pc" /></span><b>{c.me || '이 PC'}</b></span>
          <span className={`wire ${live ? '' : 'off'}`} key={look.cls + look.label}><i /></span>
          <span className="pc"><span className="well" style={{ '--c': 'var(--teal)', ...(live ? {} : { filter: 'saturate(.2)', opacity: 0.6 }) } as CSSProperties}><Ico k="laptop" /><i className={`sdot ${look.cls}`} /></span><b>{look.peer}</b></span>
        </div>
        <span className="tt" style={{ paddingLeft: 8 }}><b>{look.title}</b><small>{look.sub}</small></span>
        <Sw on={b.on} set={b.setOn} label="Hera Link 켜기" />
      </div>
      <div className="tabs2" role="tablist">
        {LTABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} data-ltab={k} onClick={() => setTab(k)}>{l}{k === 'devices' && b.pair && <span className="badge">1</span>}</button>)}
      </div>
      {tab === 'devices' && (
        <>
          {b.pair && <PairCode code={b.pair.code} who={b.pair.name} onPair={b.onPair} />}
          {b.status?.fingerprint && (
            <div className="card"><Row t="처음 보는 맥 · 확인할 지문" s={<span className="mono">{b.status.fingerprint.match(/.{1,4}/g)?.slice(0, 8).join(' ')}…</span>} lead={<Ico k="shield" className="ico lead" />}><button className="btn sm" onClick={() => b.onTrust(b.status!.fingerprint)}>신뢰</button></Row></div>
          )}
          <Grp h="이 PC"><div className="card">
            <Row t="이 PC 이름" s={`포트 ${c.port} · 맥 Hera에 이 이름으로 보여요`} lead={<span className="well md" style={{ '--c': 'var(--teal)' } as CSSProperties}><Ico k="pc" /></span>}>
              <input className="inp" key={c.me} defaultValue={c.me} placeholder="이 PC 이름" style={{ width: 140 }} aria-label="이 PC 이름" onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} onBlur={(e) => e.target.value.trim() !== c.me && put({ me: e.target.value.trim() })} />
            </Row>
            <Row t="다른 기기에서 보이기" s="같은 네트워크의 Hera가 이 PC를 찾을 수 있어요 · 끄면 페어링한 기기만 찾아요" soon><Sw on label="보이기" set={() => {}} /></Row>
          </div></Grp>
          <Grp h={<>내 기기 <span className="chip">{devs.length}대 페어링</span></>}><div className="card devs">
            {devs.map((d) => (
              <div key={d.id} className="srow" data-dev={d.id}>
                <span className="well md" style={{ '--c': 'var(--teal)' } as CSSProperties}><Ico k={d.icon} /><i className={`sdot ${d.cls}`} /></span>
                <span className="tt"><b>{d.name}<span className={`chip ${d.cls === 'ok' ? 'ok' : ''}`} style={{ height: 20 }}><i />{d.label}</span></b><small>{d.sub}</small></span>
                <button className="btn danger sm" data-unpair={d.id} onClick={() => (b.onUnpair(), say('페어링을 해제했어요'))}>페어링 해제</button>
              </div>
            ))}
            {!devs.length && <Row t="페어링한 기기가 없어요" s="맥 Hera에서 이 PC를 고르면 위에 6자리 숫자가 떠요" />}
          </div></Grp>
          <Grp h={<>같은 네트워크에서 찾음 <span className="chip info"><Ico k="wifi" />준비 중</span></>}><div className="card devs">
            <Row t="주변 기기 찾기" s="지금은 맥 Hera에서 연결을 시작해요 — 이 목록은 다음 버전에서" soon />
          </div><p className="snote">페어링 = 양쪽 화면에 같은 6자리가 뜨면 <b>같아요</b>. 처음 한 번만 하고, 그다음부터는 켜질 때 자동으로 이어져요.</p></Grp>
        </>
      )}
      {tab === 'share' && (
        <>
          {!live && <p className="snote" style={{ color: 'var(--orange)' }}>{look.peer} 가 연결되면 아래 항목이 바로 켜져요. 지금 상태: {look.label}</p>}
          <div className="sharegrid">
            {SHARES.map(([k, i, t, , s]) => (
              <div key={k} className={`sh ${get(k) ? '' : 'off'}`} data-share={k}>
                <span className="well md" style={{ '--c': 'var(--teal)' } as CSSProperties}><Ico k={i} /></span>
                <span className="tt"><b>{t}</b><small>{s}</small>
                  <span className={`chip ${get(k) && live ? 'ok' : ''}`}><i />{!get(k) ? '꺼짐' : live ? '사용 중' : '대기'}</span>
                  {k === 'fx' && get('fx') && live && <div className="togs" style={{ marginTop: 8 }}>{AMBIENT.slice(0, 4).map(([l, a]) => <button key={l} className="tog" onClick={() => void linkAmbient(a).then(() => say(`${look.peer} 화면에 ${l}`), (e) => say(String(e)))}>{l}</button>)}</div>}
                </span>
                <Sw on={get(k)} set={(v) => set(k, v)} label={t} />
              </div>
            ))}
          </div>
        </>
      )}
      {tab === 'layout' && (
        <>
          <Grp h="모니터 배치"><MonitorCanvas connected={!!b.filesPeer} />
            <p className="snote">PC 모니터는 Windows 배치 그대로 · <b>맥 모니터를 끌어</b> PC 모니터 가장자리에 붙이면 맞닿은 구간(파란 선)으로만 넘어가요.</p></Grp>
          <Grp><div className="card">
            <Row t="가장자리 두 번 치기" s="실수로 넘어가지 않게 — 두 번 밀어야 넘어가요"><Sw on={c.doubleTap} set={(v) => put({ doubleTap: v })} label="두 번 치기" /></Row>
            <Row t="마우스 흔들어 커서 찾기" s="빠르게 좌우로 흔들면 커서 둘레에 파란 물결"><Sw on={locator} set={setLocator} label="커서 찾기" /></Row>
            <Row t={`${look.peer}를 안 쓰면 자동 화면보호기`} s="맥을 N분 동안 쓰지 않으면 맥 화면을 가려요 · 0 = 끔"><Step value={c.autoSaverMin} set={(n) => put({ autoSaverMin: n })} max={240} step={5} unit="분" label="자동 화면보호기" /></Row>
          </div></Grp>
        </>
      )}
      {tab === 'keyboard' && (
        <>
          <Grp h={`${look.peer}에서 쓸 때 수식키`}><div className="presets">
            {PRESETS.map(([k, t, s]) => <button key={k} className={`preset ${c.keymap === k ? 'on' : ''}`} data-keymap={k} onClick={() => put({ keymap: k })}><b>{t}</b><small>{s}</small></button>)}
          </div></Grp>
          <div className="kbrow">
            {(['ctrl', 'super', 'alt', 'space', 'altgr', 'ctrl'] as const).map((k, i) => k === 'space'
              ? <span key={i} className="kc wide"><small>Space</small></span>
              : <span key={i} className={`kc ${m[k] !== k || (c.keymap === 'shortcuts' && k === 'ctrl') ? 'chg' : ''}`}><b>{WIN_LABEL[k]}</b><small>{c.keymap === 'shortcuts' && k === 'ctrl' ? '⌃ (단축키 ⌘)' : MAC_LABEL[m[k]]}</small></span>)}
          </div>
          {c.keymap === 'custom' && <KeyRows c={c} put={put} />}
          <Grp><div className="card">
            <Row t="한/영 (맥에 커서가 있을 때)" s={c.ime === 'hera' ? '맥 Hera가 입력 소스를 바꿔요 · 맥에 Hera가 없으면 맥의 Ctrl+Space를 보내요' : c.ime === 'off' ? '한/영 키를 맥으로 넘기지 않아요' : '맥 입력 전환 단축키 보내기 (실험적)'}>
              <Sel value={c.ime} set={(v) => put({ ime: v })} label="한/영 방식" opts={[['hera', '맥 Hera'], ['capslock', 'Caps Lock'], ['ctrl-space', '맥 Ctrl+Space'], ['cmd-space', '맥 ⌘+Space'], ['off', '끄기']]} />
            </Row>
          </div></Grp>
        </>
      )}
      {tab === 'adv' && (
        <>
          <Grp><div className="card">
            <Row t="연결 암호화" s="끄면 같은 네트워크의 누구나 입력을 볼 수 있어요 · 기본 켜짐" lead={<Ico k="lock" className="ico lead" />}><Sw on={c.tls} set={(v) => put({ tls: v })} label="TLS" /></Row>
            <Row t="맥 위치" s="이 PC 화면 기준 · 모니터마다 정하려면 화면 배치"><Sel value={c.side} set={(v) => put({ side: v })} label="맥 위치" opts={[['right', '오른쪽'], ['left', '왼쪽'], ['top', '위'], ['bottom', '아래']]} /></Row>
            <Row t="맥 이름" s="맥 Hera에 적힌 이름과 같아야 해요"><input className="inp" key={c.peer} defaultValue={c.peer} style={{ width: 140 }} aria-label="맥 이름" onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== c.peer && put({ peer: e.target.value.trim() })} /></Row>
            <Row t="입력 포트" s="맥 Hera와 같아야 해요"><input className="inp mono" key={c.port} defaultValue={c.port} style={{ width: 90, textAlign: 'center' }} aria-label="입력 포트" onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} onBlur={(e) => Number(e.target.value) > 0 && Number(e.target.value) !== c.port && put({ port: Number(e.target.value) })} /></Row>
            <Row t="파일 포트" s="파일·클립보드·동기화 채널 (암호화 · 페어링한 기기만)"><input className="inp mono" key={c.filePort} defaultValue={c.filePort} style={{ width: 90, textAlign: 'center' }} aria-label="파일 포트" onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} onBlur={(e) => Number(e.target.value) > 0 && Number(e.target.value) !== c.filePort && put({ filePort: Number(e.target.value) })} /></Row>
          </div></Grp>
          <Grp h="Deskflow를 쓰고 있다면"><div className="card">
            <Row t="Deskflow 설정 가져오기" s="이름·배치·인증서만 읽어 와요 (읽기 전용) — Hera는 Deskflow를 켜거나 끄거나 바꾸지 않아요">
              <button className="btn ghost sm" data-import onClick={() => void b.onImport().then(() => say('Deskflow 설정을 읽어 왔어요 (이름·배치·인증서)'), (e) => say(String(e)))}><Ico k="download" />가져오기</button>
            </Row>
            <Row t="Deskflow가 실행 중이면" s="Hera의 마우스·키보드 공유는 쉬고 기다려요 · 파일·클립보드는 그대로" lead={<Ico k="info" className="ico lead" />}><span className="chip">자동 대기</span></Row>
          </div></Grp>
        </>
      )}
    </>
  )
}

/* ── 채팅 ── */
function ChatPane() {
  const [days, setDays] = useValue('chat.retentionDays', 30)
  const [mb, setMb] = useValue('chat.maxMB', 100)
  return (
    <>
      <Head k="chat" sub="사내망 동료와 직접 주고받는 채팅 · 팀과 같은 종단간 암호화" />
      <Grp h="보관"><div className="card">
        <Row t="이 PC에 보관" s="지난 메시지는 이 PC에서만 지워요 (다른 사람 기록은 그대로)"><Sel value={days} set={setDays} label="보관 기간" opts={[[7, '7일'], [30, '30일 (기본)'], [90, '90일'], [365, '1년']]} /></Row>
        <Row t="파일·사진 최대" s="보낸 사람 PC에서 직접 받아요 — 보낸 사람이 꺼져 있으면 켜질 때까지 대기"><Sel value={mb} set={setMb} label="파일 크기 상한" opts={[[25, '25MB'], [100, '100MB (기본)'], [500, '500MB']]} /></Row>
        <Row t="받은 파일 저장 위치" s={<span className="mono">다운로드\Hera</span>} soon />
      </div></Grp>
      <Grp h="알림"><div className="card">
        <Row t="메시지 미리보기" s="캡슐 알림에 내용 앞부분 보여 주기 · 지금은 항상 켜져 있어요" soon />
        <Row t="소리" s="기본 꺼짐 (조용한 사무실용)" soon />
      </div></Grp>
      <Grp h="팀 그룹" cls="team"><div className="card settings teamcard"><TeamSection /></div></Grp>
    </>
  )
}

/* ── 터미널 · 아라 ── */
function TermPane() {
  const [araCmd, setAraCmd] = useValue('term.araCmd', false)
  return (
    <>
      <Head k="term" sub="Ctrl+` 드롭다운 터미널과 아라(AI CLI) 이어 하기" />
      <Grp h="터미널"><div className="card">
        <Row t="셸" s="새 탭에서 열 셸 · 지금은 PowerShell" soon />
        <Row t="시작 폴더" s="새 탭이 열리는 폴더" soon />
        <Row t="글자 크기" s="Cascadia Mono" soon />
      </div></Grp>
      <Grp h="아라"><div className="card">
        <Row t="아라에서 이어서 하기" s="터미널 머리줄의 '아라' 단추 = 같은 폴더에 새 아라 탭"><span className="chip">머리줄 단추</span></Row>
        <Row t="마지막 명령도 넘기기" s="아라 탭에서 마지막 명령을 다시 실행해요 (기본 꺼짐)"><Sw on={araCmd} set={setAraCmd} label="명령도 넘기기" /></Row>
      </div></Grp>
      <Grp h="AI 연결 (MCP)"><div className="card settings mcpcard"><McpSettings /></div></Grp>
    </>
  )
}

/* ── 단축키 ── */
function KeysPane() {
  const [term] = useValue('term.hotkey', 'Ctrl+Backquote')
  const K: [string, string, string][] = [[term, '터미널 드롭다운', 'Ctrl+` 기본'], ['Ctrl+Alt+T', '화면 글자 복사 (OCR)', '영역을 끌어서 글자만']]
  return (
    <>
      <Head k="keys" sub="전역 단축키 · 바꾸기는 준비 중이에요" />
      <Grp><div className="card">
        {K.map(([combo, t, s]) => <Row key={t} t={t} s={s}><span className="keycap"><Keys combo={combo} /></span></Row>)}
        <Row t="허브 열기" s="정하지 않음 — 캡슐을 눌러도 열려요" soon />
      </div></Grp>
      <Grp h="허브 안에서"><div className="card">
        <Row t="접기" s="허브·화면을 캡슐로"><span className="keycap" style={{ minWidth: 0 }}><kbd>Esc</kbd></span></Row>
        <Row t="뒤로" s="화면 → 허브"><span className="keycap" style={{ minWidth: 0 }}><kbd>‹</kbd></span></Row>
        <Row t="LP 재생 / 정지" s="LP 화면에서"><span className="keycap" style={{ minWidth: 0 }}><kbd>Space</kbd></span></Row>
      </div></Grp>
    </>
  )
}

/* ── 정보 ── */
function About() {
  const [v, setV] = useState('0.1.0')
  useEffect(() => void (isTauri && getVersion().then(setV, () => {})), [])
  return (
    <>
      <Head k="about" sub="버전 · 라이선스 · 개인정보" />
      <div className="about"><span className="logo"><i /></span><div><b>Hera</b><small>{v} (island-only)</small></div><span className="spacer" /></div>
      <Grp><div className="card">
        <Row t="업데이트 확인" s="자동 업데이트는 아직 없어요" soon />
        <Row t="오픈 소스 라이선스" s="Pretendard (OFL 1.1) · 내장 입력 엔진 deskflow-core (GPL-2.0) · Tauri (MIT/Apache-2.0) · 펫 그림은 모두 직접 그린 것" />
        <Row t="개인정보" s="메모·채팅·펫 이미지는 이 PC와 내 기기 사이에서만 오가요. 서버로 보내지도, 사용 기록을 모으지도 않아요"><span className="chip ok"><i />로컬 전용</span></Row>
      </div></Grp>
    </>
  )
}
