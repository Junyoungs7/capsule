# Hera AI 연결 (MCP)

이 PC의 AI 도구(Claude Code, Claude Desktop, 그 밖의 MCP 클라이언트)가 Hera의 할 일·일정·메모·Island를 다룰 수 있게 한다.
**기본 꺼짐** — 패널 → 설정 → **AI 연결 (MCP)** 에서 켠다.

## 구조

```
MCP 클라이언트 ──stdio(JSON-RPC 2.0)── hera-mcp.exe ──이름 있는 파이프── Hera(hera.exe, mcp.rs) ── hera.json 스토어 → 창들 즉시 갱신
```

- `hera-mcp.exe` (src-tauri/src/bin/hera-mcp.rs): 클라이언트가 띄우는 작은 stdio 서버. `initialize`·`tools/list`·`resources/list`는 직접 답하고
  `tools/call`·`resources/read`만 Hera로 넘긴다. 그래서 Hera가 꺼져 있어도 도구 목록은 보이고, 호출은 `Hera가 실행 중이 아니에요` 오류를 돌려준다.
  요청마다 새로 연결하므로 Hera를 다시 켜도 클라이언트를 재시작할 필요가 없다.
- 공용 코드 (src-tauri/src/mcp_proto.rs): 도구 정의·JSON 스키마·인자 검사·JSON-RPC 처리·ISO 시각. std + serde_json만 쓴다.
  공식 Rust SDK(`rmcp`)는 tokio·schemars 등을 끌어와서, 손으로 짠 JSON-RPC 몇십 줄로 대신했다.
- Hera 쪽 (src-tauri/src/mcp.rs): 파이프 서버, 권한·확인, 도구 실행. 데이터는 UI와 같은 스토어 키(`todo:<id>`, `event:<id>`, `note:<id>`, `shelf:<id>`)에
  쓰기 때문에 열려 있는 창이 store 변경 이벤트로 바로 따라온다.
- 설치: hera-mcp.exe는 같은 Cargo 패키지의 두 번째 바이너리다. Tauri 번들러가 패키지의 모든 `[[bin]]`을 hera.exe 옆에 설치한다
  (기본 위치 `%LOCALAPPDATA%\Hera\hera-mcp.exe`). 설정 화면에 실제 경로가 나온다.

## 연결하기

**Claude Code**

```
claude mcp add hera -- "C:\Users\<나>\AppData\Local\Hera\hera-mcp.exe"
```

