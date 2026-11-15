//! Hera MCP 공용 부분 (hera.exe 의 mcp.rs 와 hera-mcp.exe 가 `#[path]` 로 같이 쓴다 — std + serde_json 만).
//! 도구 정의 · 인자 스키마 검사 · JSON-RPC 2.0(MCP stdio) 처리 · 파이프 이름 · ISO 시각.
//!
//! 파이프 프로토콜(hera-mcp ↔ Hera, 한 줄 = JSON 1개): 요청 `{"tool":name,"args":{..}}` 또는 `{"resource":uri}`
//! → 응답 `{"ok":값}` 또는 `{"err":"메시지"}`. 연결 1개에 요청 여러 개 가능, hera-mcp 는 요청마다 새로 연결한다.
#![allow(dead_code)] // 두 바이너리가 서로 다른 부분을 쓴다

use serde_json::{json, Map, Value};

pub const PROTOCOL: &str = "2025-06-18";
pub const NOT_RUNNING: &str = "Hera가 실행 중이 아니에요 — Hera를 먼저 켜 주세요. (Hera is not running)";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Group {
    Read,
    Write,
    Screen,
    Exec,
    Files,
    Clip,
}

impl Group {
    /// 저장 키 (`mcp.perms` 객체의 필드)
    pub fn key(self) -> &'static str {
        match self {
            Group::Read => "read",
            Group::Write => "write",
            Group::Screen => "screen",
            Group::Exec => "exec",
            Group::Files => "files",
            Group::Clip => "clip",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Group::Read => "읽기",
            Group::Write => "쓰기",
            Group::Screen => "화면",
            Group::Exec => "실행",
            Group::Files => "파일",
            Group::Clip => "클립보드 기록",
        }
    }
    pub fn default_on(self) -> bool {
        matches!(self, Group::Read | Group::Write | Group::Screen)
    }
}

/// 인자 1개: (이름, 타입, 설명). 타입 = "string" | "boolean" | "integer" | "enum:a|b|c"
type Prop = (&'static str, &'static str, &'static str);

pub struct Tool {
    pub name: &'static str,
    pub group: Group,
    /// Island 확인 카드 필요 (실행·파일 그룹, 삭제)
    pub confirm: bool,
    /// 확인 카드·칩에 쓰는 짧은 한국어 동작 이름
    pub ko: &'static str,
    pub desc: &'static str,
    pub props: &'static [Prop],
    pub required: &'static [&'static str],
}

const ISO: &str = "ISO 8601 시각, 시간대 포함 / ISO 8601 with offset, e.g. 2026-11-15T09:00:00+09:00";

