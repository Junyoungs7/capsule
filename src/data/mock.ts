import type { AppGroup, CalendarEvent, Clip, LpRecord, ShelfFile, Todo } from './types'

export const seedShelf: ShelfFile[] = [
  { id: 's1', path: String.raw`C:\Users\me\Documents\기획서_v3.pdf`, at: 1 },
  { id: 's2', path: String.raw`C:\Users\me\Pictures\배너_시안.png`, at: 2 },
]

export const COVERS = ['#2F80ED', '#14B8A6', '#F59E0B', '#EF4444', '#0EA5E9', '#22C55E', '#F97316', '#64748B']

export const seedRecords: LpRecord[] = [
  { id: 'calc', title: '계산기', target: String.raw`shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`, kind: 'single', cover: '#334155', glyph: 'calc' },
  { id: 'notepad', title: '메모장', target: String.raw`shell:AppsFolder\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App`, kind: 'single', cover: '#0EA5E9', glyph: 'notepad' },
  { id: 'vscode', title: 'VS Code', target: String.raw`C:\Program Files\Microsoft VS Code\Code.exe`, kind: 'single', cover: '#2F80ED', glyph: 'code' },
  { id: 'chrome', title: 'Chrome', target: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`, kind: 'single', cover: '#F59E0B', glyph: 'chrome' },
  { id: 'github', title: 'GitHub', target: 'https://github.com', kind: 'single', cover: '#1F2937', glyph: 'text' },
  { id: 'notion', title: 'Notion', target: 'https://www.notion.so', kind: 'single', cover: '#78716C', glyph: 'text' },
  { id: 'workset', title: '작업 세트', target: '', kind: 'set', targets: ['vscode', 'chrome', 'notepad'], cover: '#14B8A6', glyph: 'set' },
]

const at = (dayOffset: number, h: number, m = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

export const seedTodos: Todo[] = [
  { id: 't1', title: '배너 API 리뷰 반영', due: at(0, 17, 30), done: false, source: 'local' },
  { id: 't2', title: 'Hera 시안 스크린샷 정리', done: false, source: 'local' },
  { id: 't3', title: '주간 보고 작성', due: at(1, 10), done: true, source: 'local' },
]

const FRI = (5 - new Date().getDay() + 7) % 7 || 7 // 다음 금요일까지 며칠
export const seedEvents: CalendarEvent[] = [
  { id: 'e1', title: '디자인 리뷰', start: at(0, 16), end: at(0, 17), source: 'local' },
  { id: 'e2', title: '스프린트 회고', start: at(2, 14), end: at(2, 15), source: 'local' },
  { id: 'e3', title: '점심 약속', start: at(5, 12), end: at(5, 13), source: 'local' },
  // Hera Team 시안: 공유 그룹 일정 (그룹 색으로 표시)
  { id: 't1', title: '배포', start: at(FRI, 14), end: at(FRI, 15), source: 'local', group: 'tg-dev', by: '민수' },
  { id: 't2', title: '코드 리뷰 데이', start: at(1, 10), end: at(1, 12), source: 'local', group: 'tg-dev', by: '지은' },
  { id: 't3', title: '배너 시안 리뷰', start: at(0, 15), end: at(0, 16), source: 'local', group: 'tg-banner', by: '서연' },
  { id: 't4', title: '가을 배너 오픈', start: at(6, 9), end: at(6, 10), source: 'local', group: 'tg-banner', by: '현우' },
]

export const seedGroups: AppGroup[] = [{ id: 'g-dev', title: '개발', recordIds: ['vscode', 'github', 'chrome', 'notepad', 'notion'] }]

const ago = (min: number) => Date.now() - min * 60_000
export const seedClips: Clip[] = [
  { id: 'c1', text: 'npm run dev -- --host', at: ago(2) },
  { id: 'c2', text: 'https://github.com/tauri-apps/tauri/discussions', at: ago(9) },
  { id: 'c3', text: '배너 노출 기간은 시작일 00:00 ~ 종료일 23:59 기준입니다.', at: ago(26) },
  { id: 'c4', text: 'SELECT * FROM banner WHERE use_yn = "Y" ORDER BY sort_no;', at: ago(48) },
  { id: 'c5', text: '#2F80ED', at: ago(95) },
  { id: 'c6', text: '010-1234-5678', at: ago(180) },
]

/* ── QA 시드 (시안 전용, URL 로만): ?stress=1 = 많은 일정·긴 제목·12 그룹·실행 중 앱 15개·메모 많음, ?empty=1 = 빈 상태 ── */
const qa = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search)
export const STRESS = qa.has('stress')
export const EMPTY = qa.has('empty')
const LONG = [
  '분기 OKR 리뷰 및 다음 분기 로드맵 확정 회의 (전사 공유, 녹화 있음)',
  'Quarterly business review with Global Partnerships — APAC kickoff',
  '배너 관리 화면 접근성 점검',
  '1:1',
  'Release train sync: hera-team P2P transport & encryption handshake',
  '점심',
  '디자인 시스템 토큰 정리 — 색·반경·그림자 (Liquid Glass 반영)',
  '고객사 미팅 사전 리허설',
  'Infra on-call handover',
  '사내 보안 교육 (필수 이수, 미이수 시 계정 제한)',
  '스탠드업',
  'Retro + 회고 액션아이템 정리',
]
if (STRESS) {
  const gs = ['tg-dev', 'tg-banner', 'tg-x0', 'tg-x1', 'tg-x2', 'tg-x3', 'tg-x4', 'tg-x5', 'tg-x6', 'tg-x7', 'tg-x8', 'tg-x9', undefined]
  LONG.forEach((title, i) => seedEvents.push({ id: 'q0-' + i, title, start: at(0, 8 + i, i % 2 ? 30 : 0), end: at(0, 9 + i), source: 'local', group: gs[i % gs.length], by: gs[i % gs.length] ? '민수' : undefined }))
  for (let d = 1; d < 20; d += 3) for (let i = 0; i < (d % 5) + 2; i++) seedEvents.push({ id: `q${d}-${i}`, title: LONG[(d + i) % LONG.length], start: at(d, 9 + i), end: at(d, 10 + i), source: 'local', group: gs[(d + i) % gs.length], by: '지은' })
  for (let i = 0; i < 4; i++) seedTodos.push({ id: 'qt' + i, title: LONG[(i * 3) % LONG.length], due: at(0, 18, i * 10), done: false, source: 'local' })
  seedRecords.push(
    { id: 'q-figma', title: 'Figma — Hera Design System (Liquid Glass)', target: 'https://figma.com', kind: 'single', cover: '#A259FF', glyph: 'text' },
    { id: 'q-slack', title: 'Slack', target: 'https://slack.com', kind: 'single', cover: '#4A154B', glyph: 'text' },
    { id: 'q-jira', title: '지라 · 배너 관리 스프린트 보드', target: 'https://jira.example.com', kind: 'single', cover: '#2684FF', glyph: 'text' },
  )
  seedClips.unshift(
    { id: 'qc1', text: 'SELECT b.banner_id, b.title, b.start_dt, b.end_dt FROM banner b WHERE b.use_yn = ' + "'Y'" + ' AND sysdate BETWEEN b.start_dt AND b.end_dt ORDER BY b.sort_no', at: Date.now() - 60_000 },
    { id: 'qc2', text: '가을 특가 · 단풍 여행 기획전 메인 배너 카피 (최종) — 최대 30% 할인, 11/30까지', at: Date.now() - 4 * 60_000 },
  )
}
if (EMPTY) for (const a of [seedEvents, seedTodos, seedClips, seedShelf, seedRecords, seedGroups] as unknown[][]) a.length = 0
