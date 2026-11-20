# Hera 기능 · 규격 (Windows a19 기준 — 맥판도 이것과 같아야 한다)

> 원칙: **쉽고 빠르게.** 한 화면, 크기가 튀지 않게, 확인 창 없이, 짧은 한국어. 쉬는 동안 전체 메모리 ≤ 150MB, 쉬는 동안 애니메이션·폴링 없음, 동작 줄이기를 따른다.
> 화면: 윈도우 = Windows 11 Fluent (`.omc/prototypes/win-tray-v3.html`), 맥 = 맥 방식 (`docs/mac-design.md`).
> 파일 채널 규격: `docs/hera-link-protocol.md`. 맥 모듈 대응: `docs/mac-port.md`.

## 1. 기능 (이것 말고는 없다)

| # | 기능 | 하는 일 | 스위치 (store) |
|---|---|---|---|
| 1 | **연결** (Hera Link) | 내장 입력 엔진(deskflow-core, 서버)으로 마우스·키보드를 맥과 함께 쓴다. 파일 채널(암호 · 6자리 숫자 비교 페어링) · 모니터 배치 · 키 매핑 · 한/영 · Deskflow 설정 가져오기(읽기만) | `link.enabled` (기본 꺼짐) |
| 2 | **클립보드 공유** | 엔진의 클립보드 동기화 (`enableClipboard`). 최근 복사 목록은 없다 | `link.share.clip` (기본 켬) |
| 3 | **파일 보내기 + 선반** | 선반 = 따로 둔 파일 (최대 8개, 넘치면 오래된 것부터 뺌). 맥에서 받은 파일도 선반에 ('맥에서 받음'). 줄마다 맥으로 보내기 · 열기 · 빼기 | — |
| 4 | **메모** | 패널에서 빠른 메모 (Enter 저장, Shift+Enter 줄바꿈, 최근 3개), 메모 보드 창, 메모장으로 열기 | — |
| 5 | **넘어갈 때 물결** | 커서가 맥으로 넘어가고 돌아올 때 화면 끝 물결 + 벽 일렁임 | `ripple.enabled` (기본 켬) |
| 5 | **흔들어 커서 찾기** | 단추를 누르지 않고 마우스를 빠르게 흔들면 커서 둘레 물결 | `locator.enabled` (기본 켬) |
| 6 | **꾸미기** | 하나의 스위치: 날씨·계절 자동 효과 + 자리 비움 화면(모든 모니터 아스키·효과). 펫은 스위치와 상관없이 항상 | `deco.enabled` (기본 **꺼짐**) |
| 7 | **설정** | 일반(시작 시 실행 · 기능 3개 · 설정 폴더) · 연결(기기 · 화면 배치 · 키보드 · 고급) · 꾸미기(펫 고르기 · 도시 · 자리 비움 대기) · 정보 | — |

## 2. 화면 (윈도우 창 라벨 — 모두 `capabilities/default.json` 에 있어야 한다)