pub static TOOLS: &[Tool] = &[
    Tool { name: "list_todos", group: Group::Read, confirm: false, ko: "할 일 보기",
        desc: "Hera 할 일 목록 / List Hera to-dos. 공유 그룹 항목은 group 필드가 있어요.",
        props: &[("include_done", "boolean", "완료한 것도 포함 / include completed (default false)")], required: &[] },
    Tool { name: "add_todo", group: Group::Write, confirm: false, ko: "할 일 추가",
        desc: "할 일 추가 / Add a to-do (due 시각에 Island 알림).",
        props: &[("title", "string", "제목 / title"), ("due", "string", ISO)], required: &["title"] },
    Tool { name: "complete_todo", group: Group::Write, confirm: false, ko: "할 일 완료",
        desc: "할 일 완료(또는 되돌리기) / Mark a to-do done or not done.",
        props: &[("id", "string", "할 일 id / to-do id"), ("done", "boolean", "기본 true / default true")], required: &["id"] },
    Tool { name: "update_todo", group: Group::Write, confirm: false, ko: "할 일 수정",
        desc: "할 일 제목·마감 수정 / Update a to-do. due 를 빈 문자열로 주면 마감 삭제.",
        props: &[("id", "string", "할 일 id"), ("title", "string", "새 제목 / new title"), ("due", "string", ISO)], required: &["id"] },
    Tool { name: "list_events", group: Group::Read, confirm: false, ko: "일정 보기",
        desc: "기간 안의 일정 / List calendar events overlapping [from, to). 기본 = 오늘부터 7일.",
        props: &[("from", "string", ISO), ("to", "string", ISO)], required: &[] },
    Tool { name: "add_event", group: Group::Write, confirm: false, ko: "일정 추가",
        desc: "일정 추가 / Add a calendar event. end 없으면 1시간.",
        props: &[("group", "string", "Hera Team 공유 달력 (그룹 이름 또는 id) / shared team calendar"), ("title", "string", "제목 / title"), ("start", "string", ISO), ("end", "string", ISO)], required: &["title", "start"] },
    Tool { name: "update_event", group: Group::Write, confirm: false, ko: "일정 수정",
        desc: "일정 수정 / Update a calendar event.",
        props: &[("id", "string", "일정 id"), ("title", "string", "새 제목"), ("start", "string", ISO), ("end", "string", ISO)], required: &["id"] },
    Tool { name: "delete_event", group: Group::Write, confirm: true, ko: "일정 삭제",
        desc: "일정 삭제(사용자 확인 필요) / Delete a calendar event (asks the user).",
        props: &[("id", "string", "일정 id")], required: &["id"] },
    Tool { name: "list_notes", group: Group::Read, confirm: false, ko: "메모 보기",
        desc: "메모(포스트잇) 목록 / List sticky notes.", props: &[], required: &[] },
    Tool { name: "add_note", group: Group::Write, confirm: false, ko: "메모 추가",
        desc: "메모 추가 / Add a sticky note.",
        props: &[
            ("text", "string", "내용 / text"),
            ("color", "string", "색: yellow|pink|blue|green|purple|orange 또는 0–5 / color"),
            ("app", "string", "이 앱이 앞에 있을 때만 보이는 앱 메모 — 독 레코드 이름 / show only with this app (dock record title)"),
            ("group", "string", "Hera Team 공유 메모판 (그룹 이름 또는 id) / shared team board"),
            ("pinned", "boolean", "고정 / pinned"),
        ],
        required: &["text"] },
    Tool { name: "update_note", group: Group::Write, confirm: false, ko: "메모 수정",
        desc: "메모 수정 / Update a sticky note.",
        props: &[("id", "string", "메모 id"), ("text", "string", "내용"), ("color", "string", "색 (이름 또는 0–5)"), ("pinned", "boolean", "고정")], required: &["id"] },
    Tool { name: "show_island_alert", group: Group::Screen, confirm: false, ko: "알림 띄우기",
        desc: "Island 에 알림 카드 띄우기 / Show an alert card in the Island.",
        props: &[("title", "string", "제목 / title"), ("body", "string", "본문 / body")], required: &["title"] },
    Tool { name: "start_effect", group: Group::Screen, confirm: false, ko: "화면 효과",
        desc: "전체화면 날씨·시간 효과 25초 / Play a full-screen effect for ~25s (전체화면 앱 중엔 무시).",
        props: &[("kind", "enum:snow|rain|leaves|dawn|sunset|moon", "효과 종류 / effect kind")], required: &["kind"] },
    Tool { name: "start_ascii", group: Group::Screen, confirm: false, ko: "아스키 아트",
        desc: "아스키 아트 전체화면 열기 / Open the full-screen ASCII art scene.",
        props: &[("scene", "string", "xmas|city|autumn|calm|auto (기본 auto = 계절·시간대) / scene")], required: &[] },
    Tool { name: "list_running_apps", group: Group::Read, confirm: false, ko: "실행 중 앱 보기",
        desc: "실행 중인 앱 창 목록 / List open app windows.", props: &[], required: &[] },
    Tool { name: "launch", group: Group::Exec, confirm: true, ko: "실행",
        desc: "앱·파일·URL 실행(사용자 확인 필요) / Launch an app, file or URL (asks the user). 독 레코드 이름도 돼요.",
        props: &[("target", "string", "exe/lnk 경로, URL, shell:AppsFolder\\AUMID 또는 레코드 이름 / path, URL, AUMID or record title")],
        required: &["target"] },
    Tool { name: "activate_app", group: Group::Exec, confirm: true, ko: "창 활성화",
        desc: "실행 중인 앱 창을 앞으로(사용자 확인 필요) / Bring a running app window to front (asks the user).",
        props: &[("name", "string", "창 제목이나 exe 이름 일부 / part of window title or exe name")], required: &["name"] },
    Tool { name: "add_to_shelf", group: Group::Files, confirm: true, ko: "선반에 놓기",
        desc: "파일을 독 선반에 놓기(최대 4개, 사용자 확인 필요) / Put a file on the dock shelf (asks the user).",
        props: &[("path", "string", "파일 절대 경로 / absolute file path")], required: &["path"] },
    Tool { name: "send_to_mac", group: Group::Files, confirm: true, ko: "Mac으로 보내기",
        desc: "Hera Link 로 연결된 Mac 에 파일 보내기(사용자 확인 필요) / Send a file to the linked Mac (asks the user).",
        props: &[("path", "string", "파일 절대 경로 / absolute file path")], required: &["path"] },
    Tool { name: "search_clipboard_history", group: Group::Clip, confirm: false, ko: "클립보드 기록 검색",
        desc: "최근 복사한 텍스트 검색(메모리 20개) / Search recent clipboard text.",
        props: &[("query", "string", "검색어, 비우면 전부 / query, empty = all")], required: &[] },
    Tool { name: "get_status", group: Group::Read, confirm: false, ko: "상태 보기",
        desc: "현재 시각·시간대, Hera Link/Mac 연결, 포그라운드 앱, 다음 할 일·일정 / Current time, link, foreground app, next item.",
        props: &[], required: &[] },
];

