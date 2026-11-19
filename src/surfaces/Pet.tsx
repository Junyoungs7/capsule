import { memo, type CSSProperties } from 'react'

/* 작업 표시줄 펫 (꾸미기). 기본 19종 · 4 스타일 · 8 상태 — 모두 직접 그린 그림 (pets/LICENSES.md).
   몸 = SVG/글자, 눈·눈썹·소품 = HTML → 모든 움직임이 transform/opacity (합성기만). 상태는 data-s 만 바꾼다. */

export type PetState = 'idle' | 'sleep' | 'chat' | 'event' | 'typing' | 'done' | 'fail' | 'shelf'
export const PET_STATES: [PetState, string][] = [['idle', '평소'], ['sleep', '잠'], ['chat', '채팅'], ['event', '일정'], ['typing', '실행 중'], ['done', '완료'], ['fail', '실패'], ['shelf', '선반']]
export type PetStyle = 'pixel' | 'flat' | 'clay' | 'line'
export const STYLES: Record<PetStyle, string> = { pixel: '픽셀', flat: '플랫', clay: '클레이', line: '라인' }

type Eyes = { ey: string; el: string; er: string; ew: string; eh: string; ec: string; glow?: 1 }
type Builtin = { style: PetStyle; name: string; kind: string; paw?: string; eyes?: Eyes; svg?: string; color?: string; face?: string; top?: string; bottom?: string }

const mir = (s: string) => `${s}<g transform="matrix(-1 0 0 1 40 0)">${s}</g>`
/* 픽셀 아트: 반쪽 8칸 줄을 거울로 16×14, 1칸 = 2.5px */
function pixels(half: string[], pal: Record<string, string>) {
  let out = ''
  half.forEach((row, y) => {
    const full = row + [...row].reverse().join('')
    ;[...full].forEach((ch, x) => {
      if (pal[ch]) out += `<rect x="${x * 2.5}" y="${y * 2.5}" width="2.6" height="2.6" fill="${pal[ch]}"/>`
    })
  })
  return out
}
const PX = (c: number, r: number) => ({ ey: `${r * 2.5}px`, el: `${c * 2.5}px`, er: `${(15 - c) * 2.5}px`, ew: '2.5px', eh: '5px' })