| 라벨 | 언제 | 무엇 |
|---|---|---|
| `panel` | 시작할 때 숨긴 채 만들어 상주 (웹뷰 1개) | 트레이 왼쪽 클릭 = 열기/닫기. 368px, 작업 표시줄이 있는 모니터의 트레이 쪽 모서리에서 12px. 바깥 클릭·Esc = 닫힘. 내용: 연결 줄(+스위치, 페어링 숫자) · 타일 3개(클립보드 공유 · 넘어갈 때 물결 · 흔들어 커서 찾기) · 선반(놓기 칸 + 목록) · 메모(입력 + 최근 3 + 모두 보기) · 꾸미기 스위치 + 설정 |
| `drag` | 시작할 때 숨긴 채 상주, 파일을 끌 때만 그 모니터를 덮음 | 흔들어 받침(선반에 올리기 · 맥으로 보내기) + 맥 쪽 가장자리 포탈. 클릭 통과, 받침 rect 만 드롭 대상 |
| `toast` | 그때만 만들고 사라지면 파괴 | 알림 카드 (오른쪽 아래, 작업 표시줄 위 — 패널이 열려 있으면 그 위): 받음 · 보냄 · 실패 · 연결됨/끊김 · 페어링(누르면 패널) |
| `pet` | 항상 | 84×84 떠 있는 창. 기본 자리 = 주 모니터 오른쪽 아래, 작업 표시줄 위, 패널 자리 바로 왼쪽. 끌어서 옮기면 `pet.pos`(물리 px), 가장 가까운 작업 영역 안으로. 누르기 = 패널(`"main"`), 오른쪽 클릭 = 펫 메뉴(`"fx"`: 이미지 바꾸기 · 기본 펫으로 · 제자리로 + 효과 · 아스키). 그림 = 기본 펫 또는 내 이미지(`pet.kind` = `custom`, `%APPDATA%\dev.hera.dock\pet\custom.*`, 8MB). 전체화면 앱이면 숨김. 파일을 펫에 대면 둘레로 보낼 곳이 펼쳐짐 (`fan`) |
| `settings` | 열 때 만들고 닫으면 파괴 | 보통 창 (제목 표시줄 · Alt+Tab) |
| `notes` | '모두 보기' 때 만들고 닫으면 파괴 | 메모 보드 (자리·크기 기억) |
| `ascii`, `ascii-N` | 자리 비움 화면 (꾸미기 켜짐) | 모니터마다 1개, 무작위 장면(직전 것 빼고), 입력이 있으면 닫힘 |
| `fx`, `fx-N` | 효과 이벤트 (꾸미기 켜짐) | 모니터마다 1개, 25초, 클릭 통과 |

트레이 아이콘: 맥이 연결되면 초록 점(툴팁 'Hera · 맥 연결됨'). 오른쪽 클릭 메뉴 = 설정 · 종료. 두 번째 실행 = 패널 열기. 전역 단축키 없음.

## 3. 동작 규칙

- **파일 끌기 감지 (윈도우)**: Hera 창 밖에서 눌러 8 논리 px 넘게 끌면(창 옮기기 `GUI_INMOVESIZE` 는 제외) `drag` 오버레이를 보이고 커서 둘레 48px 칸만 드롭 대상으로 둔다. OLE DragEnter(경로 있음)가 오면 파일 끌기 확정, 0.4초 안에 안 오면 숨기고 그 끌기는 무시.
- **흔들기 → 받침**: 파일 끌기 중 0.7초 안에 좌우 방향이 3번 넘게 바뀜, 한 번에 25 논리 px 초과 (배율만큼 키움). 받침은 커서 위 22px, 스프링 등장. '맥으로 보내기'는 맥 파일 채널이 없으면 흐리게 + '맥 Hera 연결 필요'. 끌기가 끝나면 사라진다.
- **흔들기 → 커서 찾기**: 단추를 누르지 않은 흔들기 (0.5초 안에 방향 4번, 한 번에 50 논리 px), 발동 뒤 1.5초 쉼.
- **포탈**: 맥과 이어진 가장자리 구간(`link_layout::plan` segs)까지 220 논리 px 에서 열리기 시작, 50px 안이면 다 열림 (k 0..1). 가장자리 띠(edge.rs)나 받침 '맥으로 보내기'에 놓으면 빨려 들어감(0.9초) · 섬광 · 충격파 → 보냄. 가장자리로 보낸 파일은 `offer.via = "edge"`, `edge`, `pos`.
- **알림 카드**: 4초 뒤 사라짐 (페어링은 누르거나 끝날 때까지, 최대 60초). 전체화면 앱 중엔 띄우지 않음.
- **펫**: 평소 → 2분 동안 아무 일 없으면 잠 (잠든 동안 애니메이션 없음). 파일 받음 = 상자(shelf), 보냄 = 만세(done), 3초.
- **효과 이벤트** (꾸미기 켜짐): 비·눈 시작 > 계절 첫날(9/1 단풍, 12/1 눈) > 시간대 변화(새벽·노을·달). 날씨는 패널이 꾸미기 켜짐일 때만 30분마다 받아 `fx.weather` 에.
- **자리 비움 화면** (꾸미기 켜짐): 입력 없이 `ascii.idleMin` 분 (0 = 끔), 전체화면·잠금 중 아님.

## 4. 저장 (tauri-plugin-store `hera.json`, `%APPDATA%\dev.hera.dock`)

