# Deep Interview Spec: Hera — Windows 글라스 독 + LP 턴테이블 런처

## Metadata
- Interview ID: hera-dock-lp-20261113
- Rounds: 8 (+ Round 0 topology)
- Final Ambiguity Score: 18.6%
- Type: greenfield (`D:\AI\hera`, 코드 없음)
- Generated: 2026-11-13
- Threshold: 0.2
- Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED — pending approval

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.85 | 0.40 | 0.340 |
| Constraint Clarity | 0.80 | 0.30 | 0.240 |
| Success Criteria | 0.78 | 0.30 | 0.234 |
| **Total Clarity** | | | **0.814** |
| **Ambiguity** | | | **0.186** |

## Topology
| Component | Status | Description | Coverage / Phase |
|-----------|--------|-------------|------------------|
| Dock | active — Dev P1 | 화면 가장자리 글라스 독, 앱·URL 등록/실행, 기본앱(계산기·메모장)은 네이티브 즉시 실행 | 시안 + 개발 1단계 |
| Record Library | active — Dev P1 | 실행중/즐겨찾기 앱·URL을 LP(레코드)로 등록·관리, 독/턴테이블 공유 | 시안 + 개발 1단계 |
| Todo / Calendar / Notifications | active — Dev P1 | 로컬 저장 할일·달력, 알림(Island로 표시) | 시안 + 개발 1단계 |
| Island | active — Dev P1 | 화면 상단 알약형: 다음 일정/할일 미리보기, 알림, 작업 Now Playing | 시안 + 개발 1단계 |
| LP Turntable (+LP 세트) | active — Dev P2 | 플로팅 턴테이블. LP 드래그→스냅→바늘→회전→실행, 앱이 살아있는 동안 계속 회전 | 시안 포함, 개발 2단계 |
| ⌘K 통합 검색창 | active — Dev P2 | 단축키 하나로 앱·URL·할일 검색/실행 | 시안 포함, 개발 2단계 |
| Dock 위젯 / 파일 선반 | active — Dev P2+ | 독 내 시계·배터리 등 위젯, 파일 임시 보관 선반 | 시안 포함, 개발 2단계 이후 |
| Clipboard 히스토리 | deferred | 2026-11-13 Round 1에서 미선택 | 보류 |
| 외부 캘린더 연동(Google/MS) | deferred | Round 4: "로컬 먼저, 연동은 나중에" | 데이터 구조만 연동 대비 |

## Goal
Windows 11에서 항상 떠 있는 **글라스 스타일 데스크톱 셸 오버레이**(Tauri 2)를 만든다. 1단계는 macOS풍 애니메이션 독 + 레코드 라이브러리로 앱/URL을 즉시 실행하고, 로컬 할일·달력과 알림을 상단 Island에 보여준다. 2단계에서 차별점인 **LP 턴테이블**(레코드를 올리면 실행되고, 앱이 살아있는 동안 회전하며 클릭 시 해당 창으로 전환)과 ⌘K 검색창, 위젯·선반을 추가한다. **개발 전 전체 7개 구성요소를 담은 인터랙티브 HTML 시안을 먼저 만들어 승인**받는다.

## Constraints
- 플랫폼: Windows 11, 기술: **Tauri 2**(웹 UI + Rust). Seelen UI(Tauri) 참고 가능.
- 디자인: **글라스(반투명·블러) 스타일**. Windows Mica/Acrylic 효과 활용 검토.
- 계산기·메모장 등은 **네이티브 앱 실행**(Win11은 타 앱 창 임베드 불가) — 대신 빠른 실행 + 맥 스타일 애니메이션.
- 데이터: 할일·달력 **로컬 저장**(SQLite 또는 JSON). 외부 연동(Google/MS Graph)을 나중에 붙일 수 있게 데이터 모델 분리.
- 순서: **HTML 시안 → 사용자 승인 → 개발**. 시안의 UI 코드는 Tauri 프런트엔드로 재사용.
- 셸 교체 아님: 기존 작업표시줄을 건드리지 않는 오버레이(ExplorerPatcher류 셸 패치 지양).