export const PETS: Record<string, Builtin> = {
  /* ── pixel ── */
  pxcat: { style: 'pixel', name: '픽셀냥', kind: '고양이', paw: '#FFE9CF', eyes: { ...PX(4, 6), ec: '#2b1d14' },
    svg: pixels(['..d.....', '.dod....', '.dood...', '.doooddd', 'dooooooo', 'dooooooo', 'dooooooo', 'dooooooo', 'dowwwwwn', 'dpwwwwww', '.dowwwww', '..dooooo', '...ddddd', '........'],
      { d: '#B8692A', o: '#F2A65A', w: '#FFE9CF', p: '#FF9AAA', n: '#E86A7A' }) },
  penguin: { style: 'pixel', name: '펭펭', kind: '펭귄', paw: '#FFB547', eyes: { ...PX(5, 5), ec: '#141a28' },
    svg: pixels(['....dddd', '..ddkkkk', '.dkkkkkk', '.dkkkwww', 'dkkkwwww', 'dkkkwwww', 'dkkkwwww', 'dkkwwwyy', 'dkkwwwww', 'dkkwwwww', 'dkkwwwww', '.dkkwwww', '..ddkkkk', '...yy...'],
      { d: '#141a28', k: '#2f3b5c', w: '#F4F7FF', y: '#FFB547' }) },
  frog: { style: 'pixel', name: '개굴', kind: '개구리', paw: '#7ED957', eyes: { ...PX(3, 3), ec: '#14240f' },
    svg: pixels(['........', '..ddd...', '.dwwwd..', 'dwwwwwdd', 'dwwwwwgg', 'dgwwwggg', 'dggggggg', 'dggggggg', 'dgggbbbb', 'dggbbbbb', 'dggbbbbb', '.dggbbbb', '..dddddd', '.gg.....'],
      { d: '#2F6E22', g: '#7ED957', w: '#FFFFFF', b: '#E9F7C9' }) },
  slime: { style: 'pixel', name: '슬라임', kind: '슬라임', paw: '#5BD6A0', eyes: { ...PX(5, 7), ec: '#0f3324' },
    svg: pixels(['........', '........', '......dd', '....ddgg', '...dgggg', '..dgllgg', '.dglgggg', '.dgggggg', 'dggggggg', 'dggggggg', 'dggggggg', 'dggggggg', '.ddddddd', '........'],
      { d: '#2E9C6C', g: '#5BD6A0', l: '#C8F7E2' }) },
  dragon: { style: 'pixel', name: '미니룡', kind: '드래곤', paw: '#E9E2FF', eyes: { ...PX(5, 5), ec: '#1f1640' },
    svg: pixels(['..y.....', '..yy....', '.dvvd...', 'dvvvvddd', 'dvvvvvvv', 'dvvvvvvv', 'dvvvvvvv', 'dvvvwwww', 'dvvwwwww', '.dvwwwww', '..dvwwww', '..dvvvvv', '...dd...', '........'],
      { d: '#4B3A9A', v: '#8B6CF6', w: '#E9E2FF', y: '#FFD166' }) },

  /* ── flat vector ── */
  cat: { style: 'flat', name: '나비', kind: '고양이', paw: '#FFE9CF', eyes: { ey: '17.4px', el: '13.4px', er: '24.2px', ew: '3.2px', eh: '4.2px', ec: '#2b1d14' }, svg: `
    ${mir('<path d="M9 14L10.5 4.5Q11 3.5 12 4.2L17 9.5Z" fill="#E8913F"/><path d="M10.9 11L11.7 6.4L14.8 9.6Z" fill="#F7B7A3"/>')}
    <ellipse cx="20" cy="20.5" rx="14.5" ry="12.5" fill="#F2A65A"/>
    <path d="M20 8.6v3.4M16.4 9.4l1 2.4M23.6 9.4l-1 2.4" stroke="#D9822B" stroke-width="1.4" stroke-linecap="round"/>
    <ellipse cx="20" cy="26" rx="6" ry="4.2" fill="#FFE9CF"/>
    ${mir('<circle cx="11.6" cy="24" r="2" fill="#FF8FA0" opacity=".35"/><path d="M5.5 23h4M6 25.6l3.6-.8" stroke="#fff" stroke-opacity=".7" stroke-width=".7" stroke-linecap="round"/>')}
    <path d="M18.8 23.6h2.4l-1.2 1.4z" fill="#E86A7A"/><path d="M18 26q1 1.1 2 0q1 1.1 2 0" stroke="#7a4a2a" stroke-width=".9" fill="none" stroke-linecap="round"/>` },
  dog: { style: 'flat', name: '콩', kind: '시바견', paw: '#FFF3E4', eyes: { ey: '17.2px', el: '13.6px', er: '24px', ew: '3.2px', eh: '3.8px', ec: '#2b2b30' }, svg: `
    ${mir('<path d="M9.5 15L11 5Q11.6 3.8 12.8 4.8L18 10Z" fill="#D9873E"/><path d="M11.7 11.6L12.4 6.9L15.6 10Z" fill="#F4D2B0"/>')}
    <path d="M20 8C29 8 34.5 13.5 34.5 20.5C34.5 28 28 32.5 20 32.5C12 32.5 5.5 28 5.5 20.5C5.5 13.5 11 8 20 8Z" fill="#E8A35A"/>
    <path d="M7.5 22C9 19 13 18.5 15.5 21C17 22.5 18.5 22.8 20 22.8C21.5 22.8 23 22.5 24.5 21C27 18.5 31 19 32.5 22C31.5 28.5 26.5 32 20 32C13.5 32 8.5 28.5 7.5 22Z" fill="#FFF3E4"/>
    ${mir('<ellipse cx="14.8" cy="14.6" rx="1.7" ry="1" fill="#FFF3E4"/><circle cx="10.6" cy="25" r="2" fill="#FF8FA0" opacity=".3"/>')}
    <ellipse cx="20" cy="23.8" rx="2" ry="1.4" fill="#2b2b30"/><path d="M18.4 26.4q1.6 1.3 3.2 0" stroke="#7a5236" stroke-width=".9" fill="none" stroke-linecap="round"/>` },
  fox: { style: 'flat', name: '여울', kind: '여우', paw: '#FFF4EA', eyes: { ey: '17.8px', el: '13.6px', er: '24px', ew: '3.2px', eh: '3.6px', ec: '#2b1d14' }, svg: `
    ${mir('<path d="M8 15L9.5 3.5Q10 2.6 10.8 3.2L17 10Z" fill="#F08A3E"/><path d="M9.1 7L9.6 3.6Q10 2.8 10.7 3.3L12.4 5Z" fill="#3a2a22"/><path d="M10.5 11.5L11.2 6.5L14.8 10Z" fill="#FFE3CC"/>')}
    <path d="M20 9C29 9 34 14.5 34 21C34 27.5 27.5 32 20 32C12.5 32 6 27.5 6 21C6 14.5 11 9 20 9Z" fill="#F08A3E"/>
    <path d="M6.5 22C9 20 13 20.5 15.5 23.5L20 28.5L24.5 23.5C27 20.5 31 20 33.5 22C32 28 26.5 32 20 32C13.5 32 8 28 6.5 22Z" fill="#FFF4EA"/>
    <ellipse cx="20" cy="25.8" rx="1.8" ry="1.3" fill="#2b2b30"/>` },
  rabbit: { style: 'flat', name: '토리', kind: '토끼', paw: '#F7F4F1', eyes: { ey: '19px', el: '13.8px', er: '23.8px', ew: '3.2px', eh: '4px', ec: '#3a2a2e' }, svg: `
    ${mir('<path d="M13 14C11 9 11 2.5 13.5 1.8C16 1.2 17 8 16.5 13Z" fill="#EDE7E3"/><path d="M13.6 12C12.6 8 12.8 3.6 14 3.4C15.2 3.2 15.6 8 15.4 11.6Z" fill="#F7C1CB"/>')}
    <ellipse cx="20" cy="22" rx="13" ry="11" fill="#F7F4F1"/>
    ${mir('<circle cx="12.4" cy="25" r="2" fill="#FF8FA0" opacity=".4"/>')}
    <path d="M19 23.6h2l-1 1.1z" fill="#F08AA0"/><path d="M20 24.7v1M18.6 26.2q1.4.8 1.4-.6q0 1.4 1.4.6" stroke="#8a6a70" stroke-width=".8" fill="none" stroke-linecap="round"/>` },
  bird: { style: 'flat', name: '삐삐', kind: '파랑새', paw: '#FFB547', eyes: { ey: '16.2px', el: '13.4px', er: '24.2px', ew: '3.2px', eh: '4px', ec: '#1c2a3a' }, svg: `
    <path d="M18 8.8q-1.5-4 1.5-5q-.2 2.5 1.3 3.2q.6-2.6 3-2.2q-2.2 1.6-1.6 4.3" fill="#4B9BEA"/>
    <ellipse cx="20" cy="21" rx="14" ry="13" fill="#6DB8FF"/>
    ${mir('<path d="M6.5 20.5q-2.6 4 .8 7.2q2.4-1 3-4.6z" fill="#4B9BEA"/><circle cx="11.8" cy="22" r="2" fill="#FF8FA0" opacity=".38"/>')}
    <ellipse cx="20" cy="26.2" rx="9" ry="7.2" fill="#D9EEFF"/>
    <path d="M18.2 21h3.6l-1.8 2.6z" fill="#FFB547"/><path d="M16.5 33.6v1.8M23.5 33.6v1.8" stroke="#FFB547" stroke-width="1.3" stroke-linecap="round"/>` },
  ghost: { style: 'flat', name: '부우', kind: '유령', paw: '#F3F1FA', eyes: { ey: '14.6px', el: '13.2px', er: '23.6px', ew: '3.6px', eh: '4.8px', ec: '#2e2840' }, svg: `
    <defs><radialGradient id="gglow" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#E4E0F2"/></radialGradient></defs>
    <path d="M7 30.5V17C7 9.5 12.8 4.5 20 4.5S33 9.5 33 17v13.5c-1.5 2-2.9 2-4.3 0s-2.9-2-4.3 0-3 2-4.4 0-2.9-2-4.3 0-3 2-4.4 0-2.9-2-4.3 0z" fill="url(#gglow)"/>
    ${mir('<circle cx="13.4" cy="21.4" r="2.1" fill="#FF8FA0" opacity=".45"/>')}<ellipse cx="20" cy="22.6" rx="1.4" ry="1.8" fill="#3a3346"/>` },

  /* ── clay / tiny 3D ── */
  duck: { style: 'clay', name: '꽉꽉', kind: '오리', paw: '#FFB13B', eyes: { ey: '16.6px', el: '13.6px', er: '24px', ew: '3.4px', eh: '4.2px', ec: '#2a2010' }, svg: `
    <defs><radialGradient id="dk1" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#FFF6C2"/><stop offset=".55" stop-color="#FFD43B"/><stop offset="1" stop-color="#E5A300"/></radialGradient>
    <radialGradient id="dk2" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#FFC27A"/><stop offset="1" stop-color="#F08A1C"/></radialGradient></defs>
    <ellipse cx="20" cy="34.4" rx="11" ry="1.6" fill="#000" opacity=".35"/>
    <path d="M19 8.6q-.6-3.4 2-4q-.4 2 .8 2.8" fill="#F5B90A"/>
    <ellipse cx="20" cy="20.5" rx="14" ry="13" fill="url(#dk1)"/>
    <ellipse cx="14" cy="12.6" rx="4.6" ry="2.6" fill="#fff" opacity=".5" transform="rotate(-25 14 12.6)"/>
    ${mir('<circle cx="11.6" cy="22.4" r="2" fill="#FF8F6A" opacity=".35"/>')}
    <ellipse cx="20" cy="23.4" rx="4.2" ry="2.3" fill="url(#dk2)"/><path d="M16.6 23.4h6.8" stroke="#C86A10" stroke-width=".6" opacity=".6"/>` },
  robot: { style: 'clay', name: '삑삑', kind: '로봇', paw: '#C9CED8', eyes: { ey: '17px', el: '14.4px', er: '22.8px', ew: '2.8px', eh: '4.4px', ec: '#5CE1E6', glow: 1 }, svg: `
    <defs><linearGradient id="rb1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F7F8FB"/><stop offset="1" stop-color="#A9B0BE"/></linearGradient>
    <radialGradient id="rb2" cx="35%" cy="35%" r="70%"><stop offset="0" stop-color="#FFB3AE"/><stop offset="1" stop-color="#E5352B"/></radialGradient></defs>
    <ellipse cx="20" cy="34.4" rx="11" ry="1.6" fill="#000" opacity=".35"/>
    <path d="M20 9V5.4" stroke="#9AA3B2" stroke-width="1.6" stroke-linecap="round"/><circle cx="20" cy="4.2" r="2.1" fill="url(#rb2)"/>
    ${mir('<rect x="4.6" y="17" width="3" height="7" rx="1.4" fill="#9AA3B2"/>')}
    <rect x="7" y="9" width="26" height="23" rx="8" fill="url(#rb1)"/>
    <rect x="8.6" y="9.8" width="12" height="3" rx="1.5" fill="#fff" opacity=".7"/>
    <rect x="10.5" y="13" width="19" height="13" rx="5" fill="#1d2433"/>
    <path d="M18 23.4h4" stroke="#5CE1E6" stroke-width="1" stroke-linecap="round" opacity=".85"/>` },
  blob: { style: 'clay', name: '말랑', kind: '젤리', paw: '#FF8FBF', eyes: { ey: '19px', el: '14px', er: '23.4px', ew: '3.2px', eh: '4.2px', ec: '#4a1f33' }, svg: `
    <defs><radialGradient id="bl1" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#FFE0EE"/><stop offset=".5" stop-color="#FF9CC6"/><stop offset="1" stop-color="#F0559A"/></radialGradient></defs>
    <ellipse cx="20" cy="33.8" rx="12.5" ry="1.7" fill="#000" opacity=".35"/>
    <path d="M7 30C5.5 26 6 18.5 9.5 14C12.5 10 16 8.5 20 8.5C24.5 8.5 28 10.5 30.5 14.5C33.8 19.5 34.5 26 33 30C31.5 33.5 8.5 33.5 7 30Z" fill="url(#bl1)"/>
    <ellipse cx="14.4" cy="14.4" rx="4" ry="2.4" fill="#fff" opacity=".6" transform="rotate(-30 14.4 14.4)"/><circle cx="26.4" cy="12.8" r="1" fill="#fff" opacity=".7"/>
    ${mir('<circle cx="12.2" cy="24.6" r="2" fill="#FF5E8E" opacity=".35"/>')}
    <path d="M18.4 25.2q.8.9 1.6 0q.8.9 1.6 0" stroke="#7a2a4c" stroke-width=".9" fill="none" stroke-linecap="round"/>` },
  hamster: { style: 'clay', name: '햄찌', kind: '햄스터', paw: '#FFF6EA', eyes: { ey: '18.2px', el: '13.4px', er: '24.4px', ew: '3.2px', eh: '3.6px', ec: '#2b1d14' }, svg: `
    <defs><radialGradient id="hm1" cx="35%" cy="28%" r="80%"><stop offset="0" stop-color="#FFEBD0"/><stop offset=".55" stop-color="#F3B877"/><stop offset="1" stop-color="#D9893F"/></radialGradient></defs>
    <ellipse cx="20" cy="34.4" rx="12" ry="1.6" fill="#000" opacity=".35"/>
    ${mir('<circle cx="10.4" cy="11" r="3.8" fill="#E7A86A"/><circle cx="10.4" cy="11" r="2.1" fill="#F7B9AE"/>')}
    <ellipse cx="20" cy="21.5" rx="14.5" ry="12.5" fill="url(#hm1)"/>
    <ellipse cx="20" cy="25.4" rx="9.4" ry="6.6" fill="#FFF6EA"/>
    <ellipse cx="14.6" cy="12.6" rx="4" ry="2.2" fill="#fff" opacity=".45" transform="rotate(-20 14.6 12.6)"/>
    ${mir('<ellipse cx="11.4" cy="24.4" rx="3.4" ry="2.6" fill="#FFB4A2" opacity=".55"/>')}
    <ellipse cx="20" cy="23.3" rx="1.2" ry=".9" fill="#E86A7A"/><path d="M18.6 25q1.4 1 1.4-.4q0 1.4 1.4.4" stroke="#7a4a2a" stroke-width=".8" fill="none" stroke-linecap="round"/>` },

  /* ── line / ASCII ── */
  kitty: { style: 'line', name: '냥이', kind: '고양이', color: '#FFD08A', face: '=^•ω•^=' },
  bear: { style: 'line', name: '곰돌', kind: '곰', color: '#E9C9A6', face: 'ʕ•ᴥ•ʔ' },
  bot: { style: 'line', name: '로보', kind: '로봇', color: '#8EE9F0', face: '[•_•]', top: '┬' },
  octo: { style: 'line', name: '문어', kind: '문어', color: '#FF9EC4', face: '(•ᴗ•)', bottom: '/||\\' },
}
export const DEFAULT_PET = 'cat'

