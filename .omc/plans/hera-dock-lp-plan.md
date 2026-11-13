Status: 실행 승인 — Stage A·B(B0~B5)·C(C1~C4) 완료(2026-11-13), 사용자 지시로 B0→B(P1)→C(P2) 자율 진행 (월요일 결과 확인). A5 게이트는 사용자 사전 승인으로 대체, 게이트 시트는 기록용으로 작성.

## 사용자 추가 요구 (2026-11-13, 승인 시점) — 아래 본문보다 우선
1. **점(dot) 독**: 평소엔 화면 하단 가장자리의 작은 점/핸들(약 40×6px)만 보인다. 마우스를 올리면 독이 스프링으로 펼쳐지고, 벗어나면 ~400ms 후 다시 점으로 접힌다. 창은 여전히 최대 크기 고정 — 접힘 상태의 히트 rect 는 점 영역만 보고하므로 나머지는 전부 클릭 통과. **필수 애니메이션 5종**: (0) 점→독 펼침/접힘 추가.
2. **성능 최우선(메모리)**: 개발 PC에 IDE·AI 도구가 상시 떠 있음. Decision Driver 1순위로 승격(애니메이션 품질과 동급).
   - 메모리 목표 **idle(독 접힘·패널 닫힘) ≤ 150MB**, 상한 200MB(Private WS 합).
   - panel 은 **기본 지연 생성 + 닫으면 파괴**(hide 유지 아님) — 결정 규칙 ①을 기본값으로 승격.
   - B0 에 WebView2 `MemoryUsageTargetLevel = Low`(접힘/숨김 상태) 검증 추가.
   - 접힘/idle 상태에서 **rAF·무한 애니메이션 0개**(미니 LP 회전 정지 기본안 유지), 이벤트 없으면 렌더 없음.
   - 시안도 가볍게: 이미지 에셋 최소, `backdrop-filter` 는 정적 레이어에만, 애니메이션 중 블러 반경 변경 금지.

# Hera — Windows 글라스 독 + LP 턴테이블 런처 작업 계획

- Source spec: `.omc/specs/deep-interview-hera-dock-lp.md` (ambiguity 18.6%, PASSED)
- Mode: RALPLAN-DR **SHORT** (Architect/Critic 합의 반영본 — 맨 끝 Changelog 참조)
- Type: greenfield (`D:\AI\hera`, `.omc/` 외 코드 없음)
- 순서 고정: **Stage A 시안(A1~A4) → B0 플랫폼 스파이크·메모리 측정 → A5 "디자인 OK" 게이트(부분 OK 허용) → Stage B (Dev P1) → Stage C (Dev P2)**

---

## 1. Requirements Summary

Windows 11에서 항상 떠 있는 글라스 스타일 데스크톱 오버레이(Tauri 2, 셸 교체 아님)를 만든다.

| 단계 | 범위 | 완료 기준 요약 |
|---|---|---|
| **A. 시안** | 7개 구성요소(독, 레코드 라이브러리, 할일/달력/알림, Island, LP 턴테이블+세트, ⌘K, 위젯/파일 선반)를 담은 인터랙티브 시안 1개 + 필수 애니메이션 4종 60fps. 시안의 글라스는 B0에서 확정된 실제 기법을 반영 | A5 게이트 시트로 사용자 "디자인 OK"(전체 또는 P1 표면 부분 OK) |
| **B0. 스파이크** | 글라스·창 스타일·클릭 통과 폴러·드래그 역할·메모리·스토어 이벤트를 실제 Tauri 창으로 검증 | 항목별 채택안 기록 + 실제 데스크톱 위 글라스 독 스크린샷 |
| **B. Dev P1** | 독 + 레코드 라이브러리(앱 .exe/.lnk/UWP AUMID·URL 등록/실행, 아이콘 추출, 실행 인디케이터), 로컬 할일/달력 CRUD, 예약 알림 → Island, Island Now Playing(포그라운드 앱=곡) | 실앱에서 P1 애니메이션 60fps, 실행 요청 <300ms, 메모리 ≤200MB, idle CPU 기준(§7) |
| **C. Dev P2** | LP 턴테이블(+세트), ⌘K 팔레트, 독 위젯, 파일 선반 | 턴테이블이 앱 생존 동안 회전, 클릭 시 창 전환, 종료 시 정지 |
| 보류 | 클립보드 히스토리, 외부 캘린더 연동 | Todo/Event 에 `source`, `externalId` 필드만 예약 |

비목표: 타 앱 창 임베드, 실제 음악 재생, 작업표시줄/탐색기 패치, P1에서 턴테이블·⌘K·위젯·선반 개발.

---

## 2. RALPLAN-DR Summary

### Principles
1. **시안 코드 = 제품 코드.** Stage A에서 쓴 컴포넌트를 Stage B에서 그대로 Tauri 프런트엔드로 쓴다. 버리는 시안 금지.
2. **애니메이션은 compositor 전용.** `transform`/`opacity`/`clip-path`만 애니메이션, mousemove 당 React 리렌더 금지(ref로 직접 style 갱신). 창 크기는 애니메이션하지 않는다(창은 최대 크기 고정).
3. **플랫폼 위험은 디자인 승인 전에 스파이크.** 글라스·클릭 통과·포커스·드래그·메모리를 A5 게이트 **전에** 실제 창으로 검증해, 시안이 실제로 출시될 기법을 보여주게 한다.
4. **최소 구성.** 창은 표면당 1개, 저장은 파일 1개(항목당 키 1개), Rust 모듈 4개, 백그라운드 루프 1개. 인터페이스·추상 레이어 없음.
5. **셸을 건드리지 않는다.** 작업 영역(work area) 안에 떠 있는 오버레이, 전체화면 앱 위에서는 숨김, Alt+Tab에 나타나지 않음.

### Decision Drivers (Top 3)
1. **애니메이션 품질(60fps)** — 사용자 최우선("애니메이션이 중요").
2. **Windows 오버레이 동작 정확성** — 투명·항상 위·포커스 비탈취·클릭 통과·전체화면·DPI.
3. **시안→개발 재사용률 / 1인 개발 속도** — 사용자는 웹/Java 개발자.

### Options

#### D1. 시안 기술
| | A) 순수 HTML/CSS/JS 단일 파일 | **B) Vite + React + TS (선택)** |
|---|---|---|
| 장점 | 더블클릭으로 열림, 의존성 0, 빠른 시작 | Tauri 프런트엔드로 그대로 이관, 7개 표면 + 상태(할일/라이브러리) 관리 용이, TS 타입이 Rust 커맨드 계약 역할 |
| 단점 | 7개 표면·상태가 커지면 스파게티, Stage B에서 재작성 필요(원칙 1 위반) | `npm run dev` 필요(file:// 불가), React 리렌더가 애니메이션을 망칠 위험 → 원칙 2로 통제 |

**선택: B.** 무효화 근거: A는 Stage B에서 다시 컴포넌트화해야 하므로 "시안 UI 코드를 Tauri 프런트엔드로 재사용" 제약을 충족 못한다. 애니메이션 라이브러리(framer-motion 등)는 **추가하지 않음** — CSS transition + Web Animations API + CSS `linear()` 스프링 이징으로 충분(WebView2 = Chromium). 부족이 측정되면 그때 추가.

#### D2. 창 아키텍처
| | A) 전체화면 투명 클릭통과 오버레이 1개 | **B) 표면별 별도 창 (선택)** |
|---|---|---|
| 장점 | 표면 간 드래그(LP→턴테이블)가 DOM 안에서 해결, 창 관리 1개 | 투명 합성 면적 = 표면 크기(모니터 전체 아님), 전체화면 앱과 충돌 없음(창 단위 숨김), panel 은 포커스를 받는 독립 창이라 실제 OS 백드롭(Mica/Acrylic) 적용 가능 |
| 단점 | 모니터 크기 투명 창의 상시 DWM 합성 비용, 전체화면 게임/영상 위에서 모니터 전체 창이 충돌, OS 백드롭을 화면 전체에 깔 수밖에 없어 panel 에 진짜 백드롭 불가 | 창 간 드래그 불가, 창마다 WebView2 메모리(→ B0 측정·결정 규칙) |

**선택: B.** 클릭 통과는 **두 안 모두 커서 폴링이 필요**하다(Tauri `set_ignore_cursor_events` 는 창 전체 토글) — 그래서 "폴링 없음"은 선택 근거가 아니다. dock/island 의 블러도 두 안 모두 B0 스파이크(blur-behind 또는 배경화면 페이크) 결과에 따른다 — "진짜 블러"도 근거가 아니다. 남는 근거는 위 장점 3가지: **모니터 크기 투명 합성 없음, 전체화면 앱과 비충돌, panel 의 실제 OS 백드롭.**
- 창 목록(P1 3개, P2 +2): `dock`(하단, 작업 영역 위, 확대 여유 포함 **최대 크기 고정**), `island`(상단 중앙, 펼친 최대 크기 **고정**), `panel`(할일/달력/라이브러리 탭 1개 창, show/hide, 포커스 허용)
- P2: `turntable`(플로팅), `palette`(⌘K, 필요 시 show)
- 창 간 LP 드래그 문제는 턴테이블 창 안에 레코드 크레이트를 두어 해결(C1).

#### D3. 저장소
| | A) tauri-plugin-sql (SQLite) | **B) tauri-plugin-store (JSON) (선택)** |
|---|---|---|
| 장점 | 날짜 범위 쿼리, 동기화 시 대량 이벤트 대비, 마이그레이션 체계 | 의존성·스키마·마이그레이션 0, 사람이 읽는 파일, Rust 측 공유 상태라 여러 창·Rust 루프가 같은 스토어 사용 |
| 단점 | SQL 레이어·마이그레이션 코드가 P1 데이터량(수백 행)에 과함 | 수천 건 이상·복잡 쿼리 시 한계, 전체 파일 재기록 |

**선택: B.** 키 설계는 **항목당 키 1개**(`todo:<id>`, `event:<id>`, `record:<id>`, 그 외 `dock.pinned`) — 배열 통째 덮어쓰기로 다른 창의 편집이 유실되는 문제를 없앤다. 무효화 근거: P1 데이터는 레코드 수십, 할일/일정 수백 건 → 키 접두사 스캔 + 메모리 내 필터로 충분. `ponytail:` 상한 = 외부 캘린더 동기화(수천 이벤트) 도입 시 SQLite로 이전. 연동 대비는 필드(`source: 'local'|'google'|'ms'`, `externalId?`)로만 한다 — 리포지토리 추상화 없음.

---

## 3. 계획 파일 구조 (최종 목표, 단계별로 생성)