## Non-Goals
- 시스템 앱 창을 독 안에 임베드
- 클립보드 히스토리 (보류)
- 1단계에서 외부 캘린더/Tasks 동기화
- 실제 음악 재생 (이 PC에서 미디어 미사용 — Island의 Now Playing은 "작업"을 음악처럼 표현)
- 1단계에서 LP 턴테이블·⌘K·위젯·선반 개발 (시안에는 포함)

## Acceptance Criteria
### Stage A — 인터랙티브 HTML 시안 (승인 게이트)
- [ ] 브라우저에서 열리는 단일 시안에 7개 구성요소(독, 라이브러리, 할일/달력/알림, Island, LP 턴테이블+세트, ⌘K, 위젯/선반)가 모두 보인다
- [ ] 글라스 스타일(반투명·블러) 일관 적용, 라이트/다크 대응
- [ ] 필수 애니메이션 4종이 동작하며 끊김 없이 60fps:
  - [ ] 독 아이콘 macOS식 확대(magnification) + 클릭 시 실행 바운스
  - [ ] Island 확장/축소 (스프링)
  - [ ] 패널(할일·달력·라이브러리) 열기/닫기
  - [ ] LP 드래그 → 턴테이블 스냅 → 바늘 하강 → 회전 가속
- [ ] Island에 다음 일정/할일 미리보기, 알림 확장, 작업 Now Playing(앱명=곡명, 경과시간=진행바, 미니 LP 회전) 표현
- [ ] 사용자가 "디자인 OK"를 명시해야 Stage B 진입

### Stage B — 개발 1단계 (Tauri 2)
- [ ] 투명·프레임리스·항상 위 독 창, 실제 앱(.exe/.lnk/UWP AUMID)·URL 등록 및 실행
- [ ] 탐색기/브라우저에서 드래그로 등록, 아이콘 자동 추출
- [ ] 계산기·메모장 클릭 → 실행까지 체감 지연 없음(목표 < 300ms 내 실행 요청)
- [ ] 실행 중 앱 표시(독 인디케이터), 레코드 라이브러리 CRUD
- [ ] 할일·달력 로컬 CRUD, 재시작 후 유지
- [ ] 예정 시각에 Island 알림 확장(완료/다시 알림 버튼)
- [ ] Island Now Playing: 현재 포그라운드 앱/세션과 경과시간 표시
- [ ] 시안의 4종 애니메이션이 실제 앱에서도 60fps 유지, 상시 구동 메모리 합리적 수준

### Stage C — 개발 2단계 (이후)
- [ ] LP 턴테이블: 드래그→실행, 앱 생존 중 계속 회전, 클릭 시 창 전환, 앱 종료 시 정지
- [ ] LP 세트(한 판에 여러 앱 묶음 실행), ⌘K 검색창, 독 위젯, 파일 선반

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 미니툴을 앱 안에 내장 | Win11에서 시스템 앱 임베드 불가 | 네이티브 실행 + 빠른 실행 + 맥 애니메이션 |
| LP 회전은 실행 연출 | 회전의 의미? | 앱 생존 동안 계속 회전 = 실행 상태 표시 |
| 할일·달력 자체 구현 필요 | Outlook/Google을 보여주기만 하면? (Contrarian) | 로컬 먼저, 연동 대비 구조 |
| 전부 한 번에 개발 | 7개 동시 개발은 완료점이 흐림 (Simplifier) | 시안은 전체, 개발은 P1(독·라이브러리·생산성·Island) → P2 |
| Island = 음악 Now Playing | PC에서 미디어 미사용 | 작업/앱을 음악처럼 표현하는 Now Playing |
| LP가 1단계 핵심 | 사용자 선택 | LP는 시안에서 검증, 개발은 2단계 |

