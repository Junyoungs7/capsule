# Hera Link 파일 채널 프로토콜 v1

윈도우 Hera(서버)와 맥 Hera(클라이언트) 사이의 파일·클립보드 기록 채널. 마우스·키보드·클립보드 동기화는
별도의 **입력 엔진**(내장 deskflow-core, barrier 프로토콜, 포트 24800)이 맡고, 이 채널은 Hera 끼리만 쓴다.

참조 구현: `src-tauri/src/link_files.rs` (플랫폼 코드 없음 — 맥 빌드도 같은 파일을 그대로 쓴다).
단위 시험: `cargo test --lib link_files` (루프백 두 끝점: 페어링 → 파일 양방향 → 해시 확인 → 재접속).

## 1. 전송

| 항목 | 값 |
|---|---|
| 데이터 | TCP, 윈도우가 `0.0.0.0:<filePort>` 에서 대기 (기본 **24810**, 설정 `link.cfg.filePort`) |
| 발견 | UDP 브로드캐스트 비콘, 포트 **24811** |
| 역할 | 윈도우 = 서버(대기), 맥 = 클라이언트(접속). 연결은 한 번에 1개, 새 접속이 오면 이전 연결을 닫는다 |

### 비콘 (평문 UDP)
윈도우가 링크가 켜져 있고 준비된 연결이 없을 때 3초마다 `255.255.255.255:24811` 로 보낸다:
```json
{"hera":1,"name":"DEV-PC","port":24810}
```
맥은 24811 에서 듣다가 `hera == 1` 이면 **보낸 주소** + `port` 로 TCP 접속한다. 비콘은 신뢰하지 않는다
(누구나 보낼 수 있음) — 신원 확인은 아래 핸드셰이크·페어링이 한다. 엔진이 이미 연결된 맥 주소를 알면 그 주소로 바로 접속해도 된다.

## 2. 프레임

모든 메시지 = `u32 길이(빅엔디안)` + `내용`. 길이 상한 **1 MiB (1,048,576)** — 넘으면 연결을 끊는다.

- 각 방향의 **첫 프레임** = 평문 JSON `hello`.
- 그 뒤 모든 프레임 = ChaCha20-Poly1305 암호문(16바이트 태그 포함).

## 3. 핸드셰이크

양쪽이 동시에 `hello` 를 보낸다 (순서 무관):
```json
{"t":"hello","v":1,"name":"DEV-PC","pk":"<정적 X25519 공개키 hex 64>","eph":"<임시 X25519 공개키 hex 64>","fp":"<내 엔진 TLS 인증서 SHA-256 hex, 없으면 \"\">"}
```
- `pk` = 기기마다 1번 만들어 저장하는 장기 키 (윈도우: store `link.key` 에 비밀키 hex).
- `eph` = 연결마다 새로 만든 키.
- `v` 가 다르면 끊는다.

### 키 유도
```
dh1 = X25519(내 eph 비밀키, 상대 eph 공개키)
dh2 = X25519(내 정적 비밀키, 상대 정적 공개키)
ikm = dh1 || dh2                                   (64바이트)
prk = HKDF-SHA256-Extract(salt = "hera-link-v1", ikm)
T   = 클라이언트pk || 서버pk || 클라이언트eph || 서버eph   (각 32바이트, 항상 이 순서)
k_c2s = HKDF-Expand(prk, info = "c2s" || T, 32)
k_s2c = HKDF-Expand(prk, info = "s2c" || T, 32)
code  = HKDF-Expand(prk, info = "code" || T, 4) → u32(빅엔디안) % 1_000_000 → 6자리(앞을 0으로 채움)
```
클라이언트는 `k_c2s` 로 보내고 `k_s2c` 로 받는다. 서버는 반대.

### 암호화
- AEAD = ChaCha20-Poly1305, AAD 없음.
- nonce(12바이트) = `00 00 00 00` + `u64 카운터(빅엔디안)`. 방향마다 0부터 1씩 증가 (첫 암호 프레임 = 0).
- 복호 실패 = 연결 끊기 (키 불일치·변조).
- 평문 = `1바이트 종류` + 본문. 종류: **1 = JSON 제어**, **2 = 파일 조각**.

## 4. 페어링 (숫자 비교)