```
D:\AI\hera\
  package.json, vite.config.ts, tsconfig.json, index.html
  src/
    main.tsx                 # ?surface=dock|island|panel|turntable|palette|all 로 표면 선택
    mockup/Desktop.tsx       # (A) surface=all: 가짜 바탕화면 + 모든 표면 + 데모 컨트롤(알림 발생, 테마 토글)
    surfaces/
      Dock.tsx               # 확대/바운스, 실행 인디케이터, (C) 위젯·선반 슬롯
      Island.tsx             # idle/preview/alert/nowPlaying 상태
      Panel.tsx              # 탭: Todo / Calendar / Library
      Turntable.tsx          # LP 크레이트 + 플래터 + 톤암
      Palette.tsx            # ⌘K
      Shelf.tsx              # 파일 선반 (A는 시안만, C에서 기능)
    data/
      types.ts               # Record, Todo, CalendarEvent, Notification, RunningSession
      api.ts                 # 단일 모듈: Tauri 있으면 invoke/store, 없으면 mock+localStorage. reportHitRects() 포함
      mock.ts                # 시안 시드 데이터
    styles/glass.css         # 색/블러/테두리 토큰, light/dark (B0 채택 기법 반영)
    styles/motion.css        # 이징·지속시간 토큰 (스프링 linear())
  src-tauri/
    tauri.conf.json          # 창 정의, 플러그인, asset protocol scope = appData/icons/**
    Cargo.toml
    src/lib.rs               # setup, 창 배치/스타일(TOOLWINDOW+NOACTIVATE, 글라스), 트레이, 커맨드 등록
    src/launch.rs            # launch(target), activate(hwnd) + target 분류 #[test]
    src/icons.rs             # 아이콘 추출(워커 스레드) → PNG 캐시
    src/watch.rs             # 단일 루프: 30Hz(커서 히트테스트·포그라운드) / 2s(EnumWindows·전체화면·알림 due·배경화면) + 알림 due #[test]
```

`api.ts` 의 Tauri/mock 분기는 `if` 하나다(인터페이스·DI 없음). 알림 스케줄러는 프런트엔드가 아닌 `watch.rs` 루프에 있다(숨김 웹뷰 타이머 스로틀 회피).

---

## 4. Stage A — 인터랙티브 글라스 시안 (+ B0 스파이크 후 게이트)

### A1. 프로젝트 골격 + 디자인 토큰
- 파일: `package.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/styles/glass.css`, `src/styles/motion.css`, `src/data/types.ts`, `src/data/mock.ts`, `src/data/api.ts`(mock 분기만)
- 글라스(잠정): CSS gradient/이미지 바탕화면 위 `backdrop-filter: blur() saturate()` + 반투명 틴트 + 1px 하이라이트 테두리. `prefers-color-scheme` + `[data-theme]` 토글. **B0 결과로 dock/island/panel 별 글라스를 교체**(A5 전, §B0 참조).
- 스프링 이징: `--ease-spring: linear(...)` 토큰 1~2개(island용 bouncy, panel용 smooth).
- **수락**: `npm run dev` → `http://localhost:5173/?surface=all` 에서 빈 데스크톱 + 테마 토글 동작, `tsc --noEmit` 통과.

### A2. 독 + 위젯/선반 + 라이브러리 패널
- 파일: `src/surfaces/Dock.tsx`, `src/surfaces/Shelf.tsx`, `src/surfaces/Panel.tsx`(Library 탭)
- 확대: `pointermove` → rAF 1회로 각 아이콘 `transform: scale()`/`translateY` 를 ref로 직접 갱신(React state 금지). 코사인/가우시안 거리 함수, 최대 배율 ~1.8. 독 컨테이너는 확대 여유를 포함한 **고정 크기**(실제 창 크기와 동일).
- 바운스: 클릭 시 WAAPI keyframes(translateY) 2~3회 감쇠, 실행 인디케이터 점 표시.
- 위젯(시계·배터리 모형), 파일 선반(드롭존 모형)을 독 안에 배치.
- 패널 열기/닫기: `transform: translateY + scale(0.96)` + `opacity`, 닫힐 때 `transitionend` 후 unmount.
- **수락**: 아이콘 위 좌우 이동 시 매끄러운 확대, 클릭 바운스, 라이브러리 패널 열기/닫기, 레코드 추가/삭제(mock).

### A3. Island + 할일/달력/알림 패널
- 파일: `src/surfaces/Island.tsx`, `src/surfaces/Panel.tsx`(Todo/Calendar 탭)
- 상태 4종: idle(알약) → preview(다음 일정/할일) → alert(알림 + 완료/다시 알림 버튼) → nowPlaying(앱명=곡명, 경과시간=진행바, 미니 LP 회전).
- 확장/축소: **창(=컨테이너)은 펼친 최대 크기 고정**, 상태별 크기는 고정 프리셋, 모양은 `clip-path: inset(... round r)` 또는 `transform: scale` 로 스프링 애니메이션(레이아웃·창 리사이즈 없음).
- 미니 LP 회전: 기본안 = 포그라운드 변화 없이 10초 지나면 회전 정지(Open Question 5, A5에서 결정).
- 데모 컨트롤: "알림 발생", "앱 전환(Now Playing 곡 변경)" 버튼.
- **수락**: 4상태 전환이 모두 스프링으로 동작, 할일/일정 추가 시 Island preview 갱신, 10초 무변화 시 미니 LP 정지(기본안).

### A4. LP 턴테이블 + 세트 + ⌘K
- 파일: `src/surfaces/Turntable.tsx`, `src/surfaces/Palette.tsx`
- 턴테이블 안에 레코드 크레이트(LP 슬리브 목록, 세트는 겹친 슬리브) — LP 드래그는 **턴테이블 창 안에서만** 가능한 레이아웃을 시안에서 확정.
- LP 드래그: Pointer Events + `setPointerCapture`, `transform: translate` 로 추종 → 플래터 근처 드롭 시 스냅(스프링) → 톤암 `rotate` 하강 → 플래터 `rotate` 무한 애니메이션, 시작 시 playbackRate 0→1 가속(WAAPI `playbackRate` 보간).
- 정지: 톤암 복귀 + 감속.
- ⌘K(시안은 Ctrl+K): 오버레이 팔레트, 레코드/할일 퍼지 검색(단순 `includes`/부분 일치, 라이브러리 없음).
- **수락**: 드래그→스냅→바늘→회전 가속 연속 동작, 세트 LP 드롭 시 여러 앱 "실행" 표시, Ctrl+K 열기/검색/Enter.

### B0. 플랫폼 스파이크 + 메모리 측정 (A4 후, **A5 게이트 전**, 타임박스 2일)
최소 Tauri 셸(`src-tauri/`, 창 dock/island/panel 이 `index.html?surface=...` 로 A2/A3 컴포넌트 로드)로 검증한다. 이 셸은 버리지 않고 B1이 이어받는다. 결과는 이 계획 §4 B0 아래에 항목당 1줄로 기록.

1. **dock/island 글라스** (순서대로 시도, 첫 합격안 채택):
   1. `window-vibrancy` `apply_blur`(ACCENT_ENABLE_BLURBEHIND) — 비활성 상태에서도 블러 유지, 창 뒤 실제 창들을 블러.
      - 판정: 창 이동 시 지연 없음, 고정 크기 창의 **투명 여유 영역에 블러/틴트가 비치지 않음**, NOACTIVATE 상태에서도 블러 유지.
   2. 배경화면 페이크 — `SystemParametersInfoW(SPI_GETDESKWALLPAPER)` 경로의 이미지를 웹뷰 안 정적 레이어로 깔고 `filter: blur()`(**`backdrop-filter` 아님**), 레이어 오프셋 = -창 위치. 배경화면 스타일은 "채우기(fill)"만 처리. 배경화면 경로는 watch 루프 2초 주기로 재확인. 단색/슬라이드쇼 배경화면 → 틴트 폴백.
      - **고지**: 이 방식은 창 뒤의 앱이 아니라 **배경화면**을 보여준다.
   3. 폴백: 반투명 틴트(노이즈 텍스처 없음).
2. **panel 글라스**: panel 창에만 OS 백드롭(Mica 또는 Acrylic, `window-vibrancy`) + 라운드 코너(`DWMWA_WINDOW_CORNER_PREFERENCE`). 판정: 포커스 상태에서 백드롭 정상, 이동 시 지연 없음.
3. **창 스타일 + 클릭 통과 + 포커스**:
   - dock/island 에 `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`. 판정: Alt+Tab 에 Hera 없음, 독 클릭 시 기존 포그라운드 앱 유지.
   - 클릭 통과: watch 루프(30Hz)가 `GetCursorPos` → JS 가 `reportHitRects(surface, rects)` 로 보고한 모양 rect 와 히트테스트 → 밖이면 `set_ignore_cursor_events(true)`, 안이면 `false`(상태 바뀔 때만 호출). 왼쪽 버튼이 눌린 채 창 밖에서 진입하면(외부 드래그) 클릭 통과 해제.
   - WebView2 자식이 포커스를 가져가면 루프가 감지해 직전 포그라운드 창으로 복원.
   - 판정: 독 투명 여유 영역 클릭이 아래 바탕화면 아이콘에 도달, 아이콘 위 hover/클릭 정상, 탐색기 파일 드래그가 독에 드롭됨.
4. **드래그 역할**: dock = Tauri 네이티브 드롭 핸들러(`onDragDropEvent`, 파일 경로). panel = `dragDropEnabled: false` + HTML5 드롭(`text/uri-list`, 브라우저 URL). URL 붙여넣기 입력은 폴백으로 유지. 판정: 각 창에서 해당 드롭 수신.
5. **메모리**: 릴리스 빌드, 창 3개 idle 10분, `hera.exe` + 하위 `msedgewebview2.exe` Private Working Set 합.
   - **결정 규칙**: ≤ 200MB → 그대로. > 200MB → ① panel 을 지연 생성(첫 열기 시 생성, 이후 hide 유지)으로 재측정, 그래도 초과 시 ② dock+island 를 웹뷰 1개로 병합(두 표면을 담는 투명 창 1개, 클릭 통과는 같은 폴러 + 두 표면의 rect 로 처리).
6. **스토어 변경 이벤트**: `tauri-plugin-store` 의 변경 이벤트(`onKeyChange`/`onChange`)가 다른 창의 쓰기를 전달하는지 확인. 전달되면 커스텀 `data-changed` 이벤트를 만들지 않는다. 안 되면 store 쓰기 후 `emit('data-changed', key)` 1줄.
- **B0 → 시안 반영**: 채택된 dock/island/panel 글라스 기법으로 `glass.css` 와 `Desktop.tsx` 바탕을 바꿔, 시안이 실제 출시 외형을 보여주게 한다(배경화면 페이크 채택 시 시안도 같은 `filter: blur()` 정적 레이어).
- **수락**: 6항목 각각 채택안 1줄 기록, 실제 사용자 데스크톱 위 글라스 독 스크린샷 1장, 메모리 수치 + 결정 규칙 적용 결과 기록.