**Claude Desktop** — 설정 → 개발자 → 구성 편집 (`%APPDATA%\Claude\claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "hera": { "command": "C:\\Users\\<나>\\AppData\\Local\\Hera\\hera-mcp.exe" }
  }
}
```

설정 화면의 **복사** 버튼이 경로가 채워진 명령과 JSON을 복사해 준다. 다른 클라이언트는 명령 = hera-mcp.exe 경로, 인자 없음, stdio로 등록하면 된다.

## 도구

| 도구 | 그룹 | 확인 | 하는 일 |
|---|---|---|---|
| `list_todos(include_done?)` | 읽기 | | 할 일 목록 |
| `add_todo(title, due?)` | 쓰기 | | 할 일 추가 (due 시각에 Island 알림) |
| `complete_todo(id, done?)` | 쓰기 | | 완료 / 되돌리기 |
| `update_todo(id, title?, due?)` | 쓰기 | | 수정 (`due: ""` = 마감 삭제) |
| `list_events(from?, to?)` | 읽기 | | 기간과 겹치는 일정 (기본 오늘부터 7일) |
| `add_event(title, start, end?)` | 쓰기 | | 일정 추가 (end 없으면 1시간) |
| `update_event(id, title?, start?, end?)` | 쓰기 | | 일정 수정 |
| `delete_event(id)` | 쓰기 | ✔ | 일정 삭제 |
| `list_notes()` | 읽기 | | 메모 목록 |
| `add_note(text, color?, app?)` | 쓰기 | | 메모 추가 |
| `update_note(id, text?, color?, app?)` | 쓰기 | | 메모 수정 |
| `show_island_alert(title, body?)` | 화면 | | Island 알림 카드 |
| `start_effect(kind)` | 화면 | | 전체화면 효과 `snow·rain·leaves·dawn·sunset·moon` (전체화면 앱 중엔 거절) |
| `start_ascii()` | 화면 | | 아스키 아트 전체화면 (장면은 계절·시간으로 자동) |
| `list_running_apps()` | 읽기 | | 열린 앱 창 |
| `launch(target)` | 실행 | ✔ | exe/lnk 경로, URL, `shell:AppsFolder\AUMID`, 독 레코드 이름 |
| `activate_app(name)` | 실행 | ✔ | 제목이나 exe 이름이 맞는 창을 앞으로 |
| `add_to_shelf(path)` | 파일 | ✔ | 독 선반에 파일 놓기 (최대 4개, 오래된 것부터 빠짐) |
| `send_to_mac(path)` | 파일 | ✔ | Hera Link로 연결된 Mac에 파일 보내기 |
| `search_clipboard_history(query?)` | 클립보드 기록 | | 최근 복사한 텍스트 (메모리 20개) |
| `get_status()` | 읽기 | | 현재 시각·시간대, Link/Mac 연결, 포그라운드 앱, 다음 항목 |

리소스(읽기 그룹): `hera://today`(오늘 일정 + 오늘까지 마감이거나 기한 없는 미완료 할 일), `hera://notes`.

- 시각은 **시간대가 있는 ISO 8601**만 받는다 (`2026-11-15T09:00:00+09:00`, `…Z`). 저장할 때는 UI와 같은 UTC `…Z` 형식으로 바꾼다
  (watch 루프의 알림이 이 형식만 읽는다). 시간대 없는 값은 애매해서 오류로 돌려보낸다. 지금 시각과 시간대는 `get_status`로 알 수 있다.
- 인자는 스키마대로 검사한다: 필수 인자, 타입, enum, 알 수 없는 인자 거부, 문자열 최대 10,000자.
- 공유 그룹(Hera Team) 항목은 `group` 필드를 그대로 보여 준다. 그런 항목을 고치려면 쓰기 그룹이 켜져 있어야 하고,
  Island 칩과 확인 카드에 그룹 이름이 같이 나온다.
- 메모 저장 형식: `note:<id>` = `{ id, text, color?, app?, at }` (at = epoch ms).

## 권한

설정 → AI 연결 (MCP):

| 스위치 | 기본 |
|---|---|
| AI 연결 전체 (`mcp.enabled`) | **꺼짐** |
| 읽기 — 할 일·일정·메모·실행 중 앱 조회 | 켜짐 |
| 쓰기 — 할 일·일정·메모 추가/수정/완료 | 켜짐 |
| 화면 — Island 알림·효과·아스키 | 켜짐 |
| 실행 — 앱/URL 실행·창 활성화 | 꺼짐 |
| 파일 — 선반·Mac으로 보내기 | 꺼짐 |
| 클립보드 기록 읽기 | 꺼짐 |
| Island에 "AI · 도구" 칩 표시 (`mcp.chip`) | 켜짐 |

- 저장 키: `mcp.enabled`, `mcp.perms` (`{read, write, screen, exec, files, clip}`), `mcp.always` (항상 허용한 도구 이름), `mcp.chip`.
  Hera는 **호출할 때마다** 다시 읽기 때문에 스위치를 바꾸면 바로 적용된다.
- 꺼진 그룹의 도구를 부르면 `Hera 설정에서 '실행' 권한이 꺼져 있어요` 같은 오류가 간다. 도구 목록은 권한과 상관없이 늘 같다.
- **확인 카드**: 실행·파일 그룹과 삭제는 Island에 `AI가 '…'을(를) 하려고 해요 [허용][거부]` 카드가 뜬다. 20초 안에 답하지 않으면 거부된다.
  카드에서 **항상 허용**을 체크하고 허용하면 그 도구는 다음부터 묻지 않는다. 설정의 "항상 허용한 도구"에서 눌러 해제한다.
- **기록**: 모든 호출(거절된 것 포함)을 메모리에 최근 50개 남긴다. 설정 → 최근 AI 호출 → 보기. 디스크에는 쓰지 않는다.

## 보안 모델

- **로컬 전용**: 네트워크 포트를 열지 않는다. 파이프는 `PIPE_REJECT_REMOTE_CLIENTS`로 만든다.
- **같은 사용자만**: 파이프 DACL = `D:P(A;;GA;;;<현재 사용자 SID>)`. 다른 계정, 다른 사람의 세션에서는 열 수 없다.
- **가로채기 방지**: Hera는 `FILE_FLAG_FIRST_PIPE_INSTANCE`로 파이프를 만든다. 다른 프로세스가 먼저 같은 이름을 만들었으면 Hera의 MCP는 켜지지 않는다
  (로그 `mcp pipe: …`). hera-mcp는 `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`으로 연결해서, 파이프 서버가 클라이언트 권한으로 가장(impersonate)할 수 없다.
- 파이프 이름 `\\.\pipe\hera-mcp-<USERDOMAIN\USERNAME 해시>`는 단지 이름일 뿐이다. 실제 보호는 DACL이 한다.
- **신뢰 경계**: 같은 사용자로 실행되는 프로그램은 hera-mcp 없이도 파이프에 직접 붙을 수 있다. 원래 그 사용자 권한으로 무엇이든 할 수 있는 프로그램이라
  새로 생기는 권한은 없지만, 그래서 **기본 꺼짐 + 그룹별 스위치 + 위험한 동작은 확인 카드**로 막는다. 인자 검사는 Hera 쪽에서 한다.
- AI가 파일 경로를 고르는 도구(`add_to_shelf`, `send_to_mac`)와 실행 도구(`launch`, `activate_app`)는 기본으로 꺼져 있고, 켜도 매번 확인 카드를 띄운다.
- 클립보드 기록은 비밀번호 같은 민감한 내용이 섞일 수 있어서 기본으로 꺼 두었다.

## 개발 · 테스트

```
cd src-tauri
cargo test            # mcp_proto(프레이밍·디스패치·스키마·ISO) · mcp(권한·확인·기록) · tests/mcp.rs(실제 hera-mcp.exe ↔ in-process 파이프 서버)
```

손으로 해 보기 (Hera 실행 중, 설정에서 켠 뒤):

```
echo {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_status"}} | src-tauri\target\debug\hera-mcp.exe
```

`HERA_MCP_PIPE` 환경 변수로 파이프 이름을 바꿀 수 있다 (테스트용).