핸드셰이크 직후 양쪽이 먼저 보낸다:
```json
{"t":"state","paired":<상대 pk 를 이미 저장해 두었는가>}
```
- **양쪽 모두 true** → 바로 준비 완료.
- 아니면 양쪽 모두 화면에 `code` 를 보여 준다 (윈도우: Island + 패널, `"482 913"` 처럼 3·3).
  사용자가 두 화면의 숫자가 같으면 양쪽에서 "같아요". 각 쪽이 `{"t":"pair-ok"}` (취소면 `{"t":"pair-no"}`) 를 보내고
  상대의 응답을 받는다. 둘 다 `pair-ok` 이면 상대 `pk`·`name` 을 저장 (윈도우: store `link.peerPk`, `link.peerName`).
  120초 안에 확인이 없으면 `pair-no`.
- 중간자가 끼면 양쪽의 정적·임시 키가 달라져 코드가 달라진다 → 사용자가 거부.
- **엔진 TLS 지문 교환**: 페어링이 끝나면 각 쪽은 상대 hello 의 `fp` 를 엔진 신뢰 목록에 넣는다.
  - 윈도우(서버): `<엔진 폴더>/settings/tls/trusted-clients` 에 `v2:sha256:<hex>` 한 줄 (Deskflow 1.27 형식).
  - 맥(클라이언트): 맥 deskflow-core 의 trusted-servers 파일에 같은 형식으로 (`~/Library/Deskflow/tls/trusted-servers` — 맥 포트에서 실제 경로 확인).
  → 엔진 첫 연결에서 지문을 따로 묻지 않는다.

## 5. 메시지 (종류 1 = JSON)

| t | 방향 | 필드 | 뜻 |
|---|---|---|---|
| `state` | 양쪽 | `paired` | 위 4장 |
| `pair-ok` / `pair-no` | 양쪽 | — | 페어링 확인 결과 |
| `offer` | 보내는 쪽 | `id`(u32, 보내는 쪽에서 1부터), `name`, `size`(u64 바이트), `sha256`(hex 소문자) | 파일 시작 |
| `done` | 보내는 쪽 | `id` | 조각 끝 |
| `ack` | 받는 쪽 | `id`, `ok`(bool), `error`(실패 시 문자열) | 크기·해시 확인 결과 |
| `clip` | 양쪽 | `text` (≤ 64K 글자) | 클립보드 **기록** 항목 — 받는 쪽은 기록 목록에만 넣고 클립보드는 건드리지 않는다 |
| `ping` | 양쪽 | — | 무시해도 됨 (유지용) |
| `bye` | 양쪽 | — | 곧 닫음 — 받으면 읽기 루프를 끝낸다 (닫는 쪽은 그 뒤 shutdown) |
| `monitors` | 양쪽 | `list: [{id, rect:[x,y,w,h], scale, primary}]` | 내 모니터 (rect = 내 OS 가상 데스크톱 좌표: 윈도우 물리 px, 맥 포인트). 받는 쪽은 배치 캔버스에 상대 모니터로 쓴다 (윈도우: store `link.macMonitors` → 엔진 링크 다시 생성) |
| `crossed` | 양쪽 | `enter`(bool), `x`,`y`(enter=true 일 때, **받는 쪽 좌표**) | 커서가 넘어감. enter=true: 받는 쪽 화면에 (x,y) 로 들어왔음 → 그 가장자리에 진한 파란 물결. enter=false: 받는 쪽 화면에서 떠났음 → 받는 쪽은 자기 커서 위치에 옅은 물결 |
| `ambient` | 양쪽 | `kind`: ascii \| saver \| fx, `fx`: snow\|rain\|leaves\|sunset\|dawn\|moon (kind=fx), `action`: start \| stop | 받는 쪽 화면에 아스키 전체화면·화면보호기·효과를 켜거나 끈다 (받는 쪽 입력이 생기면 원래 규칙대로 꺼짐) |
| `sync` | 양쪽 | `items: [{key, value\|null, at, scope}]` | 할 일·일정 동기화 (7장) |
| `keymap` | 윈도우→맥 | `preset`: habit\|position\|shortcuts\|custom, `rows`: [[윈도우키, 맥키]…], `ime`: hera\|capslock\|ctrl-space\|cmd-space\|off | 키 매핑 설정 알림. 수식키 바꾸기는 **엔진**이 이미 한다 (윈도우가 엔진 설정에 넣음). 맥 Hera 는 `shortcuts` 일 때만 직접 처리: Ctrl+C/V/X/Z/A/S/F/T/W/R/L/Q(+Shift) → ⌘+같은 키 (CGEventTap, 손쉬운 사용 권한) |
| `ime` | 윈도우→맥 / 맥→윈도우 | `action`: toggle \| set \| state, `source`: "ko"\|"en" (set·state) | 윈도우→맥 toggle: 커서가 맥에 있을 때 윈도우 키보드의 한/영 → 맥 Hera 가 입력 소스 전환(TISSelectInputSource) 후 `{"t":"ime","action":"state","source":…}` 로 답한다 → 윈도우 Island 에 "한"/"A" 칩 |