| 키 | 값 |
|---|---|
| `link.enabled` | bool |
| `link.cfg` | `{ me, peer, side: left\|right\|top\|bottom, port, tls, doubleTap, filePort, keymap: habit\|position\|shortcuts\|custom, keyRows: [[win, mac]…], ime: hera\|capslock\|ctrl-space\|cmd-space\|off }` |
| `link.share` | `{ clip: bool }` |
| `link.key` · `link.peerPk` · `link.peerName` | 파일 채널 X25519 비밀키(hex) · 페어링한 맥 공개키 · 이름 |
| `link.layout` · `link.macMonitors` | 배치 캔버스 `{ at: { id: [x, y] } }` · 맥이 알려 준 모니터 `[{ id, rect }]` |
| `ripple.enabled` · `locator.enabled` · `deco.enabled` | bool (기본 true · true · false) |
| `shelf:<id>` | `{ id, path, at (ms), from: "pc"\|"mac", sent?: bool }` — 넣기는 Rust `shelf_add`/받음만 (최대 8) |
| `note:<id>` | `{ id, text, color (0..5), x, y, w, h, at? }` — 보드 자리 + 만든 시각 |
| `note.color` · `notes.board` | 고른 메모 색 · 예전 메모를 보드로 옮겼음 표시 |
| `board.rect` | 메모 보드 창 [x, y, w, h] (물리 px) |
| `pet.kind` | 기본 펫 키 (`cat`, `penguin` …) 또는 `custom` |
| `pet.img` · `pet.pos` | 내 이미지 바꾼 시각 · 옮긴 자리 [x, y] |
| `people:<pk>` | 등록한 사람 `{ id: pk, name, at }` |
| `people.enabled` · `people.name` | 사람에게 보내기 (기본 켜짐) · 내 이름 (비면 Windows 사용자 이름) |
| `fx.city` · `fx.coords` · `fx.weather` | 도시 · [위도, 경도] · `{ text, temp }` |
| `ascii.idleMin` | 자리 비움 대기 분 (기본 10) |

예전 키(`record:` `todo:` `event:` `chat*` `team*` `term.` `mcp.` `island.` `float.` `appbar.` `lp.` `sync.` `alarm.` `fx.enabled` …)는 시작할 때 한 번 지운다 (`lib.rs OLD_KEYS`).

## 5. 이벤트 (Rust → 웹뷰)

| 이름 | 받는 곳 | 내용 |
|---|---|---|
| `link-status` | 모두 | `{ state: off\|starting\|waiting\|connected\|blocked\|error, detail, peer, onPeer, fingerprint }` |
| `link-switch` | 모두 | `{ to, onPeer }` |
| `link-files` | 모두 | `peer{state: pairing\|ready\|closed, name, code}` · `paired` · `xfer{dir,id,name,bytes,size}` · `received{id,path}` · `sent{id,ok,error}` |
| `panel-show` / `panel-hide` | panel | 보이기 / 숨김 |
| `toast` | toast | `{ kind: recv\|sent\|fail\|link\|pair, title, sub }` |
| `drag-start` · `pad-show` · `portal` · `portal-drop` · `drag-end` | drag | `{scale}` · `{x, y, mac, to}` · `{k, side, x, y}` · `{paths, edge, pos, x, y}` · — (좌표 = 오버레이 논리 px) |
| `pet-react` | pet | `"recv"` \| `"sent"` |
| `settings-sec` | settings | 섹션 (`general` \| `link[:tab]` \| `deco` \| `about`) |
| `ascii-close` | ascii* | 닫기 |

## 6. 명령 (웹뷰 → Rust)

`settings_open(sec)` · `close_self` · `autostart(on?)` · `report_hit_rects(rects)` · `shelf_add(paths)` · `open_path(path)` · `board_open` · `fx(kind)` ·
`link_status` · `link_apply` · `link_import` · `link_trust(fp)` · `link_pair(ok)` · `link_unpair` · `link_send(path, edge?, pos?)` · `link_plan` · `note_notepad(id)` ·
`panel_fit(h)` · `panel_hide` · `toast_next` · `toast_done` · `toast_click` · `drag_file` · `drag_hide` · `pet_click(view)` · `pet_drag` · `pet_home` · `pet_set_image(name, data)` · `pet_image` · `people_pair(pk)` · `people_confirm(ok)` · `people_near` · `people_forget(pk)` · `people_send(pk, paths)` · `fx(kind)` · `cover(scene)`.