#### B0 결과 (2026-11-13, 자율 진행 — 세션이 잠금 상태라 화면 캡처·실제 클릭·전체화면은 미검증, 아래 표시)
1. dock 글라스: **② 배경화면 페이크 채택.** ① `apply_blur` 는 창 rect 전체(960×178)를 블러 — DWM accent 블러에 영역 지정이 없고, `SetWindowRgn` 은 AA 없는 하드 클립 + 스프링 매 프레임 재설정이 필요해 기각(이론 판정 + 실행 확인, 잠금 화면 때문에 육안 비교는 못 함). ②는 `SPI_GETDESKWALLPAPER` 바이트를 JS 가 1/4 해상도 캔버스에 블러·채도를 **구워** 1회 그림(CSS filter/backdrop-filter 0, 상시 비용 0). 채우기·맞춤·늘이기 + EXIF 회전 + 여백 바탕색 처리, watch 2s 가 경로/배치 변경 시 `wallpaper` emit. 실패/단색 → ③ 틴트. island 는 짙은 판 그대로(블러 없음).
2. panel 글라스: `window_vibrancy::apply_acrylic` + `shadow(true)`(Win11 라운드 코너·그림자) + CSS 옅은 틴트. 알려진 차이: 패널 열기 애니메이션 중 Acrylic 백드롭은 창 전체에 즉시 보임(A5 확인 필요). 육안 확인 미완(잠금).
3. 창 스타일/클릭 통과/포커스: tao 가 show/hide·`set_ignore_cursor_events` 때 GWL_EXSTYLE 을 자기 플래그로 통째 재기록 → TOOLWINDOW 삭제·APPWINDOW 부활. 그래서 **watch 루프가 매 틱 원하는 ex-style(TOOLWINDOW|NOACTIVATE, ±TRANSPARENT|LAYERED, −APPWINDOW)을 계산해 다를 때만 `SetWindowLongPtrW`** — `set_ignore_cursor_events` 는 쓰지 않음(같은 비트). NOACTIVATE 는 `focusable(false)` 로 tao 플래그에도 둠. panel 은 dock 소유 창(`parent`) → Alt+Tab 제외. 검증: 커서 위치별 TRANSPARENT 비트 7지점 모두 기대값(점 위만 dock 불투과, 섬 위만 island 불투과). WindowFromPoint 는 LockApp 이 최상위라 잠금 중 측정 불가 → `.omc/verify/clickthru.ps1` 로 잠금 해제 후 재확인.
4. 드래그 역할: 미착수(B2). 외부 드래그 진입 시 클릭 통과 해제 로직만 구현(실제 탐색기 드롭 미검증).
5. 메모리(릴리스, 창 2개 dock+island, 패널 없음, 독 접힘, idle 2.5분): **64.8MB** Private WS 합(hera 10.8 + WebView2 browser 13.9 + crashpad 10.5 + gpu 4.5 + utility 3.4/1.1 + renderer 10.8/9.8, 8프로세스) ≤150MB 통과. 시작 10초 시점 172.5MB(gpu 49.6, browser 44.8) → idle 후 트림. `MemoryUsageTargetLevel=Low` 는 `with_webview` → `ICoreWebView2_19` 로 dock/island 에 상시 적용(접힘 여부 무관). ⚠ 세션 잠금(창 가려짐) 중 측정이라 언락 상태 수치는 더 높을 수 있음 — Low 효과와 가림 트림 분리 못 함. 결정 규칙: 발동 안 함(panel 지연 생성+파괴는 기본값으로 구현).
6. 스토어 이벤트: **플러그인 이벤트 채택, 커스텀 `data-changed` 없음** (B2에서 판정, 2026-11-13). tauri-plugin-store 2.5.1은 스토어를 앱 단위 `resources_table`에 둔다(같은 경로 = 같은 rid, 모든 창이 공유). 쓰기마다 `app.emit("store://change", {resourceId,key,value})`를 보내고, 다른 창의 `store.onChange`가 그것을 받는다. 실측: panel 창에서 `record:e2e`를 set하자 dock 창의 독에 즉시 표시됐다.
- 스크린샷: `.omc/mockup-shots/30-real-composite-dock-open.png`, `30-real-composite-dot.png` — **합성본**: 실제 배경화면(맞춤·EXIF 회전) 위에 실제 실행 중인 앱 창 렌더(CDP 캡처, 알파 유지)를 실제 창 위치(dock 480,854 / island 740,0)에 얹음. 화면이 잠겨 CopyFromScreen 은 잠금 화면만 찍힘. 언락 후 실캡처 필요.
- idle CPU(hera.exe, 60초): 0.16% of 1코어(20 논리코어 기준 0.008%).

### A5. 승인 게이트 (게이트 시트 1장)
게이트 시트 `.omc/plans/hera-a5-gate.md` (한 화면 분량)를 만들어 사용자에게 시안 URL/실행 방법과 함께 제시:
- 7개 구성요소 체크리스트 + 4종 애니메이션 측정치(§7 기준: 16.7ms 이하 프레임 %, long task 수)
- B0 스크린샷: 실제 사용자 데스크톱 위 실제 글라스 독
- 시안과의 알려진 차이: 글라스가 보여주는 것(blur-behind = 뒤 창 / 배경화면 페이크 = 배경화면만 / 틴트), LP 드래그는 턴테이블 창 안에서만, Island 크기는 고정 프리셋
- 답해야 할 질문: §11 Open Questions 1, 2, 4, 5
- **게이트**: 사용자 메시지에 "디자인 OK"(또는 동등한 명시적 승인)가 있어야 Stage B 시작. **부분 OK 허용**: P1 표면(독/Island/패널/라이브러리)이 승인되면 Stage B 시작, LP 턴테이블/⌘K 수정은 A4 에서 병행(Stage C 전 승인 필요). 수정 요청은 A2~A4 반복.

---

## 5. Stage B — Dev P1 (Tauri 2)

### B1. Tauri 셸 골격 (B0 셸 확장)
- 파일: `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/src/watch.rs`
- 창 3개(dock/island/panel): `transparent`, `decorations:false`, `alwaysOnTop`(panel 제외 가능), `skipTaskbar`, `shadow:false`; dock/island 는 최대 크기 고정 + `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`, panel 만 OS 백드롭·포커스 허용(B0 채택안).
- 배치: 주 모니터 **work area** 기준(작업표시줄 위), 논리 픽셀, `ScaleFactorChanged`/모니터 변경 시 재배치.
- 트레이 아이콘(열기/종료) — `skipTaskbar` 라 종료 경로가 필수. `tauri-plugin-single-instance`, `tauri-plugin-autostart`.
- `watch.rs` 단일 루프(스레드 1개, 별도 메시지 루프·훅 없음):
  - **30Hz**: 커서 히트테스트 → `set_ignore_cursor_events`(B0-3), `GetForegroundWindow` 변화 감지(자기 창 무시, WebView2 포커스 탈취 시 복원) → `foreground` 이벤트 emit.
  - **2s**: `EnumWindows` 실행 집합, 전체화면 판정, 알림 due-check(B4), 배경화면 재확인(B0-1 ②채택 시).
- 전체화면: `SHQueryUserNotificationState` 만 사용 — `QUNS_BUSY`, `QUNS_RUNNING_D3D_FULL_SCREEN`, `QUNS_PRESENTATION_MODE` 이면 dock/island 숨김. 창 rect 비교 안 함(Progman/WorkerW 바탕화면 창이 오탐).
- **수락**: `npm run tauri dev` 시 3개 창이 올바른 위치, 독 클릭이 포커스를 빼앗지 않음, **독 투명 여유 영역 클릭이 아래 바탕화면 아이콘에 도달**, **Alt+Tab 에 Hera 없음**, 영상 전체화면 시 숨김·종료 시 복귀, 재부팅 후 자동 시작, 트레이로 종료 가능.

#### B1 결과 (2026-11-13)
- 구성: `src-tauri/` (tauri 2.12, single-instance, autostart, window-vibrancy 0.8, webview2-com 0.39, windows 0.62 최소 feature). Rust 모듈 lib.rs + watch.rs. 창은 conf 가 아닌 Rust 에서 생성(work area 계산), URL `index.html?surface=…`. store/opener 는 미사용이라 미추가(B2).
- 배치(1920×1080, 100%, work area 하단 1032): dock (480,854) 960×178, island (740,0) 440×144, panel (작업 영역 우하단) 384×540 + DWM 그림자 테두리. 작업 영역 변경은 watch 2s, DPI 변경은 `ScaleFactorChanged` 로 `place()`.
- panel: 첫 열기에 생성, 다시 토글하면 `panel-close` → JS 닫힘 애니메이션 → `close_panel` 로 destroy. 창 수 2→3→2 확인.
- Alt+Tab: Hera 창 0개(ex-style 필터: dock/island TOOLWINDOW|NOACTIVATE, APPWINDOW 없음; panel 은 소유 창).
- 전체화면: `SHQueryUserNotificationState` BUSY/D3D/PRESENTATION → `ShowWindowAsync` 숨김/표시. 판정 함수 `#[test]` 만, 실제 전체화면 테스트는 잠금 때문에 미실시.
- 포그라운드: 자기 프로세스 창 무시, dock/island(루트 기준)가 포그라운드가 되면 직전 외부 창으로 `SetForegroundWindow`. 실제 동작 미검증(잠금).
- 트레이: 패널 열기 / 로그인 시 자동 시작(체크, **기본 꺼짐**, 사용자가 켤 때만 레지스트리 등록) / 종료. single-instance 재실행 시 패널 열기.
- dev: `beforeDevCommand: npm run dev:tauri` — :5173 에 이미 서버가 있으면 즉시 종료(0), 없으면 vite 기동. devUrl http://localhost:5173.
- 검증: `cargo build` OK, `cargo test` 3/3(hit_test, ex_style, fullscreen_states), `cargo clippy -- -D warnings` 0, `npx tsc --noEmit` OK, `npm run tauri build -- --no-bundle` OK(hera.exe 3.4MB).
- 재검증 스크립트: `.omc/verify/{inspect,styles-at,clickthru,mem}.ps1`. B2/B3 수동 확인은 `.omc/verify/b2b3-manual.ps1` — 잠금 해제 후 실행하는 8단계 체크리스트(확대 아이콘 윗부분 클릭, 실행 앱 전면 표시, Now Playing, 드롭, 패널 점, 오류 alert, DPI 변경).