모르는 `t` 는 무시한다 (앞으로의 확장).

`offer` 는 부가 필드를 가질 수 있다: `via`: "edge"(화면 가장자리로 끌어 보냄), `edge`: 받는 쪽 화면의 가장자리(left/right/up/down), `pos`: 그 가장자리 위 위치 0..1.
받는 쪽은 `via == "edge"` 면 자기 화면 그 자리에 진한 물결을 그리고 파일을 선반에 놓는다.
(입력 엔진은 OLE/NSDraggingSession 드래그를 실어 나르지 못한다 — 끌고 가장자리에 닿으면 Hera 의 가장자리 띠가 받아 이 채널로 보낸다.)

### 파일 조각 (종류 2)
본문 = `u32 id(빅엔디안)` + 데이터 (보내는 쪽은 64 KiB 씩). 현재 `offer` 의 id 와 다르면 무시.

### 파일 전송 순서
```
보내는 쪽: offer → chunk… → done → (ack 대기, 120초)
받는 쪽:   offer 받으면 다운로드 폴더에 임시 파일(.hera-<id>-<pid>.part) 열기
           chunk 마다 쓰기 + SHA-256 누적 (약속 크기를 넘으면 버림)
           done: 크기 == size && 해시 == sha256 → 이름 정리 후 이동, ack ok=true
                 아니면 임시 파일 삭제, ack ok=false error="hash mismatch"
```
- 받는 위치: 윈도우 `%USERPROFILE%\Downloads\Hera\`, 맥 `~/Downloads/Hera/`. 받은 뒤 독 선반에 올린다.
- 이름 정리: `\ / : * ? " < > |` 와 제어 문자 → `_`, 앞뒤 `.`·공백 제거, 비면 `file`, 같은 이름이 있으면 `이름 (2).확장자`…
- 한 연결에서 파일은 한 번에 하나씩 (받는 쪽은 진행 중인 offer 1개만 기억).

## 7. 할 일·일정 동기화 (`sync`)
- 대상 store 키: `todo:<id>`, `event:<id>`. 항목마다 `at` = 마지막 변경 시각(epoch ms), 지움 = `value: null`(묘비).
- **마지막에 쓴 쪽이 이김 (LWW)**: 받은 항목의 `at` 이 내 기록보다 **클 때만** 적용(같으면 무시 → 왕복 없음). 묘비도 같은 규칙 — 지운 뒤의 옛 수정은 되살리지 않는다.
- 접속 직후 양쪽이 전체(살아 있는 항목 + 묘비)를 한 번 보내고, 이후 바뀔 때마다 그 항목만 보낸다. 받은 변경을 적용할 때 생기는 내 변경 알림은 다시 보내지 않는다.
- 묘비는 30일 뒤 정리. 메타(키 → 시각·지움)는 store `sync.meta`.
- `scope`: "personal" (두 PC 사이) | "group:<id>" (Hera Team — 나중에 그룹 채널로. 이 채널은 personal 만 주고받는다).
- **알림은 커서가 있는 PC 에서만** 울린다: 윈도우는 엔진의 화면 전환 상태로, 맥은 `crossed` 로 판단. 커서가 없는 쪽은 그 알림을 '울림'으로 표시만 해서 나중에 중복으로 울리지 않는다. 완료·다시 알림은 할 일 항목 변경(done / snooze)이라 동기화로 전파된다.

## 8. 화면 표시 (참고)
- 진행: 100ms 마다 `bytes/size` → Island 진행 바.
- 보내기 끝: Island 이 접혔다 펴짐(삼킴). 받기 끝: 튀어나오고 파일이 선반으로 날아감.

## 9. 보안 메모
- 비밀키는 각 기기 사용자 프로필 안 (윈도우: `%APPDATA%\dev.hera.dock\hera.json`).
- 페어링 해제 = 저장한 상대 pk 삭제 → 다음 접속에서 다시 코드 확인.
- 회사 방화벽이 24810/24811 을 막으면 연결이 안 된다 → 패널에 "파일 채널" 상태로 보인다.
