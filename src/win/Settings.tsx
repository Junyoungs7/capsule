import { useEffect, useState, type ReactNode } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { appDataDir } from '@tauri-apps/api/path'
import { autostart, isTauri, onEvent, openFx, openPath, useValue, type LinkCfg } from '../data/api'
import { KeyRows, MAC_LABEL, MonitorCanvas, PRESETS, WIN_LABEL, mapped } from '../surfaces/LinkExtras'
import { Pet, PETS, STYLES, petScale, type PetStyle } from '../surfaces/Pet'
import { pickFx, type Weather } from '../surfaces/Fx'
import { Ico, type IcoKey } from './icons'
import { LINK_DEFAULT, linkLook, useLink, useShare, type Link } from './link'

/* 설정 창 (보통 Windows 창, 처음 열 때 만들고 닫으면 파괴). 섹션 4개 — 모든 항목은 진짜 store 키·Rust 명령에 이어져 있다 (docs/spec.md). */
type Sec = 'general' | 'link' | 'deco' | 'about'
const SECS: [Sec, string, IcoKey][] = [['general', '일반', 'home'], ['link', '연결', 'link'], ['deco', '꾸미기', 'spark'], ['about', '정보', 'info']]
type LinkTab = 'devices' | 'layout' | 'keyboard' | 'adv'
const LTABS: [LinkTab, string][] = [['devices', '기기'], ['layout', '화면 배치'], ['keyboard', '키보드'], ['adv', '고급']]
export const parseSec = (s: string | null): [Sec, LinkTab] => {
  const [a, b] = (s ?? 'general').split(':')
  return [(SECS.some(([k]) => k === a) ? a : 'general') as Sec, (LTABS.some(([k]) => k === b) ? b : 'devices') as LinkTab]
}

const Row = ({ t, s, children }: { t: ReactNode; s?: ReactNode; children?: ReactNode }) => (
  <div className="row"><span className="tt"><b>{t}</b>{s && <small>{s}</small>}</span>{children}</div>
)
export const Sw = ({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) => (
  <button className="sw" role="switch" aria-checked={on} aria-label={label} onClick={() => set(!on)} />
)
function Step({ value, set, max, unit, label }: { value: number; set: (v: number) => void; max: number; unit: string; label: string }) {
  return (
    <span className="step" role="group" aria-label={label}>
      <button className="ib" onClick={() => set(Math.max(0, value - 1))} aria-label="줄이기"><Ico k="minus" /></button>
      <b data-v={value}>{value === 0 ? '끔' : value + unit}</b>
      <button className="ib" onClick={() => set(Math.min(max, value + 1))} aria-label="늘리기"><Ico k="plus" /></button>
    </span>
  )
}

export function SettingsWin({ sec: sec0 }: { sec: string | null }) {
  const [[sec, ltab], setNav] = useState(() => parseSec(sec0))
  const [msg, setMsg] = useState<{ t: string; n: number } | null>(null)
  const say = (t: string) => setMsg((x) => ({ t, n: (x?.n ?? 0) + 1 }))
  useEffect(() => {
    if (!msg) return
    const h = setTimeout(() => setMsg(null), 2000)
    return () => clearTimeout(h)
  }, [msg?.n])
  // 이미 열린 창에 다른 섹션 요청 (패널 '설정' 등)
  useEffect(() => (isTauri ? onEvent<string>('settings-sec', (s) => setNav(parseSec(s))) : undefined), [])
  const link = useLink()
  const look = linkLook(link)
  return (
    <div className="set">
      <nav aria-label="설정 섹션">
        {SECS.map(([k, l, ic]) => (
          <button key={k} data-sec={k} aria-current={sec === k ? 'page' : 'false'} onClick={() => setNav([k, ltab])}>
            <Ico k={ic} />{l}{k === 'link' && <i className="dot" data-st={look.st} />}
          </button>
        ))}
      </nav>
      <main data-pane={sec}>
        {sec === 'general' && <General say={say} />}
        {sec === 'link' && <LinkPane b={link} tab={ltab} setTab={(t) => setNav(['link', t])} say={say} />}
        {sec === 'deco' && <Deco say={say} />}
        {sec === 'about' && <About />}
      </main>
      {msg && <div key={msg.n} className="say" role="status">{msg.t}</div>}
    </div>
  )
}

/* ── 일반 ── */
function General({ say }: { say: (t: string) => void }) {
  const [auto, setAuto] = useState(false)
  useEffect(() => void (isTauri && autostart().then(setAuto, () => {})), [])
  const [getShare, setShare] = useShare()
  const [ripple, setRipple] = useValue('ripple.enabled', true)
  const [locator, setLocator] = useValue('locator.enabled', true)
  const [people, setPeople] = useValue('people.enabled', true)
  const [name, setName] = useValue('people.name', '')
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])
  const folder = () => void appDataDir().then((d) => openPath(d)).then(() => say('탐색기에서 열었어요'), (e) => say(String(e)))
  return (
    <>
      <h1>일반</h1>
      <Row t="Windows 시작 시 Hera 실행" s="로그인하면 알림 영역에 조용히 시작해요"><Sw on={auto} label="Windows 시작 시 실행" set={(v) => (isTauri ? void autostart(v).then(setAuto) : setAuto(v))} /></Row>
      <h2>기능</h2>
      <Row t="클립보드 공유" s="맥과 복사·붙여넣기를 함께 써요 (텍스트)"><Sw on={getShare('clip')} set={(v) => setShare('clip', v)} label="클립보드 공유" /></Row>
      <Row t="넘어갈 때 물결" s="마우스가 맥으로 넘어가고 돌아올 때 화면 끝에 물결"><Sw on={ripple} set={setRipple} label="넘어갈 때 물결" /></Row>
      <Row t="흔들어 커서 찾기" s="마우스를 좌우로 빠르게 흔들면 커서 둘레에 물결"><Sw on={locator} set={setLocator} label="흔들어 커서 찾기" /></Row>
      <h2>사람에게 보내기</h2>
      <Row t="같은 네트워크의 Hera와 파일 주고받기" s="등록한 사람끼리만 주고받아요 · 끄면 근처 사람 목록에 내 이름이 보이지 않아요"><Sw on={people} set={setPeople} label="사람에게 보내기" /></Row>
      <Row t="내 이름" s="다른 사람 Hera에 보이는 이름 · 비워 두면 Windows 사용자 이름">
        <input className="inp" data-people-name value={draft} placeholder="Windows 사용자 이름" maxLength={40} style={{ width: 160 }} aria-label="내 이름"
          onChange={(e) => setDraft(e.target.value)} onBlur={() => draft.trim() !== name && setName(draft.trim())} onKeyDown={(e) => e.key === 'Enter' && draft.trim() !== name && setName(draft.trim())} />
      </Row>
      <h2>데이터</h2>
      <Row t="설정 폴더" s={<span className="mono">%APPDATA%\dev.hera.dock</span>}><button className="btn" onClick={folder} disabled={!isTauri}><Ico k="folder" />열기</button></Row>
    </>
  )
}