### B2. 실행 + 아이콘 + 레코드 라이브러리
- 파일: `src-tauri/src/launch.rs`, `src-tauri/src/icons.rs`, `src/data/api.ts`(Tauri 분기), `src/surfaces/Dock.tsx`, `src/surfaces/Panel.tsx`
- `launch(target)`: `AllowSetForegroundWindow(ASFW_ANY)` 후 `ShellExecuteW` — `.exe`/`.lnk`/URL 직접, UWP → `shell:AppsFolder\<AUMID>`. (Win11 계산기·메모장은 UWP: `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`, `Microsoft.WindowsNotepad_8wekyb3d8bbwe!App` 기본 레코드로 시드.) NOACTIVATE 창에서 실행해도 새 앱이 전면에 뜨게 하기 위함. 실패 시 에러 문자열 반환 → Island 알림.
- 앱 목록 선택 UI: PowerShell `Get-StartApps` 1회 실행 결과(이름+AUMID) 를 패널에서 검색해 추가.
- `extract_icon(path|aumid)`: 워커 스레드에서 `CoInitializeEx` → `IShellItemImageFactory::GetImage(256px, SIIGBF_ICONONLY)` → HBITMAP(premultiplied BGRA) → **알파 un-premultiply** → PNG(`image` crate png 기능만) → `appData/icons/<hash>.png`. 표시는 `convertFileSrc` + **asset protocol (scope `appData/icons/**`만)** — base64 전달 안 함. URL 레코드는 `<img src="https://host/favicon.ico">` + 실패 시 커버 컬러 이니셜.
- 드롭: dock = 네이티브 핸들러(.exe/.lnk 파일), panel = HTML5(URL), 붙여넣기 폴백(B0-4).
- 저장: `tauri-plugin-store` `hera.json`, 항목당 키(`record:<id>`, `dock.pinned`). 다른 창 갱신은 B0-6 결정안(플러그인 이벤트 우선).
- **수락**: 탐색기에서 **독으로** .exe/.lnk 드래그 등록(클릭 통과 폴러가 드래그 중 해제), 시작 메뉴 앱 목록에서 UWP 추가, 브라우저 URL 을 패널로 드래그 등록(또는 붙여넣기); 재시작 후 유지; 아이콘 가장자리에 검은/흰 테두리 없음(알파 정상); 계산기 클릭→실행 요청 p95 < 300ms, 실행된 앱이 전면에 뜸(§7 측정법).

#### B2 결과 (2026-11-13, 세션 잠금 상태 — 클릭·육안 확인은 `.omc/verify/b2b3-manual.ps1`로 미룸)
- 구성: `launch.rs`(launch, target 분류 `#[test]`, `start_apps`, 지연 벤치 `#[ignore]`), `icons.rs`(추출, un-premultiply `#[test]`, 샘플 `#[ignore]`). Rust 모듈은 lib/launch/icons/watch 4개. 추가한 의존성: tauri-plugin-store, serde(+json), png, tauri `protocol-asset`. png는 image crate 대신 단독으로 썼다(더 작음).
- 실행: `AllowSetForegroundWindow(ASFW_ANY)` 후 `ShellExecuteExW`(`SEE_MASK_FLAG_NO_UI|NOASYNC`)를 호출한다. **편차**: 계획의 `ShellExecuteW` 대신 Ex 버전을 썼다. 오버레이에서 모달 오류 창이 뜨지 않게 하기 위해서다(오류는 문자열로 돌려 Island alert로 보여준다). spawn_blocking 스레드에서 STA로 실행한다.
- 분류: `shell:AppsFolder\…`와 맨 AUMID → AUMID. `scheme:`(scheme 2글자 이상) → URL(https, mailto, ms-settings 등). 그 외 → 경로이며, 파일이 없으면 "파일이 없어요"를 반환한다.
- 실행 지연(릴리스 빌드, `cargo test --release launch_latency -- --ignored`, 함수 호출부터 반환까지, 대상별 20회, 매회 창 종료):

  | 대상 | p50 | p95 | 판정(<300ms) |
  |---|---|---|---|
  | 계산기(AUMID) | 77.7ms | 93.6ms | 통과 |
  | charmap.exe | 29.6ms | 66.3ms | 통과 |
  | URL `ms-calculator:` | 346.9ms | 376.3ms | **실패** |

  - NOASYNC를 빼도 URL p95는 425ms로 나아지지 않았다. 지연은 패키지 앱 프로토콜 활성화 자체에서 생긴다.
  - 실제 IPC 경로(릴리스 앱 dock 웹뷰에서 `invoke('launch')`, 계산기 5회): 224ms(콜드)/49/56/46/46ms.
  - **측정 못 한 것(편차)**: 메모장은 사용자 메모장이 열려 있어 제외했다. 새로 실행하면 사용자 창에 탭이 추가된다(계산기와 같은 AUMID 경로라 그 수치로 갈음). https URL도 제외했다. 기본 브라우저(Chrome)가 사용자 세션으로 떠 있어 탭이 남기 때문이다. 대신 `ms-calculator:`로 URL 프로토콜 경로를 쟀다. https는 chrome.exe 실행이라 .exe 수치에 가까울 것으로 추정하지만 검증하지 않았다.
- 아이콘: 워커 스레드(spawn_blocking)에서 `CoInitializeEx(STA)` → `SHCreateItemFromParsingName` → `IShellItemImageFactory::GetImage(256, SIIGBF_ICONONLY)` → `GetDIBits`(top-down 32bpp) → un-premultiply → `appData/icons/<hash>.png`(tmp에 쓴 뒤 rename) 순서로 처리한다.
  - un-premultiply는 모든 픽셀이 c≤a일 때만 한다. 알파가 전부 0이면 불투명으로 본다.
  - 표시는 `convertFileSrc` + asset protocol이며 scope는 `$APPDATA/icons/**`뿐이다. URL 레코드는 `origin/favicon.ico`를 쓰고, 실패하면 커버 컬러 이니셜이나 글리프로 돌아간다.
  - 샘플: 계산기·메모장(AUMID), Code.exe, notepad++.exe, Beyond Compare 5.lnk, Ahk2Exe.lnk. 추출에 76~488ms가 걸렸다(첫 COM 초기화 포함).
  - 알파 검사: 밝은 불투명 이웃을 둔 반투명 가장자리 픽셀 1,367개 중 RGB 평균이 40 미만인 것은 1개(Ahk2Exe, 소형 아이콘)였다. 검은 테두리는 없다. 연락처 시트: `.omc/mockup-shots/40-icons-contact-sheet.png`(흰/검/파랑 배경).
  - 릴리스 앱 실측: 독의 계산기·메모장은 256px PNG(`asset.localhost`), GitHub는 32px favicon으로 표시된다.
- 앱 목록: `Get-StartApps | ConvertTo-Json`을 한 번 실행해 306개를 받는다(Rust `OnceLock` 캐시, CREATE_NO_WINDOW).
  - `{KNOWNFOLDER}\x.exe` 형태 AppID는 실제 exe 경로로 바꾼다(예: Notepad++ → `C:\Program Files\Notepad++\notepad++.exe`). 그래야 아이콘과 실행 인디케이터가 exe로 매칭된다. 나머지는 `shell:AppsFolder\<AppID>`로 둔다.
  - UI: 패널 라이브러리 탭의 "시작 메뉴에서 앱 추가…"를 누르면 검색 목록(상위 30개)이 열린다.
- 드롭: dock은 `getCurrentWebview().onDragDropEvent` drop에서 .exe/.lnk만 받아 레코드를 만들고 독에 고정한다. panel은 `disable_drag_drop_handler()` + HTML5 `text/uri-list`(http/https)로 받는다. 붙여넣기 폼(이름은 선택 입력)도 유지했다. 실제 탐색기/브라우저 드롭은 잠금 때문에 검증하지 못했다.
- 저장: `hera.json`에 `record:<id>`, `todo:<id>`, `event:<id>`, `dock.pinned`(독 순서), `seeded` 키를 둔다.
  - 첫 실행 시드는 **Rust setup에서 한 번** 한다. 창들이 동시에 시드하는 경쟁을 없애기 위해서다. 시드 내용: 계산기·메모장(AUMID), GitHub(URL). 할 일/일정 시드는 없다.
  - `useItems(prefix)`는 이전 배열과 다음 배열을 비교해 바뀐 키만 set/delete한다(배열 통째 쓰기 없음).
  - 라이브러리 행의 ★ 버튼이 독 고정을 켜고 끈다.
  - 시안(브라우저)은 localStorage를 그대로 쓴다. `?surface=all`은 정상이다(레코드 7개, 피커 숨김, 콘솔 오류 0).
- 이전 단계 위험 처리:
  1. 펼친 독의 히트 rect = 바 폭 + 120px(확대 시 좌우로 늘어나는 최대치) × 높이 112px(바 72 + 확대 아이콘 52×1.8). 실측: hit top 58px가 확대 아이콘 top 66px보다 위에 있다.
  2. api.ts가 마지막 rect(CSS px)를 기억해 두고, `matchMedia('(resolution: Ndppx)')` change가 오면 새 DPR로 다시 보낸다. 처리는 이 한 곳에서 한다.
  3. localStorage 공유를 없애고 스토어로 바꿨다. panel 창을 생성/파괴할 때 Rust가 `panel-state`(bool)를 emit하고, 늦게 뜬 창은 `panel_open`으로 조회한다. 실측: 패널을 열면 독의 패널 점이 true, 닫으면(창 파괴) false가 된다.
- 실행 오류는 `emit('hera-alert')`로 island 창의 alert에 띄운다. 실측: island mode=alert에 제목이 표시됐다. 없는 경로를 launch하면 "파일이 없어요: C:\nope\x.exe"를 반환한다.

### B3. 실행 상태 + Now Playing
- 파일: `src-tauri/src/watch.rs`, `src/surfaces/Island.tsx`, `src/surfaces/Dock.tsx`
- 포그라운드: B1 루프의 30Hz `GetForegroundWindow` 변화 → `{hwnd, pid, exePath, title}` emit. UWP 는 `ApplicationFrameHost.exe` 이므로 창의 AUMID(`SHGetPropertyStoreForWindow` PKEY_AppUserModel_ID)로 해석.
- 실행 인디케이터: 루프 2s `EnumWindows`(보이는 최상위 창) → 실행 중 exe/AUMID 집합 emit. `ponytail:` 폴링 2s, 지연이 거슬리면 주기 단축.
- Now Playing: 포그라운드 앱 = 곡명, 경과 = 현재 앱이 포그라운드가 된 연속 시간(정의는 Open Question 1), 레코드면 커버/아이콘 표시. 미니 LP 회전 정책은 A5 결정(Open Question 5, 기본 10초 무변화 시 정지).
- **수락**: 앱 전환 후 ≤ 200ms 안에 Island 곡명 변경, 독 인디케이터가 실행/종료를 ≤ 2.5s 안에 반영, idle CPU 기준(§7) 충족.

#### B3 결과 (2026-11-13)
- 포그라운드: 30Hz 루프에서 포그라운드 창이 바뀌면 `foreground` `{hwnd,pid,exePath,title,aumid}`를 emit한다. 자기 창과 **제목 없는 창**(작업표시줄 등 일시 포커스)은 제외한다.
  - AUMID: 먼저 창의 `SHGetPropertyStoreForWindow` → `PKEY_AppUserModel_ID`를 보고, 없으면 프로세스의 `GetApplicationUserModelId`를 쓴다(패키지 앱). Win11 메모장은 ApplicationFrameHost가 아니라 Notepad.exe라서 두 번째 경로로 풀린다.
  - watch 스레드는 `COINIT_MULTITHREADED`로 초기화한다.
