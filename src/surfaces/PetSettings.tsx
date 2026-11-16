import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { isTauri, petDelete, petExport, petImport, petList, petSave } from '../data/api'
import { Ico } from './Icons'
import { Pet, PETS, petScale, PET_STATES, SIZES_CAP, STYLES, type CapSize, type CustomPet, type PetState, type PetStyle } from './Pet'

/* 설정 (아일랜드 안 화면) = 내 펫 · 크기 · 위치 · 동작, 그리고 '펫 추가' 편집기 (pets/CUSTOM-PETS.md).
   이미지는 이 PC 에만: 실제 앱 = Rust 가 %APPDATA%\Hera\pets 에 검사해서 저장, 시안 = 이 페이지 메모리. */

/* ── 내 펫 목록 (모듈 하나 — 저장·삭제 뒤 다시 읽는다) ── */
let customs: CustomPet[] = []
const subs = new Set<() => void>()
const toCustom = (p: Awaited<ReturnType<typeof petList>>[number]): CustomPet => ({
  id: p.id, name: p.name, style: p.style, sheet: p.sheet,
  files: Object.fromEntries(Object.entries(p.files).map(([k, f]) => [k, { url: `${convertFileSrc(f.path)}?v=${f.v}`, w: f.w, h: f.h }])),
})
export const refreshPets = async () => {
  if (isTauri) customs = (await petList().catch(() => [])).map(toCustom)
  subs.forEach((f) => f())
}
export const useCustomPets = () => {
  useEffect(() => void refreshPets(), [])
  return useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => customs)
}
export const customOf = (key: string, list: CustomPet[]) => (key.startsWith('custom:') ? list.find((c) => `custom:${c.id}` === key) ?? null : null)

export type IslandPrefs = { pet: string; size: CapSize; place: 'br' | 'bl'; autohide: boolean; alerts: boolean }

function Mini({ k, c }: { k: string; c?: CustomPet }) {
  return <span className="mini"><Pet kind={k} custom={c} state="idle" pk={c ? 1 : petScale(PETS[k]?.style ?? 'flat', 's')} /></span>
}

