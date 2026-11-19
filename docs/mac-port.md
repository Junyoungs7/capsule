# Hera — 맥 포팅 안내 (맥에서 실행하는 Claude Code 세션용)

목표: 같은 저장소로 **맥용 Hera** 를 만든다. 윈도우 = Hera Link 서버(입력 엔진 서버 + 파일 채널 대기),
맥 = 클라이언트. 사용자 결정은 `.omc/plans/hera-link.md`, 파일 채널 규격은 `docs/hera-link-protocol.md`.
윈도우 쪽은 완성·시험됨 — **윈도우 동작을 바꾸지 말 것** (`#[cfg(windows)]` 코드는 그대로 두고 맥 구현을 옆에 추가).

## 0. 준비
```sh
xcode-select --install                     # Xcode Command Line Tools
curl https://sh.rustup.rs -sSf | sh        # Rust (stable)
brew install node                          # Node 20+
npm ci
cd src-tauri && cargo check --lib          # 지금 상태로 컴파일되어야 함 (빈 구현 stub)
cd .. && npx tauri dev                     # 트레이(메뉴 막대) 패널·설정이 뜨지만 플랫폼 기능은 빈 값
```
윈도우에서 `cargo check --lib --target x86_64-apple-darwin` 가 통과하도록 맞춰 둔 상태다 (C 의존성은 맥에선 진짜 SDK 로 빌드).

## 1. 지금 구조
| 파일 | 역할 | 맥 상태 |
|---|---|---|
| `src-tauri/src/lib.rs` · `tray.rs` | 창 생성·명령·트레이·패널·알림 카드 | 공용 (Win32 직접 호출 없음) |
| `src-tauri/src/ui.rs` | 창 핸들 도우미 (한 번에 배치, 저메모리) | 맥 = 간단 대체/빈 구현 → **채울 것** |
| `src-tauri/src/stub.rs` | 윈도우 전용 모듈(`watch` `launch` `shell` `drag` `pet`)과 같은 모양의 빈 구현 | 하나씩 **진짜 맥 모듈로 교체** |
| `src-tauri/src/link_files.rs` | 파일 채널 (TCP·암호·페어링) | **공용 그대로 사용** — 맥은 `discover()` + `connect()` |
| `src-tauri/src/link.rs` | 엔진 감독(서버 모드)·설정 생성·로그 해석·Deskflow 가져오기 | 로그 해석·설정 생성은 공용. 맥은 **클라이언트 모드** 감독을 추가 |
| `src/**` (React) | 패널 · 알림 카드 · 받침/포탈 · 펫 · 설정 · 메모 보드 · 덮개 · 효과 | 기능 로직은 공용, 겉모습은 맥 디자인으로 (`docs/mac-design.md`) |

교체 방법: `src-tauri/src/mac/<모듈>.rs` 를 만들고 lib.rs 에서
`#[cfg(target_os = "macos")] #[path = "mac/watch.rs"] mod watch;` 처럼 stub 대신 연결. 함수 시그니처는 stub 과 같게.

## 2. 모듈별 맥 대응
| 기능 (윈도우 구현) | 맥 대응 | 권한 |
|---|---|---|
| 선반 파일 열기 `launch::launch` (ShellExecuteEx) | `NSWorkspace.open(_:)` | — |
| 한/영 키 넘기기 `shell` (저수준 키보드 훅) | 맥은 서버가 아니라 해당 없음 — `ime{toggle}` 을 받아 입력 소스 전환 (5장 G) | — |
| 전체화면 앱 감지 (SHQueryUserNotificationState) | 맨 앞 앱 창이 화면을 덮는지 `CGWindowList` 로 / 발표 모드는 `CGDisplayIsCaptured` | — |
| 자리 비움 (GetLastInputInfo) | `CGEventSourceSecondsSinceLastEventType(.combinedSessionState, .any)` | — |
| 잠금 감지 (QUNS_NOT_PRESENT) | `com.apple.screenIsLocked` 분산 알림 | — |
| 클릭 통과 (WS_EX_TRANSPARENT 토글) | `NSWindow.ignoresMouseEvents` 토글 — watch 루프의 커서/히트 rect 로직은 그대로 옮기면 됨 (Tauri `set_ignore_cursor_events`) | — |
| 포커스 안 뺏는 창 (WS_EX_NOACTIVATE) | **NSPanel** + `.nonactivatingPanel`, 레벨 `.statusBar`, `collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]`. Tauri 2 는 `tauri-nspanel` 플러그인 또는 objc2 로 NSWindow 를 NSPanel 로 바꿈 | — |
| 작업 영역 변화 | `NSApplication.didChangeScreenParametersNotification` | — |
| 효과 창 최상위 (SetWindowPos) | `ui.rs` 맥 구현: `setFrame(_:display:)` 한 번에, 레벨로 위아래 | — |

## 3. 입력 엔진 (맥 = Deskflow 클라이언트)
윈도우는 `deskflow-core server` 를 숨김 자식으로 실행한다 (`link.rs`). 맥은 **`deskflow-core client`**.