- 실행 집합: 2초마다 `EnumWindows`를 돈다. 대상 창 조건: 보임, 클로킹 아님, 소유자 없음, TOOLWINDOW 아님, 제목 있음, 자기 프로세스 아님. 여기서 exe 경로와 `shell:appsfolder\<aumid>`(소문자)를 모아 집합이 바뀔 때만 `running`을 emit한다. 레코드는 `target.toLowerCase()`가 일치하면 실행 중으로 본다. `ponytail:` 2s 폴링.
- 늦게 뜬 창(패널 등)은 `watch_state` 커맨드로 마지막 포그라운드와 실행 집합을 바로 가져간다.
- Now Playing:
  - 곡명: 레코드 제목 → 창 제목의 마지막 " - " 조각(대부분 앱 이름) → exe 이름 순서로 고른다.
  - 경과 시간: 같은 앱(aumid 또는 exePath)이 연속으로 포그라운드에 있던 시간이다. 같은 앱 안에서 창만 바뀌면 이어서 센다(Open Question 1 기본안).
  - 아이콘: 레코드 아이콘, 없으면 exe/AUMID에서 추출한 아이콘.
  - 미니 LP: 곡이 바뀐 뒤 10초 회전하고 멈춘다. effect 의존성을 `[startedAt,title]`로 둬서 렌더마다 다시 돌지 않게 했다.
- 검증(`cargo test running_and_aumid -- --ignored`: 계산기 실행 → 3초 대기 → 종료):
  - 실행 집합에 `shell:appsfolder\microsoft.windowscalculator_8wekyb3d8bbwe!app`과 `…windowsnotepad…!app`(사용자 메모장)이 들어 있다 — 통과.
  - 계산기 ApplicationFrameHost 창의 `info()` 결과가 `aumid: Microsoft.WindowsCalculator_8wekyb3d8bbwe!App, title: 계산기`다 — 통과.
  - 릴리스 앱: 계산기를 실행하면 독 점이 true, taskkill 후 3초 안에 false가 된다 — 통과.
  - 메모장은 사용자 것이 이미 떠 있어서 새로 실행하지 않았다.
  - 실제 포그라운드 전환(200ms 안에 Island 갱신)은 검증하지 못했다. 잠금 상태에서는 GetForegroundWindow가 잠금 화면을 돌려주기 때문이다(`b2b3-manual.ps1` 3번).
- 메모리(릴리스, dock+island, 패널 닫힘, 독 접힘, idle 160초): Private WS 합 **67.3MB** ≤150MB — 통과.
  - 내역: hera 11.2, browser 13.2, crashpad 10.5, gpu 4.3, utility 3.6/1.1, renderer 12.3/11.1 MB.
  - B0의 64.8MB보다 2.5MB 늘었다.
  - idle CPU(hera.exe, 30초 평균): 1코어 기준 0.16% — 통과.
  - ⚠ 잠금 세션에서 잰 수치다.
- 빌드/검사: `cargo build`, `cargo test`(6개 통과, 수동 `#[ignore]` 3개), `cargo clippy -- -D warnings`(경고 0), `npx tsc --noEmit`, `npm run build`, `npm run tauri build -- --no-bundle`(hera.exe 3.8MB) 모두 통과했다.

### B4. 할일/달력/알림
- 파일: `src/surfaces/Panel.tsx`, `src/surfaces/Island.tsx`, `src-tauri/src/watch.rs`
- Todo: `{id,title,due?,done,source,externalId?}` → 키 `todo:<id>`, Event: `{id,title,start,end,source,externalId?}` → 키 `event:<id>`. 달력은 월 그리드 + 날짜 클릭 시 일정 목록(`<input type="datetime-local">`, 피커 라이브러리 없음).
- 알림 due-check 는 **Rust 루프(2s)** 에서: store 의 `todo:*`/`event:*` 스캔 → due 도달·미발화 항목 `alarm` 이벤트 emit → island alert. 절전 복귀 후 놓친 알림은 1회 표시. 완료 → done, 다시 알림 → +10분. due 판정은 순수 함수(`due_alarms(now, items, fired)`)로 분리해 `#[test]`.
- **전체화면 중 알림**: 기본 = 큐에 보관, 전체화면 종료(QUNS 정상 복귀) 시 순서대로 표시.
- **수락**: 2분 뒤 할일 생성 → 정시(±3s)에 Island alert 확장, 버튼 2개 동작; panel 이 숨김 상태여도 정시 발화; 전체화면 영상 재생 중 due 된 알림이 전체화면 종료 직후 표시; 앱 재시작 후 데이터·미래 알림 유지; 두 창에서 서로 다른 할일을 연달아 편집해도 유실 없음.

#### B4 결과 (2026-11-13, 세션 잠금 — 육안·전체화면·트레이 클릭은 `.omc/verify/b4b5-manual.ps1`로 미룸)
- UI: Stage A의 패널(할 일 목록, 달력 월 그리드 + 날짜 클릭 일정 목록, `datetime-local`)을 그대로 쓴다. 저장은 기존 `useItems('todo'|'event')`(항목당 키)다. 새 필드는 `snooze?`(다시 알림 시각) 하나다.
- 알림(Rust `watch.rs`, 2s 블록):
  - `check_alarms`가 store의 `todo:*`/`event:*`를 스캔한다. 발화 시각 = `snooze ?? due`(할 일) / `snooze ?? start`(일정). `toISOString()` UTC 형식만 파싱하며 의존성은 없다(days_from_civil).
  - 순수 함수 `due_alarms(now, items, fired)` = 시각 도달 + 미완료 + 미발화를 시각 순으로 돌려준다. 발화 키는 `<key>@<epoch ms>`다. 다시 알림이나 기한 수정으로 시각이 바뀌면 새 키가 되어 다시 울린다.
  - 발화 집합은 store `alarm.fired`에 둔다(재시작 시 재발화 없음). 시각이 바뀌거나 삭제된 항목의 키는 매 검사 때 정리해 크기가 항목 수를 넘지 않는다.
  - 놓친 알림(절전·앱 종료 중)은 같은 규칙으로 1회 나온다. **결정**: 놓친 알림에 기간 제한을 두지 않는다(오래된 미완료 할 일도 1회 알림).
  - `#[test]` 3개: `iso_parse`, `alarm_items`(snooze 우선, 기한 없음/레코드 제외), `due_rules`(놓친·이미 발화·완료·미래·snooze 전/후·정각 경계).
  - 전체화면(QUNS) 중에는 검사를 건너뛴다. 이것이 곧 큐다: 종료 후 첫 검사에서 밀린 알림이 시각 순으로 나온다(별도 큐 자료구조 없음).
  - 시작 직후 이벤트 유실 방지: island JS가 `alarm` 리스너를 건 뒤 `alarms_ready`를 호출해야 검사를 시작한다.
- Island:
  - 알림은 큐(`alerts[]`)로 앞에서부터 1개씩 보여 준다. 같은 키는 중복으로 넣지 않는다.
  - '완료'는 할 일을 done으로 바꾸고, 일정은 닫기만 한다. '10분 뒤 다시'는 `snooze = now+10m`이다. 시안도 같은 경로를 쓴다.
  - **수정**: '추가' 미리보기가 패널 창 안에서만 돌던 문제를 고쳤다. 이제 island 창이 `store.onChange`로 처음 보는 `todo:`/`event:` id를 감지하면 펼친다. '다음 항목'은 같은 store 이벤트로 다시 렌더된다.
- 저장 flush: 트레이 '종료'는 `store.save()` 후 `exit`한다(디바운스 100ms 대기분 즉시 기록). 플러그인도 `RunEvent::Exit`에서 저장한다.
- 자동 검증 `node .omc/verify/b4-alarms.mjs`(릴리스 + CDP, hera.json 백업/복원): **10/10 PASS**.
  - 종료 중 놓친 알림 1회 표시 → 완료 → store done
  - 다른 창 쓰기 → island preview
  - due+1.5s 할 일 → 3.4s 만에 alert(2s 틱)
  - 다시 알림 → snooze +10분
  - 일정 시작 알림
  - 발화 집합 저장(스누즈된 키 정리)
  - 재시작 후 재발화 없음
- 미검증(잠금): 정시 ±3s 육안, 실제 전체화면 큐, 트레이 종료 클릭 flush(코드 경로만, 강제 종료 테스트는 디바운스 후 디스크 기록만 확인).

### B5. 실앱 성능·메모리 검증
- 릴리스 빌드(`npm run tauri build`)에서 §7 B 기준 측정, 결과를 이 계획에 기록. 메모리 초과 시 B0-5 결정 규칙 적용. 실패 항목만 수정.

#### B5 결과 (2026-11-13, 릴리스 `npm run tauri build -- --no-bundle`, hera.exe 3.8MB, 세션 잠금 상태)
- 측정 스크립트: `node .omc/verify/b5-perf.mjs frames idle cycles soak`. CDP(`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`)로 릴리스 웹뷰를 조작한다. 앱 코드에 디버그 경로를 추가하지 않았다(env를 줄 때만 열림). hera.json은 백업 후 복원한다. 메모리는 `mem.ps1`(Private WS 트리 합)으로 쟀다.
- **메모리**:

  | 항목 | 수치 | 기준 |
  |---|---|---|
  | idle 3분(패널 닫힘·독 접힘, CDP 없음) | **67.6MB** (1/2/3분 63.8/67.8/67.7) | ≤150MB 통과 |
  | 패널 열림(CDP, 15초 후) | **121.9MB** (기준선 63.0) | 참고치 |
  | 패널 열고 닫기 20회 직후 / +60초 | **128.7MB → 50.1MB** | 기준선 63.0 이하로 복귀, 누수 없음 |

- **idle CPU(60초, CDP 없음)**: Hera 트리 전체(hera + WebView2 자식) **0.10% / 1코어**, hera.exe 0.10%(20 논리코어). <1% 통과. ⚠ 잠금 세션이라 웹뷰 렌더가 가려진 상태다.
- **10분 soak**(CDP): 30초마다 알림 1건 발화 후 완료(20/20 표시), store 쓰기 10건, 5회마다 soak 키 일괄 삭제, 패널 열고 닫기를 반복했다.
  - 30초 표본: 54.7, 105.2, 53.9, 92.4, 58.4, 94.5, 51.0, 91.9, 53.3, 99.9, 106.8, 117.0, 51.6, 98.6, 103.7, 53.0, 98.6, 118.3, 51.4, 102.2MB.
  - 값은 두 갈래다. 표본 시각이 '패널 파괴 후 렌더러 회수 전'(~92–118)이냐 '회수 후'(~51–58)이냐에 따라 갈린다.
  - **바닥선 54.7 → 51.4MB(−6%)**, 상단선 105.2 → 102.2MB(최대 118.3MB, +12%)로 둘 다 ≤20% 증가라 통과. 스크립트가 낸 첫 표본 대비 마지막 표본 "86.8%"는 이 두 갈래 표본 때문에 생긴 착시다.
  - 1시간 안정성은 미실시(이 10분 soak로 대체).
