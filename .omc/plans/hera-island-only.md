# Hera — Island-only (독 제거) 개발 결정 (2026-11-15)

브랜치 `island-only` (master d3c3d83 기준, 워크트리 `D:\AI\hera-island`). 시안 = `island-hub` 브랜치 (hub v2 의 노치·선반·상단 확보·그림자 수정 재사용).

## 사용자 결정 (확정)
- 독 없음. 앱 = Windows 작업 표시줄 · 시작 · Ctrl K(팔레트, 실제 단축키 Ctrl+Alt+K).
- Island = 노치(120×6) · 알림 · 입구. 허브 = 레이아웃 A (오늘 줄 + 이름 붙은 아이콘 13개 + 'Ctrl K' 줄).
- 기능 화면 = 떠 있는 창(기능마다 1개, 필요할 때 생성 · 닫으면 파괴).
- LP = 떠 있는 LP 플레이어(화면 효과 · 아스키 레코드).
- 너무 미니멀하지 않게: 모든 기능이 이름과 함께 보인다.

## 지우는 것 (비활성화 X, 삭제 — 기록은 git)
- 독 창(`dock`)과 Dock.tsx 의 독 UI (Tile·usePresence·reducedMotion 등 공용 조각은 남김), 독 전용 CSS.
- shell.rs: 셸 훅(깜빡임), 실행 중 창 목록 이벤트(`windows`/`running`), DWM 썸네일, Win 키 버튼, 작업 표시줄 lift. taskbar.rs 통째로.
- 커맨드: windows_list, win_click, win_close, shell_key, thumbs, taskbar_lift, dock_tall, lp_drag.
- 남김: shell.rs 의 한/영(IME) 감지·가로채기(Link), 앞 앱 추적(fg-rect, 앱 메모), `list()` = MCP `list_running_apps` 용 **요청 시 1회 열거**(상시 훅 없음).
- 데이터 유지: `record:*` · `group:*` · `dock.pinned` 그대로 → 팔레트에서 검색·실행.

## Island (island 창 460×560, 클릭 통과 = 히트 rect 만)
- 접힘 = 노치 120×6, 모니터 맨 위 가운데(작업 영역 아님). 히트 rect = 정확히 120×6.
- 점: 빨강 = 읽지 않은 채팅, 초록 = 터미널 실행 중, 파랑 = 선반에 파일.
- 알약으로 커짐: 할 일·일정·팀 알림, 팀 소식, 채팅 빠른 답장, 터미널 완료/실패, Link 페어링·전송·화면 전환, 한/A, 효과·아스키 재생 중.
- 파일 드래그: 바깥에서 누른 채 끌어오는 드래그가 화면 위쪽 가운데 띠(위 140px, 가운데 ±360px)에 들어오면 watch 루프가 `drag-near` → 노치가 드롭존으로 → 놓으면 선반. (OS 전역 "파일 드래그 중" 신호는 없다 — 화면 어디서나는 불가, 위쪽 가운데로 끌어오면 열림.)
- 탭 / 0.3초 머묾(마우스) → 허브. 전체화면 앱이면 숨김(기존 watch 규칙).
- 옵션 '상단 공간 확보'(AppBar 28px, 기본 끔): 전용 숨은 창으로 SHAppBarMessage(ABM_NEW/ABM_SETPOS) 등록, 끌 때·종료 시 ABM_REMOVE. 크래시 대비: 시작 시 이전 등록 흔적이 있으면 먼저 정리(같은 창 클래스로 REMOVE). Explorer 는 등록 창이 사라지면 예약을 회수한다(창 파괴 = 해제).

## 허브 (island 창 안, 노치 아래 400px)
- 위: 오늘 줄 = 다음 일정 · 남은 할 일 수.
- 아이콘 13개(이름 표시): 메모, 할 일, 달력, 채팅, 터미널, 최근 복사, 선반, OCR, 스니펫, LP, Team, Link, 설정.
- 누르면 그 떠 있는 창을 열거나 앞으로 + 허브 접힘. 아래: '앱 실행 · Ctrl K' 줄.
- 메모 = 포스트잇 펼침/접힘(+ 타일 모서리 '+' = 새 메모). OCR = 기존 흐름. 스니펫 = 팔레트를 ';' 로 열기(기존 흐름). Team · Link · 설정 = 패널 설정 탭의 그 섹션으로.