1. 바이너리: Deskflow 1.27 맥 빌드에서 `Deskflow.app/Contents/MacOS/deskflow-core` + `Contents/Frameworks/` (Qt·OpenSSL) 를 `src-tauri/resources/link/` 로 복사하는 스크립트(`scripts/fetch-deskflow.sh`), 또는 소스 빌드(cmake, Qt6, OpenSSL). 라이선스 파일 동봉 (GPL-2.0 + OpenSSL 예외, 개인 사용).
2. 실행: 엔진 폴더를 `~/Library/Application Support/dev.hera.dock/link/` 로 복사해 그곳에서. 항상 `--new-instance`.
   설정 INI (`-s` 또는 portable 위치 — 맥에서 portable 판정 규칙을 확인):
   ```ini
   [core]
   computerName=MacBook        ; 윈도우 설정의 peer 이름과 같아야 함
   coreMode=1
   port=24800
   [client]
   remoteHost=<윈도우 IP>      ; 파일 채널 비콘의 보낸 주소를 쓰면 됨
   [security]
   tlsEnabled=true
   checkPeerFingerprints=true
   certificate=<엔진폴더>/settings/tls/deskflow.pem   ; 클라이언트 인증서 — 없으면 생성 필요(아래)
   [log]
   level=INFO
   ```
3. 권한: 입력 주입·감시 = **손쉬운 사용(Accessibility)** + **입력 모니터링(Input Monitoring)**. 자식 프로세스는 책임 프로세스(Hera.app)로 판정되므로 사용자가 시스템 설정 > 개인정보 보호 및 보안 에서 **Hera** 를 켠다. 꺼져 있으면 `AXIsProcessTrustedWithOptions` 로 프롬프트를 띄우고 패널에 안내.
4. 로그 해석은 `link::parse_line` 그대로 (클라이언트 로그에 `connected to server`, `disconnected from server` 등이 있으면 패턴 추가 + 시험).
5. 지문: 맥 엔진의 서버 신뢰 목록(`trusted-servers`, Deskflow 1.27 형식 `v2:sha256:<hex>`)에 파일 채널 페어링에서 받은 윈도우 `fp` 를 넣는다. 맥 hello 의 `fp` 에는 맥 클라이언트 인증서 지문을 넣는다 (윈도우가 trusted-clients 에 추가).
6. 인증서가 없으면: 윈도우 쪽은 'Deskflow 설정 가져오기' 로 사용자 Deskflow 인증서를 복사한다. 맥도 같은 방식(사용자 Deskflow.app 의 `~/Library/Deskflow/tls/deskflow.pem`) 또는 `rcgen` 으로 생성(새 의존성 — 필요할 때만).
7. 사용자의 Deskflow.app 이 실행 중이면 내장 엔진을 띄우지 말고 "Deskflow 를 먼저 종료하세요" 표시 (윈도우는 `Global\DeskflowClose` 로 감지 — 맥은 프로세스 이름 확인).

## 4. 파일 채널 (맥 = 클라이언트)
`link_files.rs` 를 그대로 쓴다:
```rust
loop {
    if let Some((addr, _name)) = link_files::discover(Duration::from_secs(10)) {
        let _ = link_files::connect(addr, &cfg(), sink.clone(), &on_conn); // 끊기면 반환
    }
    sleep(backoff); // 1→2→4…30s
}
```
- `Config.secret`/`known_peer` 는 맥 store 의 `link.key`/`link.peerPk` (윈도우와 같은 키 이름).
- 받은 파일: `~/Downloads/Hera/` → 선반 (store `shelf:<id>`, `from: "pc"` 쪽에서 보면 '윈도우에서 받음').
- 패널 표시(페어링 코드·연결 상태)는 React 가 공용 — 이벤트 이름만 같게 (`link-status`, `link-switch`, `link-files`).

## 5. Hera Link 추가 기능 (3b) — 맥 쪽 구현
윈도우 쪽 구현 파일을 참고: `link_layout.rs`(공용), `ripple.rs`·`edge.rs`·`drag.rs`(윈도우 전용), `link.rs` 의 `on_msg`.

**A. 모니터별 배치**: 접속 직후 `monitors` 를 보낸다 (`NSScreen.screens` → frame 을 맥 전역 좌표 [x, y, w, h] 포인트로, y 는 위쪽이 0 이 되게 뒤집기). 엔진 링크는 서버(윈도우)가 만든다 — 맥은 표시만 (`link_layout::plan` 을 그대로 써서 같은 캔버스를 보여 줘도 됨).