export function SettingsView({ prefs, set, onImport, onEdit, onToast, onPanel }: {
  prefs: IslandPrefs
  set: <K extends keyof IslandPrefs>(k: K, v: IslandPrefs[K]) => void
  onImport: () => void
  onEdit: (c: CustomPet) => void
  onToast: (msg: string) => void
  onPanel: () => void
}) {
  const list = useCustomPets()
  const cur = customOf(prefs.pet, list)
  const [tab, setTab] = useState<PetStyle | 'custom'>(cur ? 'custom' : PETS[prefs.pet]?.style ?? 'flat')
  const zip = () => pick('.zip,application/zip', false, false, async (fs) => {
    try {
      const id = await petImport(fs[0])
      await refreshPets()
      set('pet', `custom:${id}`)
      onToast('펫을 가져왔어요')
    } catch (e) {
      onToast(`가져오지 못했어요 · ${e}`)
    }
  })
  return (
    <>
      <div className="sect">내 펫 · 캡슐에 사는 친구 ({Object.keys(PETS).length}종)</div>
      <div className="pettabs">
        {(Object.keys(STYLES) as (PetStyle | 'custom')[]).map((k) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{STYLES[k]}</button>
        ))}
      </div>
      {tab !== 'custom' ? (
        <div className="petpick">
          {Object.entries(PETS).filter(([, p]) => p.style === tab).map(([k, p]) => (
            <button key={k} className={prefs.pet === k ? 'on' : ''} data-pet-set={k} onClick={() => set('pet', k)}><Mini k={k} /><small>{p.name}</small></button>
          ))}
        </div>
      ) : (
        <div className="petpick">
          {list.map((c) => (
            <div key={c.id} className="ctile">
              <button className={prefs.pet === `custom:${c.id}` ? 'on' : ''} data-pet-set={`custom:${c.id}`} onClick={() => set('pet', `custom:${c.id}`)}><Mini k={c.id} c={c} /><small>{c.name}</small></button>
              <span className="cact">
                <button onClick={() => onEdit(c)} aria-label={`${c.name} 편집·이름 바꾸기`} title="편집·이름 바꾸기">✎</button>
                <button onClick={() => void petExport(c.id).then((p) => onToast(`내보냈어요 · ${p}`), (e) => onToast(String(e)))} aria-label={`${c.name} 내보내기`} title=".herapet.zip 으로 내보내기">⇩</button>
                <button data-cpet-del={c.id} onClick={() => void (isTauri ? petDelete(c.id) : Promise.resolve((customs = customs.filter((x) => x.id !== c.id)))).then(() => (prefs.pet === `custom:${c.id}` && set('pet', 'cat'), refreshPets()))} aria-label={`${c.name} 삭제`} title="삭제">✕</button>
              </span>
            </div>
          ))}
          <button className="cadd" data-cpet="add" onClick={onImport}><Ico k="plus" /><small>펫 추가</small></button>
          <button className="cadd" onClick={zip} title=".herapet.zip 가져오기"><Ico k="upload" /><small>zip 가져오기</small></button>
        </div>
      )}
      <div className="sect" style={{ marginTop: 8 }}>크기 · 캡슐과 펫만 (허브·화면은 그대로)</div>
      <div className="seg">
        {(Object.keys(SIZES_CAP) as CapSize[]).map((k) => (
          <button key={k} className={prefs.size === k ? 'on' : ''} data-size-set={k} onClick={() => set('size', k)}>{SIZES_CAP[k][0]}</button>
        ))}
      </div>
      <div className="sect" style={{ marginTop: 8 }}>위치</div>
      <div className="seg">
        {([['br', '오른쪽 아래'], ['bl', '왼쪽 아래']] as const).map(([k, l]) => (
          <button key={k} className={prefs.place === k ? 'on' : ''} data-place-set={k} onClick={() => set('place', k)}>{l}</button>
        ))}
      </div>
      <div className="sect" style={{ marginTop: 8 }}>동작</div>
      {([['autohide', '전체화면 앱에서 자동으로 숨기기', '게임·발표·영상 전체화면일 때'], ['alerts', '펫이 알림 알려 주기', '일정·채팅·터미널·선반']] as const).map(([k, t, s]) => (
        <div key={k} className="row" style={{ padding: '0 4px' }}>
          <span className="tt"><b>{t}</b><small>{s}</small></span>
          <button className={`sw ${prefs[k] ? 'on' : ''}`} aria-label={t} aria-pressed={prefs[k]} onClick={() => set(k, !prefs[k])} />
        </div>
      ))}
      <div className="foot"><small>Ctrl+Alt+K 검색 · Ctrl+` 터미널</small><button className="btn ghost" onClick={onPanel}>전체 설정</button></div>
    </>
  )
}

/* ── 펫 추가 · 편집 ── */
type Draft = { id?: string; name: string; mode: 'auto' | 'pixel' | 'smooth'; detected: 'pixel' | 'smooth'; sheetOn: boolean; frames: number; fps: number; files: Partial<Record<PetState, { blob: Blob; url: string; w: number; h: number; img?: HTMLImageElement }>>; prev: PetState }
export const newDraft = (): Draft => ({ name: '', mode: 'auto', detected: 'smooth', sheetOn: false, frames: 4, fps: 8, files: {}, prev: 'idle' })
export async function draftOf(c: CustomPet): Promise<Draft> {
  const files: Draft['files'] = {}
  for (const [k, f] of Object.entries(c.files)) {
    const blob = await fetch(f!.url).then((r) => r.blob())
    files[k as PetState] = { blob, url: URL.createObjectURL(blob), w: f!.w, h: f!.h }
  }
  return { ...newDraft(), id: c.id, name: c.name, mode: c.style, detected: c.style, sheetOn: !!c.sheet, frames: c.sheet?.frames ?? 4, fps: c.sheet?.fps ?? 8, files }
}

async function readImage(blob: Blob) {
  const url = URL.createObjectURL(blob)
  const img = new Image()
  img.src = url
  try {
    await img.decode()
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
  return { blob, url, w: img.naturalWidth, h: img.naturalHeight, img }
}
/** 픽셀 아트 추정: 한 변 ≤ 96px, 또는 불투명 색 ≤ 48 · 반투명 < 1% */
export function looksPixel(f: { w: number; h: number; img?: HTMLImageElement }) {
  if (f.w <= 96 || f.h <= 96) return true
  try {
    const W = Math.min(f.w, 128), H = Math.round(f.h * (W / f.w)), cv = document.createElement('canvas')
    cv.width = W
    cv.height = H
    const g = cv.getContext('2d', { willReadFrequently: true })!
    g.imageSmoothingEnabled = false
    g.drawImage(f.img!, 0, 0, W, H)
    const d = g.getImageData(0, 0, W, H).data, cols = new Set<number>()
    let soft = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0 && d[i + 3] < 255) soft++
      else if (d[i + 3]) cols.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2])
    }
    return cols.size <= 48 && soft < W * H * 0.01
  } catch {
    return false
  }
}
const STATE_KEYS = PET_STATES.map(([k]) => k)
export const stateOfName = (name: string) => STATE_KEYS.find((k) => new RegExp(`(^|[\\\\/_-])${k}\\.`, 'i').test(name))

function pick(accept: string, multiple: boolean, folder: boolean, cb: (fs: File[]) => void) {
  const inp = document.createElement('input')
  inp.type = 'file'
  inp.accept = accept
  inp.multiple = multiple
  if (folder) inp.webkitdirectory = true
  inp.onchange = () => inp.files?.length && cb([...inp.files])
  inp.click()
}

/** 파일 → 초안: `<상태>.<확장자>` (또는 `…_<상태>`) 는 그 칸, 아니면 평소. pet.json 은 이름·스타일·시트를 미리 채운다 */
export async function addFiles(d: Draft, list: File[], slot?: PetState): Promise<Draft> {
  d = { ...d, files: { ...d.files } }
  const json = list.find((f) => /pet\.json$/i.test(f.name))
  if (json)
    try {
      const m = JSON.parse(await json.text())
      d.name ||= String(m.name ?? '').slice(0, 12)
      if (m.style) d.mode = m.style === 'pixel' ? 'pixel' : 'smooth'
      if (m.sheet) Object.assign(d, { sheetOn: true, frames: +m.sheet.frames || 4, fps: +m.sheet.fps || 8 })
    } catch {
      /* 깨진 pet.json 은 무시 — 이미지는 그대로 받는다 */
    }
  for (const file of list.filter((f) => /^image\/(png|gif|webp|apng)$/.test(f.type) || /\.(png|gif|webp|apng)$/i.test(f.name))) {
    const st = slot ?? stateOfName(file.webkitRelativePath || file.name) ?? (!d.files.idle ? 'idle' : undefined)
    if (!st) continue
    const f = await readImage(file)
    if (!f) continue
    if (d.files[st]) URL.revokeObjectURL(d.files[st]!.url)
    d.files[st] = f
    if (st === 'idle' || Object.keys(d.files).length === 1) d.detected = looksPixel(f) ? 'pixel' : 'smooth'
    if (!d.name && !slot) d.name = (file.name.replace(/\.[^.]+$/, '').replace(/[_-](idle|sleep|chat|event|typing|done|fail|shelf)$/i, '') || '새 펫').slice(0, 12)
  }
  return d
}
export const draftPet = (d: Draft): CustomPet | null => {
  const files = { ...d.files }
  if (!files.idle) files.idle = Object.values(files)[0]
  if (!files.idle) return null
  return { id: d.id ?? '__draft', name: d.name || '새 펫', style: d.mode === 'auto' ? d.detected : d.mode, sheet: d.sheetOn ? { frames: Math.max(1, Math.min(64, d.frames | 0)), fps: Math.max(1, Math.min(30, d.fps | 0)) } : null, files }
}

export function PetImportView({ draft, setDraft, size, onSaved, onCancel }: { draft: Draft; setDraft: (d: Draft) => void; size: CapSize; onSaved: (id: string) => void; onCancel: () => void }) {
  const c = draftPet(draft)
  const [err, setErr] = useState('')
  const K = SIZES_CAP[size][1]
  const [cw, ch] = [80 * (K / 1.25), 60 * (K / 1.25)]
  const add = (slot?: PetState, folder = false) =>
    pick('image/png,image/gif,image/webp,image/apng,.png,.gif,.webp,.apng,.json', !slot, folder, (fs) => void addFiles(draft, fs, slot).then(setDraft))
  const save = async () => {
    if (!c) return
    setErr('')
    try {
      const style = c.style
      const files = (Object.entries(draft.files) as [PetState, { blob: Blob }][]).map(([k, f]) => [k, f.blob] as [string, Blob])
      if (!draft.files.idle) files.unshift(['idle', files[0][1]]) // 평소 칸이 비면 첫 이미지가 평소
      const id = isTauri ? await petSave({ id: draft.id, name: c.name, style, sheet: c.sheet }, files) : draft.id ?? Math.random().toString(36).slice(2, 10)
      if (!isTauri) customs = [...customs.filter((x) => x.id !== id), { ...c, id }]
      await refreshPets()
      onSaved(id)
    } catch (e) {
      setErr(String(e))
    }
  }
  return (
    <>
      <div className="imp-prev">
        <div className="capd" style={{ width: cw, height: ch, borderRadius: ch / 2 }}>
          {c ? <div className="petbox" style={{ '--pk': c.style === 'pixel' ? 1 : K } as CSSProperties}><Pet kind="__draft" custom={c} state={draft.prev} pk={c.style === 'pixel' ? 1 : K} /></div> : <span className="imp-empty">이미지를 고르면<br />여기서 미리 봐요</span>}
        </div>
        <div className="imp-states">
          {PET_STATES.map(([k, l]) => (
            <button key={k} className={draft.prev === k ? 'on' : ''} onClick={() => setDraft({ ...draft, prev: k })}>{l}</button>
          ))}
        </div>
      </div>
      <div className="imp-pick">
        <button className="btn" data-imp="pick" onClick={() => add()}><Ico k="image" />이미지</button>
        <button className="btn ghost" data-imp="folder" onClick={() => add(undefined, true)}><Ico k="shelf" />폴더</button>
      </div>
      <div className="field"><input value={draft.name} maxLength={12} placeholder="이름 (최대 12자)" aria-label="이름" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
      <div className="seg">
        {([['auto', `자동${draft.files.idle ? ` (${draft.detected === 'pixel' ? '픽셀' : '부드럽게'})` : ''}`], ['pixel', '픽셀 (정수 배율)'], ['smooth', '부드럽게']] as const).map(([k, l]) => (
          <button key={k} className={draft.mode === k ? 'on' : ''} onClick={() => setDraft({ ...draft, mode: k })}>{l}</button>
        ))}
      </div>
      <div className="sect">상태별 이미지 (선택 · 비면 평소 이미지 + 효과)</div>
      <div className={`slots ${c?.style === 'pixel' ? 'px' : ''}`}>
        {PET_STATES.map(([k, l]) => {
          const f = draft.files[k]
          return (
            <button key={k} className={`slot ${f ? 'has' : ''}`} data-slot={k} onClick={() => add(k)} title={`${l} 이미지`}>
              {f ? <img src={f.url} alt="" /> : <i>{k === 'idle' ? '필수' : '평소 + 효과'}</i>}
              <small>{l}</small>
            </button>
          )
        })}
      </div>
      <label className="imp-sheet">
        <button className={`sw ${draft.sheetOn ? 'on' : ''}`} aria-label="스프라이트 시트" onClick={(e) => (e.preventDefault(), setDraft({ ...draft, sheetOn: !draft.sheetOn }))} />
        <span>스프라이트 시트 (가로로 이어 붙인 프레임)</span>
        <input type="number" min={1} max={64} value={draft.frames} disabled={!draft.sheetOn} aria-label="프레임 수" onChange={(e) => setDraft({ ...draft, frames: +e.target.value })} /><small>프레임</small>
        <input type="number" min={1} max={30} value={draft.fps} disabled={!draft.sheetOn} aria-label="fps" onChange={(e) => setDraft({ ...draft, fps: +e.target.value })} /><small>fps</small>
      </label>
      {err && <div className="imp-err" role="alert">{err}</div>}
      <div className="foot">
        <small>이미지는 이 PC 에만 저장돼요 · PNG · GIF · WebP · APNG</small>
        <button className="btn ghost" data-imp="cancel" onClick={onCancel}>취소</button>
        <button className="btn" data-imp="save" disabled={!c} onClick={() => void save()}>저장</button>
      </div>
    </>
  )
}
export type { Draft }