- **실행 지연**: `cargo test --release launch_latency -- --ignored`, 함수 호출부터 반환까지, 대상별 20회, 매회 창 종료. 변경점: `SEE_MASK_NOASYNC` → `SEE_MASK_ASYNCOK`(활성화를 셸 백그라운드에 넘기고 즉시 반환). 동기 오류는 사전 확인으로 유지한다. 경로는 존재 확인, AUMID는 `SHCreateItemFromParsingName`, URL은 HKCR scheme 등록 여부를 본다. `#[test]`: 없는 scheme/AUMID는 창 없이 오류를 돌려준다.

  | 대상 | p50 | p95 | 이전 p95 | 판정(<300ms) |
  |---|---|---|---|---|
  | 계산기(AUMID) | 49.8ms | 56.7ms | 93.6ms | 통과 |
  | charmap.exe | 0.6ms | 2.7ms | 66.3ms | 통과 |
  | URL `ms-calculator:` | 0.7ms | 9.2ms | **376.3ms** | **통과** |

  - 실 IPC(릴리스 dock 웹뷰 `invoke('launch')`)로 `ms-calculator:`를 열면 2.8ms에 반환되고 계산기가 실제로 뜬다(확인 후 종료). `nohandler-xyz:1`은 "이 주소를 열 앱이 없어요"를 돌려준다.
  - 남는 지연 ~50ms는 AUMID 사전 확인 비용이다.
  - **트레이드오프**: 셸 활성화 단계의 비동기 실패(패키지 손상 등)는 더 이상 Island 오류로 오지 않는다.
- **프레임**(릴리스 웹뷰 rAF 간격 + longtask 옵저버, CDP 마우스 이벤트):

  | 애니메이션 | 결과 |
  |---|---|
  | 점→독 펼침+확대 스윕 | 92프레임, 100% ≤17.5ms, 최대 16.8ms, long task 0 |
  | 독 접힘 | 73프레임, 100%, 최대 16.8ms, long task 0 |
  | Island idle→alert ×3 | 182/181/181프레임, 100%, 최대 16.9ms, long task 0 |
  | Island alert→idle ×3 | 61프레임씩, 100%, 최대 16.8ms, long task 0 |

  - 패널 열기는 창 생성 직후 애니메이션이라 CDP 연결 전에 끝나서 미측정이다.
  - 잠금 세션이라 DWM 실제 표시와 Layout/Style 프레임 분석(DevTools Performance)은 못 했다. → `b4b5-manual.ps1` 7번.
- **.lnk 실행 점**: 레코드 추가 시 `.lnk`이면 `lnk_target`(IShellLinkW → `GetPath`)으로 대상 exe를 `exe` 필드에 저장한다. 실행 점과 Now Playing은 `exe ?? target`으로 매칭한다. `cargo test lnk_targets -- --ignored`: 시작 메뉴 .lnk가 exe 경로로 풀린다(Chrome, Edge, Excel, BCompare 등). 기존에 저장된 .lnk 레코드는 다시 추가해야 반영된다.
- 검증: `cargo build`, `cargo test`(8 통과, 수동 `#[ignore]` 4), `cargo clippy -- -D warnings`, `npx tsc --noEmit`, `npm run build` 모두 통과. 시안 `?surface=all`은 콘솔 오류가 favicon 404 하나뿐이고, 알림 큐·완료(done)·다시 알림(snooze)이 mock(localStorage)에서 동작한다.
- 수동 확인(잠금 해제 후): `.omc/verify/b4b5-manual.ps1`(8단계). 게이트 시트: `.omc/plans/hera-a5-gate.md`.

---

## 6. Stage C — Dev P2

### C1. 턴테이블 창
- `turntable` 플로팅 창(드래그 이동 가능, 위치 저장). LP 드래그는 **창 내부 크레이트 → 플래터** 로 한정(창 간 드래그 없음). 독에서 레코드 우클릭 "턴테이블에 올리기"로 보조.
- 드롭 → `launch` → `watch` 의 실행 집합에 해당 앱이 있는 동안 회전, 사라지면 톤암 복귀/정지. UWP 는 PID 를 얻기 위해 `IApplicationActivationManager::ActivateApplication` 사용을 검토(`shell:AppsFolder` 는 PID 를 주지 않음).
- 플래터 클릭 → `activate(hwnd)`(`SetForegroundWindow` 제한 회피: 사용자 입력 직후 호출 + `ShowWindow(SW_RESTORE)`, 필요 시 Alt 키 트릭).
- **수락**: 드롭→실행→회전, 앱 종료 ≤ 2.5s 내 정지, 클릭 시 해당 창 전면.

### C2. LP 세트
- Record `kind:'set'`, `targets[]` 순차 launch. 회전 = 세트 중 하나라도 살아있으면 유지.
- **수락**: 3개 앱 세트 드롭 시 모두 실행, 모두 종료 시 정지.

### C3. ⌘K 팔레트
- `palette` 창 + `tauri-plugin-global-shortcut`. Windows 에서 Win+K 는 OS 예약 → 기본 `Ctrl+Alt+K` 상수(Open Question 2).
- 검색 대상: 레코드·할일·Start 앱 목록, Enter=실행/열기, Esc=숨김.
- **수락**: 어느 앱에서든 단축키 → 팔레트 표시 < 150ms, 입력→결과 즉시.

### C4. 독 위젯 + 파일 선반
- 위젯: 시계(JS), 배터리(`GetSystemPowerStatus` 커맨드 1개). 그 외 위젯 YAGNI.
- 선반: 독 네이티브 드롭 → 경로 키 저장, 클릭 시 탐색기에서 열기. **밖으로 드래그 아웃**은 네이티브 OLE 드래그 필요(`tauri-plugin-drag` 류) → 별도 판단(Open Question 3).
- **수락**: 파일 드롭→선반 표시→재시작 후 유지→클릭 시 열림.

#### C 결과 (2026-11-13, 릴리스 `npm run tauri build -- --no-bundle`, 세션 잠금 — 육안·실클릭·실단축키는 `.omc/verify/c-manual.ps1`로 미룸)
- **창 전략(메모리 결정)**:
  - 턴테이블 = 별도 오버레이 웹뷰(dock/island 와 같은 투명·무장식·항상 위·TOOLWINDOW|NOACTIVATE·저메모리 Low). 트레이 '턴테이블 보이기/숨기기'·독 레코드 우클릭('턴테이블에 올리기')·헤더 '−' 버튼으로 토글. **숨기기 = 창 파괴**(안 쓰면 0MB). 상태는 store `turntable.open`, 위치는 `turntable.pos`(물리 px, 어느 모니터에도 없으면 주 모니터 왼쪽 가운데). 비용: 렌더러 1개 ≈ +11MB.
  - 팔레트: 먼저 **지연 생성 + 닫으면 파괴**로 구현·측정 → `invoke('palette')`(단축키 핸들러와 같은 함수) → 첫 페인트 **p50 240 / p95 309 / max 356ms (20회)** 로 150ms 초과. 그래서 **시작 시 숨김 생성 + 단축키마다 show/hide**로 바꿨다(Low 메모리). 재측정: invoke → 보인 뒤 첫 프레임 **p50 4.2 / p95 5.7 / max 7.2ms**. 비용(실측) ≈ +17MB idle(82.2 → 99.5MB, 같은 조건 턴테이블 보임) — idle 합이 150MB 안이라 채택(아래 표). 트레이드오프: 팔레트를 안 쓰는 사용자도 이 17MB를 낸다. 기존 웹뷰 안 렌더(dock 창 960×178)는 창 크기가 안 맞아 기각.
  - 지연 생성 버전의 열고 닫기 20회: 기준 65.4 → 직후 137.4 → +60s **56.9MB**(누수 없음). 숨김 상주 버전: 기준 80.1 → 20회 직후 98.9 → +60s **101.6MB**(팔레트 렌더러가 앱 목록 300여 개를 들고 있음, 이후 일정).
- **메모리·CPU (릴리스, CDP 없음, idle 3분, Private WS 합)**:

  | 상태 | 메모리 | idle CPU(60s, 트리 / hera.exe, 1코어 기준) | 기준 |
  |---|---|---|---|
  | 턴테이블 보임(정지)·팔레트 숨김 상주 | **99.5MB** (1/2/3분 96.6/98.9/99.6, 프로세스 10개) | 0.23% / 0.18% | ≤150MB · <1% |
  | 턴테이블 숨김·팔레트 숨김 상주 | **85.6MB** (82.0/84.4/85.4) | 0.42% / 0.13% | 참고 |
  | (참고) 턴테이블 보임·팔레트 지연 생성 빌드 | 82.2MB (1/2/3분 78.5/81.1/82.2, 렌더러 3개) | 0.16% / 0.10% | — |
  | (참고) B5 기준선(dock+island) | 67.6MB | 0.10% | — |

- C1 턴테이블:
  - 창 288×520 논리 px 고정(서랍 연 최대 크기, 서랍 바닥 500px). 히트 rect = 카드 + 서랍(닫힘 = 앞판 24px만, 열림 = 트레이 전체), LP 를 끄는 동안은 창 전체. 같은 `reportHitRects`/watch 루프(오버레이 목록을 정적 `OVERLAYS` 로 바꿔 창 생성·파괴 시 등록·해제).
  - 끌기: 헤더에 `data-tauri-drag-region`(+ `core:window:allow-start-dragging`), 이동(`Moved`) 시 위치 저장.
  - **글리치 수정**: 카드가 데크 바닥에서 끝난다(`.tt-card` 아래 패딩 0). 서랍 앞판·트레이는 카드 밖으로 내려와 글라스 뒤판 없이 데크의 일부로 보인다(시안 스크린샷 확인: 카드 bottom = 데크 bottom = 542px).
  - 회전 = 생존: 드롭 → `launch` → 실행 집합(2s)에 레코드 키(세트는 멤버 중 하나)가 있으면 회전 유지, 한 번 살아 있다가 사라지면 톤암 복귀·감속. 15s 안에 안 나타나면(URL 레코드 등) 정지. 독 실행 점도 같은 `aliveIds` 를 쓴다.
  - **PID(IApplicationActivationManager) 미채택**: 실행 집합 키(exe 경로 / `shell:appsfolder\aumid`)로 레코드 앱을 이미 식별하고 B3 에서 검증됐다. PID 는 인스턴스 단위 정밀도만 더하고 별도 프로세스 추적이 필요해 뺐다(같은 앱의 다른 창도 '살아 있음'으로 본다).
  - 플래터 클릭 → `activate(keys)`: 키가 맞는 가장 위 앱 창, 최소화면 `SW_RESTORE`, `SetForegroundWindow`(실패 시 Alt 키 트릭 1회 재시도).
  - 자동 검증 `node .omc/verify/c-perf.mjs turntable`(CDP, charmap.exe 레코드를 서랍→플래터로 마우스 드래그): 드롭 후 playing=true, 3초 뒤 charmap 실행 중·여전히 회전, `activate(charmap)` ok / 없는 키 오류, **taskkill 후 정지까지 1179ms, 689ms(2회)** ≤2.5s 통과, 감속 후 WAAPI paused(프레임 0).
  - 프레임(릴리스 웹뷰 rAF): 서랍 열기 50프레임 **100% ≤17ms**, 최대 16.8ms, long task 0 / 드래그→드롭→스냅→톤암→가속 3s 182프레임 **100% ≤17ms**, 최대 16.8ms, long task 0 (2회 동일).