## Technical Context
- **Tauri 2**: `transparent: true`, `decorations: false`, `alwaysOnTop: true`, `skipTaskbar`; 독·Island·턴테이블은 각각 별도 webview 창.
- 실행: `tauri-plugin-opener`/`ShellExecuteW` (.exe/.lnk/URL), UWP는 `explorer.exe shell:AppsFolder\<AUMID>`, 앱 목록은 `Get-StartApps`/시작메뉴 .lnk.
- 아이콘 추출: Rust에서 `SHGetFileInfoW`/`IShellItemImageFactory` (windows crate).
- 실행 상태/포그라운드 추적: `EnumWindows` + `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` (Now Playing, 독 인디케이터, LP 회전).
- 글라스: 창 배경은 `window-vibrancy` crate(Mica/Acrylic) + CSS `backdrop-filter`.
- 알림: 앱 내부 스케줄러 → Island 확장(필요 시 Windows 토스트 보조).
- 저장: `tauri-plugin-sql`(SQLite) 또는 `tauri-plugin-store`.
- 시안: 순수 HTML/CSS/JS(또는 Vite+React) — Stage B 프런트엔드로 이관.
- 레퍼런스: zincwolf.app(macOS, Dock 위젯·Island·Shelf·⌘K, LP 없음), Nexus Dock, RocketDock, Fences, Flow Launcher, PowerToys Run, Raycast for Windows, Seelen UI(Tauri), Vinyl Desktop(Steam, 턴테이블 드롭 UX — 바늘 내리기 메타포).

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Record (LP) | core domain | id, title, target(exe/lnk/aumid/url), icon, coverColor, kind(single/set) | Library has many Records; Set Record has many Targets |
| Library | core domain | records, favorites | shared by Dock and Turntable |
| Dock | core domain | pinnedRecords, position, magnification | shows Records, indicates RunningSessions |
| Turntable | core domain | currentRecord, rpm, needleState | plays one Record → RunningSession |
| RunningSession | core domain | recordId, pid/hwnd, startedAt | Turntable spin & Island Now Playing reflect it |
| Island | supporting | mode(idle/preview/alert/nowPlaying) | shows Todo/Event preview, Notification, RunningSession |
| Todo | core domain | title, due, done | triggers Notification |
| CalendarEvent | core domain | title, start, end | triggers Notification |
| Notification | supporting | source, time, actions(done/snooze) | displayed by Island |
| DesignMockup | process | screens, animations | gates development |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 8 | 8 | - | - | N/A |
| 2 | 9 | 1 (RunningSession) | 0 | 8 | 89% |
| 3 | 10 | 1 (DesignMockup) | 0 | 9 | 90% |
| 4–7 | 10 | 0 | 0 | 10 | 100% |
| 8 | 10 | 0 | 0 (Island 역할 확장) | 10 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (Round 0 + 8 rounds)</summary>

### Round 0 — Topology
**A:** 대부분 맞음. 미니툴은 기본앱을 빠르게 + 맥 애니메이션. 추가 기능 제안 요청, todo·달력·알림 추가.

### Round 1 — 추가 기능 (Constraints)
**A:** ⌘K 검색창, 독 위젯, 파일 선반 + LP 세트, 상단 Island. (클립보드 제외) — Ambiguity 65%

### Round 2 — LP 동작 (Goal)
**A:** 실행 중 표시로 계속 회전. — 58%

### Round 3 — 기술 스택 (Constraints)
**A:** Tauri 2, 글라스 디자인, 시안 먼저 → 승인 후 개발. — 48%

### Round 4 — 데이터 출처 (Contrarian)
**A:** 로컬 먼저, 연동은 나중에. — 42%

### Round 5 — 시안 형태 (Criteria)
**A:** 인터랙티브 HTML 시안. — 35%

### Round 6 — 개발 1단계 범위 (Simplifier)
**A:** 독+라이브러리, 할일/달력/알림+Island. 애니메이션이 중요. — 28%

### Round 7 — 필수 애니메이션 (Criteria)
**A:** 독 확대+바운스, Island 확장/축소, 패널 열기/닫기, LP 드래그→바늘→회전. — 23%

### Round 8 — Island 내용 (Goal)
**A:** 다음 일정/할일 미리보기, 알림 표시, 음악 대신 특정 작업/앱을 음악으로 표현. — 18.6%
</details>
