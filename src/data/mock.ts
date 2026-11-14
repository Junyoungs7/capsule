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

export const seedEvents: CalendarEvent[] = [
  { id: 'e1', title: '디자인 리뷰', start: at(0, 16), end: at(0, 17), source: 'local' },
  { id: 'e2', title: '스프린트 회고', start: at(2, 14), end: at(2, 15), source: 'local' },
  { id: 'e3', title: '점심 약속', start: at(5, 12), end: at(5, 13), source: 'local' },
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