- C2 세트: `kind:'set'` + `targets[]`, 실행은 멤버 순서대로 `await launch`(앞 요청이 끝난 뒤 다음). 라이브러리 탭 'LP 세트 만들기…' → 단일 레코드 체크(체크 순서 = 실행 순서, 2개 이상) + 이름 → 생성. 세트는 독에 고정하지 않는다(턴테이블 서랍·팔레트용). 시안에서 생성·서랍 표시·재생 표시 확인.
- C3 팔레트: `tauri-plugin-global-shortcut`, 상수 `PALETTE_HOTKEY = "Ctrl+Alt+K"`(lib.rs). 등록 실패(다른 앱 선점) 시 트레이 '검색 (Ctrl+Alt+K)'으로 연다. 검색 = 레코드·미완료 할 일·시작 메뉴 앱(첫 열기 때 1회 로드, 레코드와 같은 대상은 제외), 목록 상한 30. Enter = 실행/열기(할 일 = 패널 할 일 탭), Esc·바깥 클릭 = 숨김 + **이전 포그라운드 창으로 복귀**, 다른 창 클릭(blur) = 숨김(포커스는 그 창). 닫을 때 다시 마운트해 다음 열기에 이전 검색어가 비치지 않는다. 검증: 열기 후 입력 포커스 = 검색어 입력, '그림판' 검색 → 1건, Esc → 검색어 비움·숨김.
  - **단축키 실입력 미측정**: 잠금 세션에서는 키 입력(SendInput)이 Hera 데스크톱에 가지 않는다 → 핸들러와 같은 함수를 CDP `invoke('palette')`로 쟀다. 실단축키·포커스 복귀는 `c-manual.ps1` 7번.
- C4: 배터리 = `power` 커맨드(GetSystemPowerStatus) 1회 + watch 2s 블록에서 바뀔 때만 `power` emit(JS 타이머·폴링 없음, 새 훅 없음). 배터리 없으면(BatteryFlag 128/255) 위젯 숨김 — 이 PC는 데스크톱이라 숨김 상태. 시계는 기존 분 정렬 그대로.
  - 선반: 키 `shelf:<id>` `{path, at}`. 독 네이티브 드롭: 끌고 들어오면 독이 펼쳐지고, 선반 위에 놓으면 모두 선반, 그 외는 .exe/.lnk = 레코드·나머지 = 선반. 칩(확장자) 클릭 = 열기(ShellExecute, 폴더는 탐색기), 우클릭 = 빼기. `ponytail:` 칸 4개, 넘치면 오래된 것부터 뺀다. **드래그 아웃 안 함**(Open Question 3, 필요하면 네이티브 OLE 드래그 플러그인).
- 공통: 투명 창의 `.glass-card` 는 `backdrop-filter: none`(창 밖 블러 불가, 합성 비용 제거).
- 검증: `cargo build`, `cargo test`(8 통과, 수동 4), `cargo clippy -- -D warnings`, `npx tsc --noEmit`, `npm run build`, `npm run tauri build -- --no-bundle` 모두 통과. 시안 `?surface=all`(headless Edge): 표면 전부 존재, 콘솔 오류는 favicon 404 하나, Ctrl+K 열기/Esc, 독 우클릭 → 턴테이블 재생, 세트 재생, 라이브러리 세트 생성 동작.
- 수동(잠금 해제 후): `.omc/verify/c-manual.ps1`(11단계) — 클릭 통과, 창 끌기·위치 복원, 서랍 외형, 실앱 드롭→전면·플래터 클릭 전환, 세트, 실단축키·포커스 복귀, 탐색기→선반 드롭, 배터리(노트북), DevTools 프레임.

---

## 7. Acceptance Criteria & 측정 방법

### 공통 60fps 측정법
- 도구: Chrome DevTools(시안) / WebView2 DevTools(디버그 빌드 우클릭 Inspect, 릴리스는 `devtools` feature 임시 활성) **Performance 패널, CPU throttling 없음, 60Hz 기준**.
- 각 애니메이션 3회 반복 녹화. 합격 조건:
  - 애니메이션 구간 프레임의 **≥ 95% 가 16.7ms 이하**, **50ms 초과 long task 0건**.
  - 구간 내 **Layout/Recalculate Style 이 매 프레임 발생하지 않음**(transform/opacity/clip-path 만 → Composite 위주).
- 보조(선택): 콘솔에 rAF 프레임 간격 로거 스니펫을 붙여 최대 간격 확인(코드에 포함하지 않음).

### Stage A (+ B0)
- [ ] `?surface=all` 한 화면에 7개 구성요소 모두 존재
- [ ] 글라스 토큰 일관 적용, 라이트/다크 전환 시 깨짐 없음, dock/island/panel 글라스가 B0 채택 기법과 일치
- [ ] 애니메이션 4종(독 확대+바운스 / Island 스프링 / 패널 열고닫기 / LP 드래그→스냅→바늘→가속) 각각 위 60fps 기준 통과
- [ ] Island 4상태(idle/preview/alert/nowPlaying) 표현
- [ ] `prefers-reduced-motion` 시 이동 애니메이션 → 페이드로 축소(접근성 기본)
- [ ] B0 6항목 채택안 기록 + 실제 데스크톱 글라스 독 스크린샷 + 메모리 수치
- [ ] A5 게이트 시트 제시, 사용자 "디자인 OK"(전체 또는 P1 부분) 명시

### Stage B
- [ ] 실행 지연: `pointerdown` 시각(`performance.now()`) → `invoke('launch')` 반환까지 20회 측정, **p95 < 300ms** (계산기·메모장·.exe 1종·URL 1종). 창 표시까지 시간은 참고치로만 기록(포그라운드 이벤트 시각 비교).
- [ ] 메모리: 릴리스 빌드, 부팅 후 10분 idle, `hera.exe` + 하위 `msedgewebview2.exe` 전체 **Private Working Set 합 ≤ 200MB** (PowerShell: 부모 PID 트리 합산 또는 작업 관리자 앱 그룹). 초과 시 B0-5 결정 규칙. 1시간 사용 후 증가 ≤ 20%.
- [ ] Idle CPU(작업 관리자 1분 평균, 30Hz 루프 포함), A5 결정에 따라 하나:
  - 기본안: 포그라운드 변화 없이 10초 후 미니 LP 회전 정지 → **< 1%**
  - 대안: 미니 LP 상시 회전 상태에서 **≤ 2%**
- [ ] 독 투명 여유 영역 클릭이 아래 바탕화면 아이콘에 도달
- [ ] Alt+Tab 에 Hera 창이 나타나지 않음
- [ ] 탐색기 파일을 독에 드래그-드롭하면 등록됨(폴러가 드래그 중 클릭 통과 해제)
- [ ] 전체화면 중 due 된 알림이 전체화면 종료 후 표시됨
- [ ] P1 표면(독/Island/패널) 애니메이션 3종이 릴리스 빌드에서 60fps 기준 통과
- [ ] B1~B4 각 수락 항목

### Stage C
- [ ] C1~C4 각 수락 항목, 턴테이블 회전 중 idle CPU < 2%, LP 애니메이션 60fps 기준 통과

---

## 8. Risks & Mitigations

| 위험 | 영향 | 완화 |
|---|---|---|
| 클릭 통과(Tauri 는 창 전체 단위 `set_ignore_cursor_events`) | 독 확대 여유 영역이 바탕화면 클릭을 막음 | watch 루프 30Hz `GetCursorPos` × JS 보고 모양 rect 히트테스트, 상태 바뀔 때만 토글; 창은 최대 크기 고정. 외부 드래그 진입 시 해제(B0-3) |
| 30Hz 폴링 CPU | idle CPU 기준 초과 | 히트테스트·`GetForegroundWindow` 는 µs 단위, 토글은 변화 시만; B5 측정 |
| 포커스 탈취 → Now Playing 오염, 작업 흐름 방해 | 높음 | `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`, 자기 창 무시, WebView2 포커스 탈취 시 직전 포그라운드 복원; panel 만 포커스 허용 |
| NOACTIVATE 창에서 실행한 앱이 전면에 안 뜸 | 실행 체감 저하 | `ShellExecuteW` 전 `AllowSetForegroundWindow(ASFW_ANY)` |
| dock/island 글라스(비활성 창에 Mica/Acrylic 은 비활성 외형, CSS `backdrop-filter` 는 창 밖 블러 불가) | 시안과 외형 차이 | B0-1 순서: `apply_blur` → 배경화면 페이크(배경화면만 보임을 고지, fill 만, 단색/슬라이드쇼는 틴트) → 틴트. 결과를 A5 전에 시안에 반영 |
| `apply_blur` 가 고정 크기 창의 투명 여유 영역까지 블러 | 독 주변 사각 얼룩 | B0-1 판정 항목, 실패 시 ② 배경화면 페이크(웹뷰 안 레이어라 모양대로 clip 가능) |
| Island 확장 시 jank | 60fps 실패 | 창 최대 크기 고정, DOM 은 transform/clip-path 만(창 리사이즈 없음) |
| 아이콘 추출(.lnk 대상, UWP, 고DPI, 알파) | 흐린/누락/테두리 아이콘 | 워커 스레드 `CoInitializeEx` + `IShellItemImageFactory` 256px `SIIGBF_ICONONLY`, 알파 un-premultiply, PNG 캐시, asset protocol scope `appData/icons/**`; 실패 시 커버 컬러 이니셜 |
| UWP AUMID 실행·추적 | 프로세스가 `ApplicationFrameHost` 로 보임, PID 미확보 | 실행은 `shell:AppsFolder\AUMID`; 추적은 창 AUMID 매칭; C1 은 `IApplicationActivationManager` 로 PID 검토 |
| 알림이 숨김 웹뷰 타이머 스로틀로 지연 | 정시 알림 실패 | due-check 를 Rust 루프(2s)로 |
| 전체화면 오탐(바탕화면 Progman/WorkerW 를 전체화면으로 판정) | 독이 사라짐 | `SHQueryUserNotificationState` 만 사용, rect 비교 안 함 |
| 전체화면 중 알림 | 게임/영상 방해 또는 알림 유실 | 큐 보관 후 전체화면 종료 시 표시(B4) |
| 여러 창의 동시 저장 | 편집 유실 | 항목당 키(`todo:<id>` 등), 배열 통째 쓰기 금지 |
| DPI / 멀티모니터 | 위치·크기 어긋남 | P1 은 주 모니터만(멀티모니터 YAGNI), 논리 픽셀 + work area, 배율/모니터 변경 이벤트에 재배치 |
| 부팅 시 자동 시작 | 시작 실패/중복 실행 | `tauri-plugin-autostart` + `single-instance`; WebView2 런타임 미설치 시 설치 안내(Win11 기본 포함) |
| 작업표시줄 가림 | 작업표시줄 위에 독이 겹침 | work area 안 배치. AppBar 공간 예약(`SHAppBarMessage`)은 YAGNI |
| 드래그 등록 충돌(네이티브 vs HTML5) | URL/파일 드롭 미수신 | 역할 분리: dock = 네이티브(파일), panel = HTML5 + `dragDropEnabled:false`(URL), 붙여넣기 폴백 |
| `SetForegroundWindow` 제한(C1 창 전환) | 클릭해도 창이 전면에 안 옴 | 사용자 입력 직후 호출 + `SW_RESTORE`; 실패 시 작업표시줄 깜빡임 허용 |
| 멀티 WebView2 창 메모리 | 예산 초과 | B0-5 에서 A5 전에 측정, > 200MB 시 panel 지연 생성 → dock+island 웹뷰 병합; palette 는 숨김 유지 |