## 떠 있는 창 (`float-<기능>`, URL `?surface=float&f=<기능>`)
- 기능: todo, calendar, chat, term, clips, shelf, lp. 생성은 필요할 때, 닫기(✕/Esc) = 파괴 → 평소 메모리 0.
- 끌기 = 머리줄(data-tauri-drag-region), 위치·크기 = store `float.<f>` 에 기억(Rust Moved/Resized 디바운스 저장). '항상 위' 핀 = 커맨드.
- 달력 = 처음 떠 있던 달력(MonthCalendar)과 같은 모양.

## LP 플레이어 (`float-lp`, 떠 있는 유리 턴테이블)
- 레코드: 효과 눈/비/단풍/노을/달·별 + 아스키 자동/크리스마스/밤 도시/단풍/클로버. Disc · ASCII_RECORDS 재사용.
- 플래터에 레코드를 끌어 놓기 = 재생(효과 창/아스키 창), 암 들기·레코드 빼기 = 정지. Island = 재생 중 알약.
- 효과 자동 스위치·도시·날씨 설정은 '설정'에 그대로.

## 채팅 (Team 전송 위, 실제) — 제안 기본값(설정으로, 확정 전)
- 공유 그룹마다 방 1개. 메시지는 link_sync 로 맞춤(늦게 켠 사람 따라잡기), 로컬 30일 보관.
- 파일·사진 ≤100MB, 보낸 사람에게서 P2P 직접(보낸 사람이 온라인일 때만 받기). Team 채널과 같은 암호화.
- 동작: 복사, 열기, 선반에, 메모로, 일정 추가 칩, 끌어내기(OLE). Island 빠른 답장 + 읽지 않음 점.

## 터미널 (실제)
- ConPTY (Rust PTY 크레이트) + xterm.js(터미널 창을 열 때만 로드). 기본 PowerShell.
- 창을 숨겨도 계속 → Island 실행 중 → 완료/실패.
- '아라에서 이어서 하기' = 문서화된 CLI 만: `ara status` → 꺼져 있으면 `ara open` → cwd = 터미널 cwd 로 `ara terminal create --title "Hera에서" [--command <마지막 명령>]`. 이름 있는 파이프·토큰 사용 금지. 테스트는 CLI 경로를 가짜로(사용자 아라에 탭 만들지 않음).

## 검증
- tsc, clippy, cargo test ×5, CDP: dock/taskbar 스위트 삭제, island/hub/float/LP/chat/terminal 추가.
- idle 메모리 ≤150MB(떠 있는 창 없음) + 창 1개 열었을 때 수치.
- `npx tauri build` → 설치 파일 경로 보고(실행 안 함).

## 단계 (보고)
(a) 독 제거 + Island/허브 A + 떠 있는 창 → (b) LP 플레이어 → (c) 채팅 → (d) 터미널 → (e) 빌드.

## 결과 (2026-11-15)
- (a) 994ac78 — 독·작업 표시줄 대체 삭제, 노치(120×6)·허브 A·떠 있는 창·상단 공간 확보. island-cdp ALL PASS.
- (b) 994ac78 — LP 플레이어(효과 5 + 아스키 5). lp-cdp ALL PASS.
- (c) 0acbbe7 — 팀 채팅(chat:<id> 동기화, 파일 P2P 'cget', Island 빠른 답장). cargo test team::chat_messages_and_files, chat-cdp ALL PASS.
- (d) 7314e94 — 터미널(ConPTY + 지연 로드 xterm.js, OSC 9999 완료 표지) + 아라 CLI 넘기기. term-cdp ALL PASS (가짜 CLI).
- 확인 못 한 것(잠금 화면): 실제 화면에서 노치 호버·드래그 드롭존, AppBar 켜기(사용자 창이 움직여 시험하지 않음), 두 PC 사이 실제 채팅 파일(단위 시험으로 대신), 아라 실제 탭 생성(가짜 CLI 로 대신).
- (e) 릴리스 메모리(격리 식별자, 안정 후): idle 64.8MB(떠 있는 창 없음 · 시작 직후 일시 178MB → 몇 초 안에 정리), 달력 창 1개 열면 137MB. cargo test ×5 = 65 passed ×5. 설치 파일 `src-tauri/target/release/bundle/nsis/Hera_0.1.0_x64-setup.exe` (12.55MB, 실행 안 함).