/** --pk: 펫 상자 배율. 벡터 = k, 픽셀 = 아트 한 칸(2.5px)이 장치 픽셀 정수배가 되게 (흐려지지 않게) */
export function petScale(style: PetStyle, k: number, dpr = devicePixelRatio || 1) {
  if (style !== 'pixel') return k
  return Math.max(1, Math.round(2.5 * k * dpr)) / dpr / 2.5
}

const BELL = '<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0-6 6v4l-1.8 3h15.6L18 13V9a6 6 0 0 0-6-6z" fill="currentColor"/><path d="M9.8 18.5a2.2 2.2 0 0 0 4.4 0" fill="currentColor"/></svg>'
const ACC = `<div class="acc z">z<b>z</b></div><div class="acc bell">${BELL}</div>
<div class="acc laptop"><i class="paw a"></i><i class="paw b"></i></div><div class="acc stars"><i></i><i></i><i></i></div>
<div class="acc bang">!</div><div class="acc sweat"></div><div class="acc box"><i class="paw a"></i><i class="paw b"></i></div>`

function bodyOf(p: Builtin) {
  if (p.style === 'line') {
    let n = 0
    const face = p.face!.replace(/•/g, () => `<i class="aeye ${n++ ? 'r' : 'l'}" data-e="•"></i>`)
    return `<div class="asc" style="color:${p.color}">${p.top ? `<small>${p.top}</small>` : ''}<span>${face}</span>${p.bottom ? `<small>${p.bottom}</small>` : ''}</div>`
  }
  const e = p.eyes!
  return `<svg viewBox="0 0 40 36"${p.style === 'pixel' ? ' shape-rendering="crispEdges"' : ''}>${p.svg}</svg><div class="eyes" style="--ey:${e.ey};--el:${e.el};--er:${e.er};--ew:${e.ew};--eh:${e.eh};--ec:${e.ec}"><i class="eye l"></i><i class="eye r"></i><i class="brow l"></i><i class="brow r"></i></div>`
}
const BODY = new Map<string, string>()

/** 펫 1마리 (kind = 기본 펫 키) */
export const Pet = memo(function Pet({ kind, state, bubble = 1 }: { kind: string; state: PetState; bubble?: number }) {
  const p = PETS[kind] ?? PETS[DEFAULT_PET]
  if (!BODY.has(kind)) BODY.set(kind, bodyOf(p))
  return (
    <div className="pet" data-pet={kind} data-style={p.style} data-glow={p.eyes?.glow ? '' : undefined} data-s={state} style={{ '--paw': p.paw || p.color } as CSSProperties}>
      <div className="pbody" dangerouslySetInnerHTML={{ __html: BODY.get(kind)! }} />
      <div className="acc bubble">{bubble}</div>
      <div className="accs" dangerouslySetInnerHTML={{ __html: ACC }} />
    </div>
  )
})