---

## 9. Verification Steps (단계별)

- **Stage A + B0**: `tsc --noEmit`, `npm run build` 성공; §7 60fps 측정 4종 기록(스크린샷/수치); 라이트·다크 각각 스크린샷; B0 6항목 기록·스크린샷·메모리; A5 게이트 시트로 사용자 승인 수신.
- **Stage B**: `cargo clippy -- -D warnings`, `cargo test`, `tsc --noEmit`; 수동 체크리스트(B1~B4 수락 항목 + §7 B) 1회 전수; 실행 지연 20회 측정표; 10분 idle 메모리/CPU 측정; 재부팅 후 자동 시작·데이터 유지 확인. 분기 로직 테스트는 Rust `#[test]` 2개만: `launch.rs` target 분류(exe/lnk/aumid/url), `watch.rs` 알림 due/놓친 알림/전체화면 큐 판정.
- **Stage C**: C1~C4 수동 체크리스트, 턴테이블 회전 중 CPU/60fps 측정, 세트 실행/종료 시나리오.
- 각 단계 완료 판단은 executor 가 아닌 별도 verifier 패스가 수행.

---

## 10. YAGNI (의도적으로 뺀 것)

- 애니메이션 라이브러리(framer-motion 등) — CSS/WAAPI 로 부족함이 측정되면 추가
- 상태관리 라이브러리(Redux/Zustand) — 표면당 로컬 state + store 변경 이벤트로 충분
- SQLite·리포지토리 추상화 — 외부 캘린더 동기화 시
- `SetWinEventHook` 훅 스레드/메시지 루프 — 30Hz `GetForegroundWindow` 폴링이 200ms 목표 충족
- 창 크기 키우기/줄이기 연출, 노이즈 텍스처 폴백 — 창 최대 크기 고정, 폴백은 틴트
- 멀티모니터, 독 위치 변경(좌/우/상), AppBar 공간 예약 — 요청 시
- 배경화면 페이크의 fill 외 스타일(fit/tile/span), 슬라이드쇼 추적 — 요청 시
- 설정 화면 — 단축키·위치는 상수, 요청 시 추가
- 위젯 프레임워크 — 시계·배터리 2개를 그냥 컴포넌트로
- E2E 테스트 프레임워크 — 수동 체크리스트 + Rust `#[test]` 2개
- Windows 토스트 보조 알림 — Island 로 충분, 요청 시

## 11. Open Questions (계획 내 기록, 실행 중 사용자 확인)

1. Now Playing "경과시간" 정의: 현재 포그라운드 연속 시간(기본안) vs 프로세스 시작 이후 시간. 진행바의 기준 길이(예: 25분 집중 사이클?) — 시안 A3에서 기본안으로 보여주고 A5에서 확인.
2. ⌘K 실제 단축키: Win+K 는 OS 예약 → 기본 `Ctrl+Alt+K`. Alt+Space 는 PowerToys Run 과 충돌 가능. (A5)
3. 파일 선반 "드래그 아웃" 필요 여부 — 필요하면 네이티브 드래그 플러그인 추가(C4).
4. dock/island 글라스가 B0 결과 ②(배경화면만 보임) 또는 ③(틴트)로 확정될 때 그 외형을 수용하는지 — A5 게이트 시트의 실제 스크린샷으로 확인.
5. Island 미니 LP 회전: 기본안 = 포그라운드 변화 없이 10초 후 정지(idle CPU < 1%) vs 상시 회전(idle CPU ≤ 2% 허용). (A5)
6. 전체화면 중 알림: 기본안 = 큐 보관 후 종료 시 표시. 전체화면 위에도 즉시 표시를 원하는지.

---

## 12. ADR

- **Decision**: Vite+React+TS 시안을 Tauri 2 프런트엔드로 그대로 재사용. 표면별 별도 투명 창(dock/island/panel, P2 turntable/palette) — dock/island 는 최대 크기 고정 + `WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE` + Rust 30Hz 커서 폴러 클릭 통과, panel 만 OS 백드롭(Mica/Acrylic)·포커스 허용. dock/island 글라스는 `apply_blur` → 배경화면 페이크 → 틴트 순 B0 결정. 저장은 `tauri-plugin-store` JSON 1파일·항목당 키. Rust 4모듈(lib/launch/icons/watch), watch 는 단일 루프(30Hz 커서·포그라운드 / 2s 실행 집합·전체화면·알림·배경화면). 플랫폼 위험과 메모리는 A5 디자인 게이트 전 B0 스파이크로 검증.
- **Drivers**: 60fps 애니메이션, Windows 오버레이 정확성(포커스·클릭 통과·전체화면·Alt+Tab), 시안 재사용과 1인 개발 속도.
- **Alternatives considered**:
  - 순수 HTML 시안 — Stage B 재작성 비용으로 기각.
  - 전체화면 클릭통과 단일 오버레이 — 모니터 크기 투명 합성 비용, 전체화면 앱과 충돌, panel 에 실제 OS 백드롭 불가로 기각(클릭 통과 폴링·블러 한계는 두 안 공통이라 기각 근거 아님).
  - hover 진입/이탈 기반 클릭 통과 토글 + 창 크기 키우기/줄이기 연출 — 투명 창은 hover 를 못 받으면 진입을 감지할 수 없고 리사이즈 타이밍이 jank 원인이라 기각.
  - dock/island 에 Mica/Acrylic — NOACTIVATE 창은 항상 비활성 외형이라 기각.
  - `SetWinEventHook` 포그라운드 훅 — 별도 스레드·메시지 루프가 필요하고 30Hz 폴링으로 200ms 목표 충족, 기각.
  - 전체화면 rect 비교 — Progman/WorkerW 오탐으로 기각.
  - 웹뷰 `setTimeout` 스케줄러 — 숨김 웹뷰 스로틀로 기각.
  - 배열 단위 저장 키 — 창 간 덮어쓰기 유실로 기각.
  - 아이콘 base64 전달 — asset protocol(scope 제한)이 더 단순·저비용이라 기각.
  - SQLite — P1 데이터량 대비 과함으로 보류.
- **Why chosen**: 각 선택이 동작하는 가장 작은 구성이면서 Driver 1~3 을 모두 만족. 표면별 창은 모니터 크기 합성 없음·전체화면 비충돌·panel 실제 백드롭이라는 남은 이점으로 선택. 폴링·스케줄러·전체화면을 루프 1개로 모아 스레드/훅/타이머 종류를 줄임. B0 를 게이트 앞으로 옮겨 시안이 실제 출시 외형을 보여줌. 상한이 명확(동기화 시 SQLite, 메모리 초과 시 panel 지연 생성→웹뷰 병합, 창 간 드래그는 크레이트로 회피).
- **Consequences**: 창 간 드래그 불가(턴테이블 크레이트로 대체). dock/island 글라스가 ②로 가면 뒤의 앱이 아닌 배경화면만 비침(고지). 30Hz 상시 루프가 idle CPU 의 바닥값을 만든다. Island 는 고정 크기 프리셋. 메모리 결정 규칙 발동 시 창 구성이 바뀔 수 있음. 전체화면 중 알림은 지연 표시.
- **Follow-ups**: B0 6항목 결과 기록(글라스 채택안, 메모리 수치와 결정 규칙 결과, 스토어 이벤트 결정 포함), A5 에서 Open Questions 1·2·4·5·6 확정, 외부 캘린더 연동 시 저장소 재평가, 멀티모니터 요청 시 배치 로직 확장, C1 UWP PID 확보 방식(`IApplicationActivationManager`) 확정, P2 단축키 확정.

---

## Changelog (consensus review)

- B0 스파이크와 메모리 측정을 A5 디자인 게이트 앞으로 이동, B0 결과를 시안 글라스에 반영(Architect 1).
- 클릭 통과: hover 토글 → Rust `GetCursorPos` 30Hz 폴러 + JS 보고 모양 rect; dock/island 창 최대 크기 고정; 노이즈 텍스처 폴백·창 크기 연출 삭제(Architect 2).
- OS 백드롭(Mica/Acrylic)은 panel 에만(Architect 3). dock/island 글라스는 `apply_blur` → 배경화면 페이크 → 틴트 순 B0 판정(Critic C).
- 창 스타일 `WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE`, 실행 전 `AllowSetForegroundWindow(ASFW_ANY)`, WebView2 포커스 탈취 시 복원(Architect 4).
- 전체화면 판정은 `SHQueryUserNotificationState` 만, rect 비교 삭제(Architect 5).
- 드래그 역할 분리: dock 네이티브(파일) / panel HTML5 + `dragDropEnabled:false`(URL) / 붙여넣기 폴백(Architect 6).
- 스토어 항목당 키(Architect 7); 커스텀 `data-changed` 는 B0 에서 플러그인 이벤트로 대체 가능 시 삭제(Critic H).
- 알림 due-check 를 Rust 루프로 이동, `scheduler.ts`·node assert 스크립트 삭제 → Rust `#[test]`(Architect 8, Critic H).
- 아이콘: `SIIGBF_ICONONLY`, 워커 스레드 `CoInitializeEx`, 알파 un-premultiply, asset protocol scope `appData/icons/**`; C1 UWP PID 는 `IApplicationActivationManager` 검토(Architect 9).
- D2 근거·ADR 재작성: "폴링 없음/진짜 블러" 근거 삭제(Critic A).
- Idle CPU 기준을 A5 선택지로(기본 10초 후 회전 정지 → <1%, 대안 상시 회전 ≤2%)(Critic B).
- watch 를 단일 루프(30Hz/2s)로 통합, `SetWinEventHook` 스레드·위험 행 삭제(Critic D).
- 메모리 >200MB 결정 규칙: panel 지연 생성 → dock+island 웹뷰 병합(Critic E).
- 전체화면 중 알림 큐 보관 + 수락 기준(Critic F).
- 수락 기준 추가: 투명 여유 영역 클릭 통과, Alt+Tab 비노출, 탐색기→독 드래그-드롭(Critic G).
- A5 게이트 시트(체크리스트·실제 글라스 스크린샷·알려진 차이·질문) + 부분 OK 허용(Critic I).