## 7. 시험

- `cd src-tauri && cargo test --lib` (배치 · 흔들기 · 포탈 거리 · 선반 · 예전 키 · 권한 목록 · 파일 채널 루프백 …), `cargo clippy`, `npx tsc --noEmit -p .`
- 헤드리스 (실제 마우스·키보드·창을 건드리지 않음): `node .omc/verify/{settings,panel,pad,portal,pet,people,people-drag}-cdp.mjs`

## 사람에게 보내기 (people.rs, 시안 `.omc/prototypes/people.html`)

- 같은 네트워크의 다른 Hera. 발견 = UDP 24813 비콘 `{"hera-people":1,name,port,pk}` 3초마다, 10초 안 들리면 목록에서 빠짐. 전송 = TCP 24812, 맥 채널과 같은 `link_files` 규약(같은 키 · 숫자 비교 페어링). 맥 연결(24810/24811)과 따로.
- **IP 로 추가**: 자동 찾기(브로드캐스트)가 막힌 망 — '+ 사람 추가'의 IP 칸(`people_pair_ip`, 포트 없으면 24812), 아래에 내 IP 안내. 등록하면 상대 IP 를 `people:<pk>.ip` 에 기억하고, 비콘을 그 IP 로도 직접(유니캐스트) 보내 서로 '켜짐'이 보인다. 비콘으로 IP 가 바뀐 걸 보면 기억도 바꾼다.
- **등록한 사람만** 주고받음: 모르는 사람의 접속은 '등록 요청'(받는 쪽 알림 + 패널 숫자 카드)까지만, 확인 전에는 파일이 오지 않음. 파일만 (클립보드 · 마우스는 맥 전용).
- 보내는 자리 넷: 패널 '보낼 사람'(사람 위에 놓기) · 트레이 아이콘에 0.35초 대면 패널이 열림(놓은 뒤 1초에 닫힘) · 흔들기 받침의 사람 줄 · 가장자리 사람 포탈(`gates`, 켜진 사람이 있을 때, 맥이 왼쪽에 이어져 있으면 왼쪽 아니면 오른쪽, 큰 맥 포탈 대신 맥도 그 줄에) · 펫 둘레(`fan`).
- 받으면 선반(`from` = 보낸 사람 이름) + 다운로드\Hera + 알림 "<이름>님이 파일을 보냈어요".

## 전체 톡 · 빠른 톡 · 초대 (talk.rs, 시안 `.omc/prototypes/talk.html` · `quick.html`)

- **전체 톡**: 등록한 사람 모두 + 내 맥. 패널 '보낼 사람' 옆 [톡 n] → 톡 창(`?surface=talk`, 380×560). 기록은 이 PC 에만 `%APPDATA%\dev.hera.dock	alk.json` 최근 500개, 서버 없음 — 꺼진 사람은 그동안의 말을 못 받음. 받으면 알림 "<이름> · 전체 톡"(누르면 톡 창) + `talk.unread`.
  메시지 `{"t":"talk",id,text|file}` — 사람은 people 연결(24812), 맥은 파일 채널. 파일을 톡 창에 놓으면 켜진 사람 모두 + 맥에게 파일, 톡에는 카드.
- **빠른 톡**: 펫 오른쪽 클릭 → 패널이 펫 위에 작게(`panel-show` = `"quick"`), 켜진 친한 친구(`people:<pk>.fav`, 패널 ⭐)에게 `{"t":"poke",text}`. 저장 안 함. 받는 PC: 펫 위로 보낸 사람 얼굴 + 말풍선(끌기 오버레이 `poke`), 6초 · 마우스를 올리면 머무름 · 누르면 닫힘 · 답장 없음. 펫 메뉴(이미지 · 효과 · 제자리)는 입력 오른쪽 ⋯.
- **초대**: 톡 창 [+ 초대] → 고른 (켜진) 사람과 나머지 등록한 사람들에게 `{"t":"intro",people:[{pk,name}]}` → 받는 쪽이 서로 등록(`via` = 초대한 사람). 초대한 사람이 등록된 사람일 때만 연결이 열리므로 그 사람을 믿는다.
- **내 이름**: `people.name` — 비어 있으면 패널 맨 위에 "내 이름을 정해 주세요".