pub static RESOURCES: &[(&str, &str, &str)] = &[
    ("hera://today", "오늘 / Today", "오늘 일정과 마감·미완료 할 일 / today's events and due to-dos"),
    ("hera://notes", "메모 / Notes", "모든 메모 / all sticky notes"),
];

pub fn tool(name: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|t| t.name == name)
}

impl Tool {
    pub fn schema(&self) -> Value {
        let props: Map<String, Value> = self
            .props
            .iter()
            .map(|(n, ty, d)| {
                let v = match ty.strip_prefix("enum:") {
                    Some(e) => json!({"type": "string", "enum": e.split('|').collect::<Vec<_>>(), "description": d}),
                    None => json!({"type": ty, "description": d}),
                };
                (n.to_string(), v)
            })
            .collect();
        json!({"type": "object", "properties": props, "required": self.required, "additionalProperties": false})
    }
}

const MAX_STR: usize = 10_000;

/// 인자 검사: 객체 · 필수 · 알 수 없는 인자 · 타입 · enum · 길이
pub fn validate(t: &Tool, args: &Value) -> Result<(), String> {
    let Some(m) = args.as_object() else { return Err("arguments 는 객체여야 해요 (arguments must be an object)".into()) };
    for r in t.required {
        if m.get(*r).is_none_or(Value::is_null) {
            return Err(format!("'{r}' 인자가 필요해요 (missing required argument '{r}')"));
        }
    }
    for (k, v) in m {
        let Some((_, ty, _)) = t.props.iter().find(|p| p.0 == k) else {
            return Err(format!("알 수 없는 인자 '{k}' (unknown argument '{k}')"));
        };
        if v.is_null() {
            continue;
        }
        let ok = match *ty {
            "boolean" => v.is_boolean(),
            "integer" => v.is_i64() || v.is_u64(),
            "string" => v.as_str().is_some_and(|s| s.len() <= MAX_STR),
            e => e.strip_prefix("enum:").is_some_and(|e| v.as_str().is_some_and(|s| e.split('|').any(|x| x == s))),
        };
        if !ok {
            return Err(format!("'{k}' 값이 잘못됐어요 — {ty} 이어야 해요 (invalid '{k}': expected {ty})"));
        }
    }
    Ok(())
}

/// MCP stdio 한 줄 처리. 알림(id 없음) → None. tools/call·resources/read 만 `forward` 로 Hera 에 보낸다
/// (나머지는 여기서 바로 답해 Hera 가 꺼져 있어도 목록은 보이고, 호출은 분명한 오류를 돌려준다).
pub fn handle(line: &str, forward: &mut dyn FnMut(Value) -> Result<Value, String>) -> Option<Value> {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": format!("parse error: {e}")}})),
    };
    let id = req.get("id").filter(|v| !v.is_null())?.clone();
    let p = &req["params"];
    let ok = |result: Value| Some(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    let err = |code: i64, msg: String| Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": msg}}));
    match req["method"].as_str().unwrap_or_default() {
        "initialize" => ok(json!({
            "protocolVersion": p["protocolVersion"].as_str().unwrap_or(PROTOCOL),
            "capabilities": {"tools": {}, "resources": {}},
            "serverInfo": {"name": "hera", "title": "Hera", "version": env!("CARGO_PKG_VERSION")},
            "instructions": "Hera(윈도우 독·Island) 의 할 일·일정·메모·알림을 다루는 도구. 시각은 시간대가 있는 ISO 8601 로 주세요 — 지금 시각·시간대는 get_status. 권한은 사용자가 Hera 설정 → AI 연결(MCP)에서 정해요."
        })),
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({"tools": TOOLS.iter().map(|t| json!({"name": t.name, "description": format!("[{}] {}", t.group.label(), t.desc), "inputSchema": t.schema()})).collect::<Vec<_>>()})),
        "resources/list" => ok(json!({"resources": RESOURCES.iter().map(|(u, n, d)| json!({"uri": u, "name": n, "description": d, "mimeType": "application/json"})).collect::<Vec<_>>()})),
        "resources/templates/list" => ok(json!({"resourceTemplates": []})),
        "prompts/list" => ok(json!({"prompts": []})),
        "tools/call" => {
            let name = p["name"].as_str().unwrap_or_default();
            if tool(name).is_none() {
                return err(-32602, format!("알 수 없는 도구 '{name}' (unknown tool)"));
            }
            let args = if p["arguments"].is_null() { json!({}) } else { p["arguments"].clone() };
            let (text, is_err) = match forward(json!({"tool": name, "args": args})) {
                Ok(Value::String(s)) => (s, false),
                Ok(v) => (serde_json::to_string_pretty(&v).unwrap_or_default(), false),
                Err(e) => (e, true),
            };
            ok(json!({"content": [{"type": "text", "text": text}], "isError": is_err}))
        }
        "resources/read" => {
            let uri = p["uri"].as_str().unwrap_or_default();
            if !RESOURCES.iter().any(|r| r.0 == uri) {
                return err(-32002, format!("resource not found: {uri}"));
            }
            match forward(json!({"resource": uri})) {
                Ok(v) => ok(json!({"contents": [{"uri": uri, "mimeType": "application/json", "text": serde_json::to_string_pretty(&v).unwrap_or_default()}]})),
                Err(e) => err(-32603, e),
            }
        }
        m => err(-32601, format!("method not found: {m}")),
    }
}