**B. 넘어갈 때 파란 물결**: `crossed` 를 받으면 웹뷰 창을 만들지 말고 **네이티브 창** 하나로 그린다: borderless `NSPanel`(`.nonactivatingPanel`, `ignoresMouseEvents = true`, 레벨 `.screenSaver`, `backgroundColor = .clear`, `isOpaque = false`) 에 `CALayer`/`CAShapeLayer` 동심원 3개를 600ms 동안 키우며 투명하게(`CABasicAnimation`), 끝나면 `orderOut`. 처음 한 번 만들고 재사용. enter=true → (x,y) 에 진하게, enter=false → 지금 커서 자리(`NSEvent.mouseLocation`)에 옅게. 움직임 줄이기(`NSWorkspace.accessibilityDisplayShouldReduceMotion`)면 부드러운 빛 한 번. 모양은 윈도우 `ripple::render` 와 같게(파랑 #3C9AFF 바깥 → 밝은 하늘색 안쪽).

**D. 가장자리로 파일 끌기**: 이어진 가장자리 구간(맥 쪽 = `plan` 의 `mac` % 구간 — 윈도우가 `monitors`·링크를 알려 주면 계산)에 4px 투명 `NSWindow` 를 두고 `registerForDraggedTypes([.fileURL])`. `performDragOperation` 에서 파일 경로를 받아 `send_file_meta(… {"via":"edge","edge":<윈도우 쪽 가장자리>,"pos":…})` + 옅은 물결. (평소엔 `ignoresMouseEvents = true`, 드래그 중일 때만 false — `NSEvent.pressedMouseButtons` 를 가볍게 확인)

**F. 커서 찾기**: `watch::Shake`(공용 로직) 를 맥 커서 표본(30Hz `NSEvent.mouseLocation`)에 쓰고, 발동 시 B 의 물결을 커서 둘레 원으로.

**G. 키 매핑·한/영**: 수식키 바꾸기는 엔진(윈도우 설정)이 한다 — 맥은 할 일 없음. `keymap.preset == "shortcuts"` 면 `CGEventTap`(kCGHIDEventTap, keyDown/keyUp)으로 엔진이 주입한 Ctrl+C/V/X/Z/A/S/F/T/W/R/L/Q(+Shift) 를 ⌘+같은 키로 바꾼다 (손쉬운 사용 권한, 엔진이 주입한 이벤트만 — 맥 자체 키보드는 그대로). 한/영: `ime{toggle}` → `TISCopyInputSourceForLanguage("ko")`/`TISCopyCurrentASCIICapableKeyboardInputSource()` 로 한국어 ↔ 영어 입력 소스 전환(`TISSelectInputSource`), 이어서 `{"t":"ime","action":"state","source":"ko"|"en"}` 회신. 반대 방향(맥 키보드 → 윈도우)은 맥이 서버일 때의 일 — 지금은 해당 없음(미래).

## 5b. Hera for Windows 개편 (a16–a19, 2026-11-19) — 맥

윈도우판은 캡슐 Island · 허브 · 떠 있는 창 · 할 일 · 달력 · 채팅/Team · 터미널/아라/MCP · OCR · 상용구 · LP · 최근 복사 · 내 펫 편집을 **지웠다**.
남은 기능·저장 키·이벤트·통신 규격은 `docs/spec.md` 가 기준이고, 맥 화면(메뉴 막대·제어 센터 방식)은 `docs/mac-design.md`.
맥에서 같은 동작을 만들 때 윈도우 파일 대응:

- 트레이 패널 (`tray.rs` + `src/win/Panel.tsx`) → 메뉴 막대 아이콘의 팝오버 (`NSStatusItem` + `NSPopover`, 바깥 클릭·Esc 닫힘).
- 알림 카드 (`tray.rs` toast + `src/win/Toast.tsx`) → `UNUserNotificationCenter` 또는 오른쪽 위 작은 패널.
- 흔들어 받침 · 포탈 (`drag.rs` + `src/win/Drag.tsx`) → 투명 `NSPanel`(`ignoresMouseEvents` 를 받침 rect 에 맞춰) + `registerForDraggedTypes([.fileURL])`. 파일 끌기 감지는 `NSPasteboard(name: .drag)` 의 changeCount (윈도우의 '시험 칸' 대신).
- 작업 표시줄 펫 (`pet.rs` + `src/win/PetBar.tsx`) → 메뉴 막대/노치 옆 작은 펫 (꾸미기 켜짐일 때만).
- 넘어갈 때 물결 · 흔들어 커서 찾기 (`ripple.rs`, `watch::Shake`) → 5장 B · F 그대로, 스위치 `ripple.enabled` · `locator.enabled`.

## 6. 수락 시험 (맥)
1. `cargo test --lib` 통과 (link_files 루프백 시험 포함), `npx tsc --noEmit -p .` 통과, `npx tauri build` 로 .app.
2. 윈도우 Hera 패널에서 연결 켜기 (사용자 Deskflow 종료 후) → 맥 Hera 가 비콘을 받아 접속 → 양쪽에 같은 6자리 → 양쪽 '같아요'.
3. 마우스를 윈도우 오른쪽(설정한 방향) 끝으로 → 맥으로 넘어가고 양쪽 화면 끝에 물결. 한/영·Cmd/Ctrl 정상.
4. 클립보드 공유 켜짐이면 복사·붙여넣기가 양쪽으로, 끄면 안 된다.
5. 윈도우에서 파일을 끌다 흔들어 '맥으로 보내기' 또는 맥 쪽 가장자리 포탈에 놓기 → 맥 `~/Downloads/Hera/` + 맥 선반('윈도우에서 받음'). 반대 방향도.
6. 메모리: 맥 Hera idle (꾸미기 꺼짐) ≤ 150MB (Activity Monitor, WebKit 프로세스 포함).
