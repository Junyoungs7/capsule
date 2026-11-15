// v3 상용구: 키 snippet:<id>. 본문의 {오늘} {시간} {이름} 은 붙여넣을 때 채운다.
export type Snippet = { id: string; title: string; body: string }

export const seedSnippets: Snippet[] = [
  { id: 'sn-sign', title: '메일 서명', body: '감사합니다.\n{이름} 드림\n개발팀 · 02-1234-5678' },
  { id: 'sn-sql', title: '자주 쓰는 SQL', body: "SELECT * FROM banner WHERE use_yn = 'Y' AND '{오늘}' BETWEEN start_dt AND end_dt ORDER BY sort_no;" },
  { id: 'sn-cs', title: '고객 응대 답변', body: '안녕하세요, 고객님. 문의 주신 내용 확인했습니다.\n담당 부서 확인 후 {오늘} 중으로 다시 안내드리겠습니다. 감사합니다.' },
  { id: 'sn-report', title: '오늘 날짜 보고 머리말', body: '[{오늘} 업무 보고] {이름} · {시간} 기준' },
]

export const SNIP_NAME = '김헤라' // 시안: {이름} 값 (실제 앱 = 설정)

export function expand(body: string, now = new Date()) {
  const vars: Record<string, string> = {
    오늘: now.toLocaleDateString('sv'),
    시간: now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }),
    이름: SNIP_NAME,
  }
  return body.replace(/\{(오늘|시간|이름)\}/g, (_, k: string) => vars[k])
}