/// 파이프 응답 한 줄 → Result
pub fn reply(line: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(line).map_err(|e| format!("Hera 응답을 읽지 못했어요: {e}"))?;
    match v.get("err").and_then(Value::as_str) {
        Some(e) => Err(e.to_string()),
        None => Ok(v.get("ok").cloned().unwrap_or(Value::Null)),
    }
}

/// `\\.\pipe\hera-mcp-<사용자 해시>` — 같은 사용자의 Hera·hera-mcp 가 같은 이름을 얻는다 (실제 보호는 파이프 DACL).
pub fn pipe_name() -> String {
    let user = format!("{}\\{}", std::env::var("USERDOMAIN").unwrap_or_default(), std::env::var("USERNAME").unwrap_or_default()).to_lowercase();
    let h = user.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100_0000_01b3));
    format!(r"\\.\pipe\hera-mcp-{h:016x}")
}

/* ── ISO 8601 ↔ epoch ms (시간대 필수). 저장은 JS toISOString 과 같은 UTC "…Z" 로 — watch 루프 알림이 이 형식만 읽는다 ── */

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

pub fn parse_iso(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    if b.len() < 16 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' {
        return None;
    }
    let (y, mo, d, h, mi) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?);
    let mut i = 16;
    let mut sec = 0;
    let mut ms = 0;
    if b.get(i) == Some(&b':') {
        sec = n(i + 1..i + 3)?;
        i += 3;
        if b.get(i) == Some(&b'.') {
            let end = (i + 1..b.len()).find(|&j| !b[j].is_ascii_digit()).unwrap_or(b.len());
            let frac = s.get(i + 1..end)?;
            ms = format!("{frac:0<3}").get(..3)?.parse().ok()?;
            i = end;
        }
    }
    let off = match s.get(i..)? {
        "Z" | "z" => 0,
        t if t.len() == 6 && matches!(&t[..1], "+" | "-") && &t[3..4] == ":" => {
            let v = t[1..3].parse::<i64>().ok()? * 60 + t[4..6].parse::<i64>().ok()?;
            if t.starts_with('-') { -v } else { v }
        }
        _ => return None, // 시간대 없는 로컬 시각은 받지 않는다 (애매함)
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    Some(((days_from_civil(y, mo, d) * 24 + h) * 60 + mi - off) * 60_000 + sec * 1000 + ms)
}