/* ── 연결 ── */
function LinkPane({ b, tab, setTab, say }: { b: Link; tab: LinkTab; setTab: (t: LinkTab) => void; say: (t: string) => void }) {
  const c: LinkCfg = { ...LINK_DEFAULT, ...b.cfg }
  const put = (patch: Partial<LinkCfg>) => b.setCfg({ ...c, ...patch })
  const look = linkLook(b)
  const m = mapped(c)
  const field = (key: 'me' | 'peer' | 'port' | 'filePort', label: string, width: number, num = false) => (
    <input className={`inp ${num ? 'mono' : ''}`} key={String(c[key])} defaultValue={c[key]} style={{ width }} aria-label={label}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      onBlur={(e) => {
        const v = e.target.value.trim()
        if (!v || v === String(c[key])) return
        if (num) Number(v) > 0 && put({ [key]: Number(v) })
        else put({ [key]: v })
      }} />
  )
  const paired = b.pairedName || (b.status?.state === 'connected' ? look.peer : null)
  return (
    <>
      <h1>연결</h1>
      <Row t={look.title} s={look.sub}><Sw on={b.on} set={b.setOn} label="연결" /></Row>
      {b.pair && (
        <div className="pair" data-code={b.pair.code}>
          <span className="code">{b.pair.code.slice(0, 3)} {b.pair.code.slice(3)}<small>{b.pair.name} 화면에도 같은 숫자가 떠 있나요?</small></span>
          <button className="btn" data-pair="no" onClick={() => b.onPair(false)}>아니요</button>
          <button className="btn pri" data-pair="ok" onClick={() => b.onPair(true)}>같아요</button>
        </div>
      )}
      {b.status?.fingerprint && (
        <Row t="처음 보는 맥이에요" s={<span className="mono">{b.status.fingerprint.match(/.{1,4}/g)?.slice(0, 8).join(' ')}…</span>}>
          <button className="btn pri" onClick={() => void b.onTrust(b.status!.fingerprint).catch((e) => say(String(e)))}>신뢰</button>
        </Row>
      )}
      <div className="tabs" role="tablist">
        {LTABS.map(([k, l]) => <button key={k} role="tab" data-ltab={k} aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'devices' && (
        <>
          <Row t="이 PC 이름" s={`맥 Hera에 이 이름으로 보여요 · 포트 ${c.port}`}>{field('me', '이 PC 이름', 160)}</Row>
          {paired
            ? <Row t={paired} s={b.filesPeer ? '파일 주고받기 준비됨' : '입력 공유 중'}><button className="btn danger" data-unpair onClick={() => (b.onUnpair(), say('페어링을 해제했어요'))}>페어링 해제</button></Row>
            : <Row t="페어링한 맥이 없어요" s="맥 Hera에서 이 PC를 고르면 위에 6자리 숫자가 떠요" />}
        </>
      )}
      {tab === 'layout' && (
        <>
          <MonitorCanvas connected={!!b.filesPeer} />
          <Row t="가장자리 두 번 치기" s="실수로 넘어가지 않게 — 두 번 밀어야 넘어가요"><Sw on={c.doubleTap} set={(v) => put({ doubleTap: v })} label="두 번 치기" /></Row>
        </>
      )}
      {tab === 'keyboard' && (
        <>
          <h2>{look.peer}에서 쓸 때 수식키</h2>
          <div className="presets" role="radiogroup">
            {PRESETS.map(([k, t, s]) => <button key={k} role="radio" aria-checked={c.keymap === k} data-keymap={k} onClick={() => put({ keymap: k })}><b>{t}</b><small>{s}</small></button>)}
          </div>
          <div className="kbrow">
            {(['ctrl', 'super', 'alt', 'space', 'altgr', 'ctrl'] as const).map((k, i) => k === 'space'
              ? <span key={i} className="wide"><small>Space</small></span>
              : <span key={i} className={m[k] !== k ? 'chg' : ''}><b>{WIN_LABEL[k]}</b><small>{MAC_LABEL[m[k]]}</small></span>)}
          </div>
          {c.keymap === 'custom' && <KeyRows c={c} put={put} />}
          <Row t="한/영 (맥에 커서가 있을 때)" s={c.ime === 'hera' ? '맥 Hera가 입력 소스를 바꿔요 · 맥에 Hera가 없으면 맥의 Ctrl+Space를 보내요' : c.ime === 'off' ? '한/영 키를 맥으로 넘기지 않아요' : '맥 입력 전환 단축키를 보내요'}>
            <select value={c.ime} aria-label="한/영 방식" onChange={(e) => put({ ime: e.target.value })}>
              {[['hera', '맥 Hera'], ['capslock', 'Caps Lock'], ['ctrl-space', '맥 Ctrl+Space'], ['cmd-space', '맥 ⌘+Space'], ['off', '끄기']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Row>
        </>
      )}
      {tab === 'adv' && (
        <>
          <Row t="연결 암호화" s="끄면 같은 네트워크의 누구나 입력을 볼 수 있어요"><Sw on={c.tls} set={(v) => put({ tls: v })} label="연결 암호화" /></Row>
          <Row t="맥 위치" s="이 PC 화면 기준 · 모니터마다 정하려면 화면 배치">
            <select value={c.side} aria-label="맥 위치" onChange={(e) => put({ side: e.target.value as LinkCfg['side'] })}>
              {[['right', '오른쪽'], ['left', '왼쪽'], ['top', '위'], ['bottom', '아래']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Row>
          <Row t="맥 이름" s="맥 Hera에 적힌 이름과 같아야 해요">{field('peer', '맥 이름', 160)}</Row>
          <Row t="입력 포트" s="맥 Hera와 같아야 해요">{field('port', '입력 포트', 90, true)}</Row>
          <Row t="파일 포트" s="파일·제어 채널 (암호화 · 페어링한 맥만)">{field('filePort', '파일 포트', 90, true)}</Row>
          <Row t="Deskflow 설정 가져오기" s="이름·배치·인증서만 읽어 와요 — Hera는 Deskflow를 켜거나 끄거나 바꾸지 않아요">
            <button className="btn" data-import onClick={() => void b.onImport().then(() => say('Deskflow 설정을 읽어 왔어요'), (e) => say(String(e)))}><Ico k="down" />가져오기</button>
          </Row>
        </>
      )}
    </>
  )
}

/* ── 꾸미기 ── */
function Deco({ say }: { say: (t: string) => void }) {
  const [on, setOn] = useValue('deco.enabled', false)
  const [pet, setPet] = useValue('pet.kind', 'cat')
  const [city, setCity] = useValue('fx.city', '서울')
  const [weather] = useValue<Weather | null>('fx.weather', null)
  const [idle, setIdle] = useValue('ascii.idleMin', 10)
  const [draft, setDraft] = useState(city)
  useEffect(() => setDraft(city), [city])
  const save = () => draft.trim() && draft.trim() !== city && setCity(draft.trim())
  const [tab, setTab] = useState<PetStyle>(PETS[pet]?.style ?? 'flat')
  const [ver] = useValue<number>('pet.img', 0)
  const [mine, setMine] = useState<string | null>(null)
  useEffect(() => void (isTauri && invoke<string | null>('pet_image').then(setMine, () => {})), [ver])
  const pick = (f: File | undefined) => {
    if (!f) return
    const r = new FileReader()
    r.onload = () => void invoke('pet_set_image', { name: f.name, data: String(r.result).split(',')[1] ?? '' }).then(() => say('펫을 내 이미지로 바꿨어요'), (e) => say(String(e)))
    r.readAsDataURL(f)
  }
  return (
    <>
      <h1>꾸미기</h1>
      <h2>펫</h2>
      <p className="note-line">펫은 항상 화면에 있어요 — 누르면 패널, 오른쪽 클릭은 펫 메뉴, 끌어서 어디든 옮겨요. 파일을 펫에 대면 보낼 곳이 둥글게 펼쳐져요.</p>
      <Row t="내 이미지" s="PNG · GIF(움직이는 것도) · WebP · JPG, 8MB까지 — 펫 대신 보여요">
        {mine && <button className="pet-mine" role="radio" aria-checked={pet === 'custom'} aria-label="내 이미지 쓰기" data-pet-mine onClick={() => setPet('custom')}><img src={mine} alt="" /></button>}
        <label className="btn" data-pet-pick><Ico k="down" />이미지 고르기<input type="file" accept="image/png,image/gif,image/webp,image/jpeg" hidden onChange={(e) => (pick(e.target.files?.[0]), (e.target.value = ''))} /></label>
      </Row>
      <Row t="자리" s="기본 자리는 오른쪽 아래(작업 표시줄 위)예요"><button className="btn" data-pet-home onClick={() => (isTauri && void invoke('pet_home'), say('펫을 오른쪽 아래로 옮겼어요'))}>제자리로</button></Row>
      <div className="tabs" role="tablist">
        {(Object.keys(STYLES) as PetStyle[]).map((k) => <button key={k} role="tab" data-pettab={k} aria-selected={tab === k} onClick={() => setTab(k)}>{STYLES[k]}</button>)}
      </div>
      <div className="pets" role="radiogroup" aria-label="펫">
        {Object.entries(PETS).filter(([, x]) => x.style === tab).map(([k, x]) => (
          <button key={k} role="radio" aria-checked={pet === k} data-pet-set={k} onClick={() => setPet(k)}>
            <span className="pbx" style={{ '--pk': petScale(x.style, 1) } as React.CSSProperties}><Pet kind={k} state="idle" /></span>{x.name}
          </button>
        ))}
      </div>
      <h2>날씨·계절 효과 · 자리 비움 화면</h2>
      <Row t="꾸미기" s="날씨·계절 효과 · 자리 비움 화면 — 한 번에 켜고 꺼요"><Sw on={on} set={setOn} label="꾸미기" /></Row>
      {!on && <p className="note-line">꺼져 있어요 — 켜면 아래 설정대로 움직여요.</p>}
      <Row t="도시" s={`${city} · ${weather ? `${weather.text} ${weather.temp}°` : '날씨 정보 없음'} · 눈·비가 오기 시작할 때, 노을, 달이 뜰 때 잠깐 보여요`}>
        <input className="inp" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && save()} style={{ width: 140 }} aria-label="도시" />
      </Row>
      <Row t="지금 한 번 보기" s="지금 날씨·시간대에 맞는 효과를 띄워요"><button className="btn" onClick={() => (void openFx(pickFx(new Date(), weather)), say('바탕화면에 효과를 띄웠어요'))}><Ico k="play" />보기</button></Row>
      <Row t="대기 시간" s="입력이 없으면 모든 모니터를 그림으로 가려요 · 마우스를 움직이면 사라져요"><Step value={idle} set={setIdle} max={120} unit="분" label="대기 시간" /></Row>
    </>
  )
}

/* ── 정보 ── */
function About() {
  const [v, setV] = useState('0.1.0')
  useEffect(() => void (isTauri && getVersion().then(setV, () => {})), [])
  return (
    <>
      <h1>정보</h1>
      <Row t={`Hera ${v}`} s="Windows와 맥을 하나처럼 — 연결 · 클립보드 · 파일 · 메모" />
      <Row t="오픈 소스 라이선스" s="내장 입력 엔진 deskflow-core (GPL-2.0) · Tauri (MIT/Apache-2.0) · 펫 그림은 모두 직접 그린 것" />
      <Row t="개인정보" s="메모·파일은 이 PC와 내 맥 사이에서만 오가요. 서버로 보내거나 사용 기록을 모으지 않아요" />
    </>
  )
}