pub fn fmt_iso(ms: i64) -> String {
    let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

/// 시간대 있는 ISO → 저장 형식(UTC Z). 오류 메시지는 AI 가 고칠 수 있게.
pub fn norm_iso(field: &str, s: &str) -> Result<String, String> {
    parse_iso(s).map(fmt_iso).ok_or_else(|| format!("'{field}' 시각을 읽지 못했어요: '{s}' — 시간대를 포함한 ISO 8601 로 (e.g. 2026-11-15T09:00:00+09:00)"))
}

/// 현지 자정 (tz_min = UTC 와의 차, 분)
pub fn local_day_start(now_ms: i64, tz_min: i64) -> i64 {
    let off = tz_min * 60_000;
    (now_ms + off).div_euclid(86_400_000) * 86_400_000 - off
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rpc(line: &str) -> Option<Value> {
        handle(line, &mut |req| Ok(json!({"echo": req})))
    }

    #[test]
    fn framing_and_dispatch() {
        let r = rpc(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#).unwrap();
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "hera");
        assert!(rpc(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).is_none());
        assert_eq!(rpc("{nope").unwrap()["error"]["code"], -32700);
        assert_eq!(rpc(r#"{"jsonrpc":"2.0","id":"x","method":"bogus"}"#).unwrap()["error"]["code"], -32601);
        let list = rpc(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).unwrap();
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), TOOLS.len());
        assert_eq!(list["result"]["tools"][0]["inputSchema"]["type"], "object");
        let call = rpc(r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_todo","arguments":{"title":"a"}}}"#).unwrap();
        assert_eq!(call["result"]["isError"], false);
        let echoed: Value = serde_json::from_str(call["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(echoed["echo"], json!({"tool": "add_todo", "args": {"title": "a"}}));
        assert_eq!(rpc(r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"rm_rf"}}"#).unwrap()["error"]["code"], -32602);
        let res = rpc(r#"{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"hera://today"}}"#).unwrap();
        assert!(res["result"]["contents"][0]["text"].as_str().unwrap().contains("hera://today"));
    }

    #[test]
    fn forward_error_becomes_tool_error() {
        let r = handle(r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_status"}}"#, &mut |_| Err(NOT_RUNNING.into())).unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert_eq!(r["result"]["content"][0]["text"], NOT_RUNNING);
        assert_eq!(reply(r#"{"err":"x"}"#), Err("x".into()));
        assert_eq!(reply(r#"{"ok":[1]}"#), Ok(json!([1])));
    }

    #[test]
    fn schema_validation() {
        let t = tool("add_event").unwrap();
        assert!(validate(t, &json!({"title": "a", "start": "2026-11-15T09:00:00Z"})).is_ok());
        assert!(validate(t, &json!({"title": "a"})).unwrap_err().contains("start"));
        assert!(validate(t, &json!({"title": 3, "start": "x"})).unwrap_err().contains("title"));
        assert!(validate(t, &json!({"title": "a", "start": "x", "evil": 1})).unwrap_err().contains("evil"));
        assert!(validate(t, &json!([])).is_err());
        let fx = tool("start_effect").unwrap();
        assert!(validate(fx, &json!({"kind": "snow"})).is_ok());
        assert!(validate(fx, &json!({"kind": "fire"})).is_err());
        assert!(validate(tool("complete_todo").unwrap(), &json!({"id": "1", "done": "yes"})).is_err());
        assert!(validate(tool("add_todo").unwrap(), &json!({"title": "x".repeat(MAX_STR + 1)})).is_err());
        // 모든 스키마: required 는 props 안에 있어야
        for t in TOOLS {
            assert!(t.required.iter().all(|r| t.props.iter().any(|p| p.0 == *r)), "{}", t.name);
        }
        // 실행·파일 그룹은 모두 확인 필요
        assert!(TOOLS.iter().filter(|t| matches!(t.group, Group::Exec | Group::Files)).all(|t| t.confirm));
    }

    #[test]
    fn iso() {
        assert_eq!(parse_iso("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso("2026-11-13T09:30:00.250Z"), Some(1_794_562_200_250));
        assert_eq!(parse_iso("2026-11-13T18:30:00.250+09:00"), Some(1_794_562_200_250));
        assert_eq!(parse_iso("2026-11-13T18:30+09:00"), Some(1_794_562_200_000));
        assert_eq!(parse_iso("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
        assert_eq!(parse_iso("2026-11-13T09:30"), None);
        assert_eq!(parse_iso("tomorrow"), None);
        assert_eq!(fmt_iso(1_794_562_200_250), "2026-11-13T09:30:00.250Z");
        assert_eq!(fmt_iso(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
        assert_eq!(norm_iso("due", "2026-11-13T18:30:00+09:00").unwrap(), "2026-11-13T09:30:00.000Z");
        // KST 2026-11-13 18:30 의 현지 자정 = 2026-11-12T15:00Z
        assert_eq!(fmt_iso(local_day_start(1_794_562_200_000, 540)), "2026-11-12T15:00:00.000Z");
    }

    #[test]
    fn pipe_name_is_stable() {
        assert_eq!(pipe_name(), pipe_name());
        assert!(pipe_name().starts_with(r"\\.\pipe\hera-mcp-"));
    }
}
