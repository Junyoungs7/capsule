//! AI 연결(MCP): hera-mcp.exe(stdio MCP 서버, src/bin/hera-mcp.rs)가 이 파이프로 도구 호출을 넘긴다.
//! 파이프 = 현재 사용자만(DACL) · 원격 거부. 데이터는 UI 와 같은 스토어(hera.json)로 읽고 써서 창들이 store 변경 이벤트로 바로 따라온다.
//! 설정(store): mcp.enabled(기본 꺼짐) · mcp.perms{read,write,screen,exec,files,clip} · mcp.always[도구] · mcp.chip. 문서: docs/mcp.md
#![cfg_attr(not(windows), allow(dead_code))] // 파이프 서버는 Windows 전용 — 맥은 docs/mac-port.md
#[path = "mcp_proto.rs"]
pub mod proto;

use proto::{Group, Tool};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

type Store = std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>;

const CONFIRM_SECS: u64 = 20;
const LOG_MAX: usize = 50;

/* ── 권한 · 확인 (순수 로직) ── */

pub struct Perms {
    pub enabled: bool,
    pub groups: Value,
    pub always: Vec<String>,
}

impl Perms {
    fn load(s: &Store) -> Self {
        Perms {
            enabled: s.get("mcp.enabled").and_then(|v| v.as_bool()).unwrap_or(false),
            groups: s.get("mcp.perms").unwrap_or(Value::Null),
            always: s.get("mcp.always").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default(),
        }
    }
    fn on(&self, g: Group) -> bool {
        self.groups[g.key()].as_bool().unwrap_or(g.default_on())
    }
}

#[derive(PartialEq, Debug)]
pub enum Gate {
    Allow,
    Confirm,
}

pub fn gate(p: &Perms, t: &Tool) -> Result<Gate, String> {
    if !p.enabled {
        return Err("Hera 설정에서 'AI 연결(MCP)'이 꺼져 있어요 — 패널 → 설정에서 켜 주세요. (MCP is disabled in Hera settings)".into());
    }
    if !p.on(t.group) {
        return Err(format!("Hera 설정에서 '{}' 권한이 꺼져 있어요. (permission group '{}' is off)", t.group.label(), t.group.key()));
    }
    Ok(if t.confirm && !p.always.iter().any(|a| a == t.name) { Gate::Confirm } else { Gate::Allow })
}

static NEXT: AtomicU64 = AtomicU64::new(1);
/// 확인 대기: (id, (허용, 항상 허용) 보낼 곳)
type Answer = mpsc::Sender<(bool, bool)>;
static PENDING: Mutex<Vec<(u64, Answer)>> = Mutex::new(Vec::new());

fn ask() -> (u64, mpsc::Receiver<(bool, bool)>) {
    let (tx, rx) = mpsc::channel();
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    PENDING.lock().unwrap().push((id, tx));
    (id, rx)
}

/// (허용, 항상 허용) — 시간 초과 = None(거부)
fn wait(id: u64, rx: &mpsc::Receiver<(bool, bool)>, timeout: Duration) -> Option<(bool, bool)> {
    let r = rx.recv_timeout(timeout).ok();
    PENDING.lock().unwrap().retain(|(i, _)| *i != id);
    r
}

fn answer(id: u64, ok: bool, always: bool) -> bool {
    let tx = PENDING.lock().unwrap().iter().find(|(i, _)| *i == id).map(|(_, t)| t.clone());
    tx.is_some_and(|t| t.send((ok, always)).is_ok())
}

/// Island 확인 카드 ("AI가 '…'을(를) 하려고 해요 [허용][거부]"), 20초 → 거부. '항상 허용' = mcp.always 에 추가.
fn confirm(app: &AppHandle, s: &Store, t: &Tool, text: &str, group: Option<&str>) -> bool {
    let (id, rx) = ask();
    let _ = app.emit_to("island", "mcp-confirm", json!({"id": id, "tool": t.name, "text": text, "group": group, "secs": CONFIRM_SECS}));
    let r = wait(id, &rx, Duration::from_secs(CONFIRM_SECS));
    let _ = app.emit_to("island", "mcp-confirm-done", id);
    let Some((ok, always)) = r else { return false };
    if ok && always {
        let mut a: Vec<String> = s.get("mcp.always").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        if !a.iter().any(|x| x == t.name) {
            a.push(t.name.into());
            s.set("mcp.always", json!(a));
        }
    }
    ok
}

/* ── 호출 기록 (메모리 50개) ── */

static LOG: Mutex<VecDeque<Value>> = Mutex::new(VecDeque::new());

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn log(entry: Value) {
    let mut l = LOG.lock().unwrap();
    if l.len() == LOG_MAX {
        l.pop_front();
    }
    l.push_back(entry);
}

/* ── 명령 (패널 설정 · Island 확인 카드) ── */

#[tauri::command]
pub fn mcp_log() -> Vec<Value> {
    LOG.lock().unwrap().iter().rev().cloned().collect()
}

/// hera-mcp.exe 경로 (hera.exe 옆 — 설치본·빌드 산출물 모두)
#[tauri::command]
pub fn mcp_info() -> String {
    let exe = if cfg!(windows) { "hera-mcp.exe" } else { "hera-mcp" };
    std::env::current_exe().ok().and_then(|p| Some(p.parent()?.join(exe).display().to_string())).unwrap_or_else(|| exe.into())
}

#[tauri::command]
pub fn mcp_confirm(id: u64, ok: bool, always: bool) {
    answer(id, ok, always);
}

/* ── 파이프 → 도구 ── */

pub fn start(app: AppHandle) {
    #[cfg(windows)]
    std::thread::spawn(move || {
        if let Err(e) = serve_pipe(&proto::pipe_name(), move |line| handle(&app, line)) {
            eprintln!("mcp pipe: {e}");
        }
    });
    #[cfg(not(windows))]
    let _ = app;
}

fn handle(app: &AppHandle, line: &str) -> String {
    let r = serde_json::from_str::<Value>(line).map_err(|e| e.to_string()).and_then(|req| call(app, &req));
    match r {
        Ok(v) => json!({"ok": v}),
        Err(e) => json!({"err": e}),
    }
    .to_string()
}

fn call(app: &AppHandle, req: &Value) -> Result<Value, String> {
    let s = app.store("hera.json").map_err(|e| e.to_string())?;
    let p = Perms::load(&s);
    if let Some(uri) = req["resource"].as_str() {
        gate(&p, proto::tool("list_notes").unwrap())?; // 리소스 = 읽기 그룹
        log(json!({"at": now_ms(), "tool": uri, "ok": true}));
        return resource(&s, uri);
    }
    let name = req["tool"].as_str().unwrap_or_default();
    let t = proto::tool(name).ok_or_else(|| format!("알 수 없는 도구 '{name}' (unknown tool)"))?;
    let args = if req["args"].is_null() { json!({}) } else { req["args"].clone() };
    // 대상 항목(있으면): 확인 문구·칩에 제목과 공유 그룹 이름을 보인다
    let target = args["id"].as_str().and_then(|id| find(&s, id));
    // 공유 그룹 이름 (대상 항목의 group, 또는 새로 만들 때 group 인자) — Island 칩·확인 카드에
    let group = target.as_ref().and_then(|v| v["group"].as_str().map(String::from)).or_else(|| args["group"].as_str().and_then(|g| group_id(&s, g))).map(|g| group_name(&s, &g));
    let what = target.as_ref().and_then(|v| v["title"].as_str().or(v["text"].as_str()).map(String::from)).or_else(|| {
        t.props.iter().find_map(|(k, ty, _)| (*ty != "boolean").then(|| args[*k].as_str().map(String::from)).flatten())
    });
    let text = match &what {
        Some(w) => format!("{} · {}", t.ko, w.chars().take(60).collect::<String>()),
        None => t.ko.to_string(),
    };
    let r = proto::validate(t, &args).and_then(|_| gate(&p, t)).and_then(|g| {
        if g == Gate::Confirm && !confirm(app, &s, t, &text, group.as_deref()) {
            return Err("사용자가 허용하지 않았어요 (denied by user or timed out)".into());
        }
        run(app, &s, t, &args)
    });
    log(json!({"at": now_ms(), "tool": t.name, "text": text, "group": group, "ok": r.is_ok(), "error": r.as_ref().err()}));
    if p.enabled && s.get("mcp.chip").and_then(|v| v.as_bool()).unwrap_or(true) {
        let _ = app.emit_to("island", "mcp-call", json!({"tool": t.name, "ko": t.ko, "group": group, "ok": r.is_ok()}));
    }
    r
}

/* ── 스토어 (UI 와 같은 키: todo:<id> · event:<id> · note:<id> · shelf:<id>) ── */

fn items(s: &Store, kind: &str) -> Vec<Value> {
    let p = format!("{kind}:");
    s.entries().into_iter().filter(|(k, _)| k.starts_with(&p)).map(|(_, v)| v).collect()
}

fn find(s: &Store, id: &str) -> Option<Value> {
    ["todo", "event", "note"].iter().find_map(|k| s.get(format!("{k}:{id}")))
}

/// Hera Team 그룹: 이름 또는 id → id (내가 든 그룹만)
fn group_id(s: &Store, q: &str) -> Option<String> {
    let q = q.trim();
    s.entries().into_iter().filter(|(k, _)| k.starts_with("team.group:")).find_map(|(_, g)| {
        (g["id"].as_str() == Some(q) || g["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(q))).then(|| g["id"].as_str().unwrap_or_default().to_string())
    })
}

fn group_name(s: &Store, id: &str) -> String {
    s.get(format!("team.group:{id}")).and_then(|g| g["name"].as_str().map(String::from)).unwrap_or_else(|| id.to_string())
}

/// v3 메모 색 = 팔레트 번호 (Notes.tsx NOTE_COLORS: 노랑·분홍·파랑·초록·보라·주황)
fn note_color(c: &Value) -> Option<u64> {
    if let Some(n) = c.as_u64().filter(|n| *n < 6) {
        return Some(n);
    }
    let c = c.as_str()?.trim().to_lowercase();
    let names = [["yellow", "노랑", "#f5c542"], ["pink", "분홍", "#f47fb0"], ["blue", "파랑", "#5bb8f5"], ["green", "초록", "#42c9a0"], ["purple", "보라", "#a78bfa"], ["orange", "주황", "#f59e6b"]];
    c.parse::<u64>().ok().filter(|n| *n < 6).or_else(|| names.iter().position(|n| n.contains(&c.as_str())).map(|i| i as u64))
}

fn my_team_name(s: &Store) -> String {
    s.get("team.name").and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "AI".into()))
}

fn new_id() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// 기존 항목에 덮어쓰기: 문자열 인자는 그대로, 시각 인자는 UTC 로 정규화, 빈 문자열 = 필드 삭제
fn patch(s: &Store, kind: &str, args: &Value, times: &[&str]) -> Result<Value, String> {
    let id = args["id"].as_str().unwrap_or_default();
    let key = format!("{kind}:{id}");
    let mut v = s.get(&key).ok_or_else(|| format!("id '{id}' 인 항목이 없어요 (no such {kind})"))?;
    for (k, a) in args.as_object().into_iter().flatten() {
        match a {
            _ if k == "id" || a.is_null() => {}
            Value::String(x) if x.is_empty() => {
                v.as_object_mut().map(|o| o.remove(k));
            }
            Value::String(x) if times.contains(&k.as_str()) => v[k] = json!(proto::norm_iso(k, x)?),
            _ => v[k] = a.clone(),
        }
    }
    s.set(key, v.clone());
    Ok(v)
}

fn put(s: &Store, kind: &str, v: Value) -> Value {
    s.set(format!("{kind}:{}", v["id"].as_str().unwrap_or_default()), v.clone());
    v
}

fn tz_min() -> i64 {
    #[cfg(windows)]
    {
        use windows::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
        let mut z = TIME_ZONE_INFORMATION::default();
        let r = unsafe { GetTimeZoneInformation(&mut z) };
        -(z.Bias + if r == 2 { z.DaylightBias } else { z.StandardBias }) as i64
    }
    #[cfg(not(windows))]
    0
}

fn ms(v: &Value, f: &str) -> Option<i64> {
    v[f].as_str().and_then(proto::parse_iso)
}

fn events_in(s: &Store, from: i64, to: i64) -> Vec<Value> {
    let mut v: Vec<Value> = items(s, "event")
        .into_iter()
        .filter(|e| {
            let st = ms(e, "start").unwrap_or(i64::MIN);
            st < to && ms(e, "end").unwrap_or(st) >= from
        })
        .collect();
    v.sort_by_key(|e| ms(e, "start"));
    v
}

fn resource(s: &Store, uri: &str) -> Result<Value, String> {
    let now = now_ms();
    let day = proto::local_day_start(now, tz_min());
    match uri {
        "hera://today" => {
            let todos: Vec<Value> = items(s, "todo")
                .into_iter()
                .filter(|t| !t["done"].as_bool().unwrap_or(false) && ms(t, "due").is_none_or(|d| d < day + 86_400_000))
                .collect();
            Ok(json!({"date": proto::fmt_iso(day), "tzOffsetMin": tz_min(), "events": events_in(s, day, day + 86_400_000), "todos": todos}))
        }
        "hera://notes" => Ok(json!(items(s, "note"))),
        _ => Err(format!("resource not found: {uri}")),
    }
}

fn next_item(s: &Store, now: i64) -> Value {
    let todos = items(s, "todo").into_iter().filter(|t| !t["done"].as_bool().unwrap_or(false)).filter_map(|t| Some((ms(&t, "due")?, "todo", t)));
    let events = items(s, "event").into_iter().filter_map(|e| Some((ms(&e, "start")?, "event", e)));
    todos.chain(events).filter(|(at, _, _)| *at >= now).min_by_key(|(at, _, _)| *at).map_or(Value::Null, |(_, k, v)| json!({"kind": k, "item": v}))
}

fn str_arg<'a>(a: &'a Value, k: &str) -> &'a str {
    a[k].as_str().unwrap_or_default()
}

fn run(app: &AppHandle, s: &Store, t: &Tool, a: &Value) -> Result<Value, String> {
    let now = now_ms();
    match t.name {
        "list_todos" => {
            let all = a["include_done"].as_bool().unwrap_or(false);
            Ok(json!(items(s, "todo").into_iter().filter(|t| all || !t["done"].as_bool().unwrap_or(false)).collect::<Vec<_>>()))
        }
        "add_todo" => {
            let mut v = json!({"id": new_id(), "title": str_arg(a, "title"), "done": false, "source": "local"});
            if let Some(d) = a["due"].as_str().filter(|d| !d.is_empty()) {
                v["due"] = json!(proto::norm_iso("due", d)?);
            }
            Ok(put(s, "todo", v))
        }
        "complete_todo" => patch(s, "todo", &json!({"id": a["id"], "done": a["done"].as_bool().unwrap_or(true)}), &[]),
        "update_todo" => patch(s, "todo", a, &["due"]),
        "list_events" => {
            let day = proto::local_day_start(now, tz_min());
            let from = a["from"].as_str().map(|x| proto::parse_iso(x).ok_or_else(|| proto::norm_iso("from", x).unwrap_err())).transpose()?.unwrap_or(day);
            let to = a["to"].as_str().map(|x| proto::parse_iso(x).ok_or_else(|| proto::norm_iso("to", x).unwrap_err())).transpose()?.unwrap_or(from + 7 * 86_400_000);
            Ok(json!(events_in(s, from, to)))
        }
        "add_event" => {
            let start = proto::parse_iso(str_arg(a, "start")).ok_or_else(|| proto::norm_iso("start", str_arg(a, "start")).unwrap_err())?;
            let end = match a["end"].as_str() {
                Some(e) => proto::parse_iso(e).ok_or_else(|| proto::norm_iso("end", e).unwrap_err())?,
                None => start + 3_600_000,
            };
            if end < start {
                return Err("end 가 start 보다 빨라요 (end before start)".into());
            }
            let mut v = json!({"id": new_id(), "title": str_arg(a, "title"), "start": proto::fmt_iso(start), "end": proto::fmt_iso(end), "source": "local"});
            if let Some(g) = a["group"].as_str().filter(|x| !x.is_empty()) {
                v["group"] = json!(group_id(s, g).ok_or_else(|| format!("'{g}' 그룹에 들어 있지 않아요 (not a member)"))?);
                v["by"] = json!(my_team_name(s)); // 팀 달력 — Hera Team 이 그룹원에게 전달
            }
            Ok(put(s, "event", v))
        }
        "update_event" => patch(s, "event", a, &["start", "end"]),
        "delete_event" => {
            let key = format!("event:{}", str_arg(a, "id"));
            if s.delete(&key) { Ok(json!("삭제했어요 (deleted)")) } else { Err("그 id 의 일정이 없어요 (no such event)".into()) }
        }
        "list_notes" => Ok(json!(items(s, "note"))),
        "add_note" => {
            // v3 메모 모양 (Notes.tsx Note): 새 메모는 바탕화면 왼쪽 위에서 비스듬히 쌓는다
            let n = items(s, "note").len() as i64;
            let mut v = json!({
                "id": new_id(), "text": str_arg(a, "text"), "color": note_color(&a["color"]).unwrap_or(0),
                "x": 120 + (n % 8) * 28, "y": 120 + (n % 8) * 28, "w": 220, "h": 140, "pinned": a["pinned"].as_bool().unwrap_or(false),
            });
            if let Some(app_q) = a["app"].as_str().filter(|x| !x.is_empty()) {
                let rec = items(s, "record").into_iter().find(|r| r["title"].as_str().is_some_and(|t| t.eq_ignore_ascii_case(app_q.trim())));
                v["appId"] = rec.and_then(|r| r["id"].as_str().map(|x| json!(x))).ok_or_else(|| format!("'{app_q}' 라는 독 레코드가 없어요 (no such dock record)"))?;
            }
            if let Some(g) = a["group"].as_str().filter(|x| !x.is_empty()) {
                v["group"] = json!(group_id(s, g).ok_or_else(|| format!("'{g}' 그룹에 들어 있지 않아요 (not a member)"))?);
                v["by"] = json!(my_team_name(s)); // 그룹 메모: 마지막 편집자
            }
            let _ = now;
            Ok(put(s, "note", v))
        }
        "update_note" => {
            let mut p = json!({"id": a["id"]});
            if let Some(t) = a["text"].as_str() {
                p["text"] = json!(t);
            }
            if !a["color"].is_null() {
                p["color"] = json!(note_color(&a["color"]).ok_or("색은 yellow|pink|blue|green|purple|orange 또는 0–5 예요")?);
            }
            if let Some(b) = a["pinned"].as_bool() {
                p["pinned"] = json!(b);
            }
            let id = str_arg(a, "id");
            if s.get(format!("note:{id}")).is_some_and(|v| v["group"].is_string()) {
                p["by"] = json!(my_team_name(s));
            }
            patch(s, "note", &p, &[])
        }
        "show_island_alert" => {
            app.emit("hera-alert", json!({"title": str_arg(a, "title"), "body": str_arg(a, "body")})).map_err(|e| e.to_string())?;
            Ok(json!("Island 에 띄웠어요 (shown)"))
        }
        "start_effect" => {
            if crate::watch::FULLSCREEN.load(Ordering::Relaxed) {
                return Err("전체화면 앱 사용 중이라 효과를 띄우지 않아요 (fullscreen app active)".into());
            }
            crate::open_fx(app, str_arg(a, "kind")).map_err(|e| e.to_string())?;
            Ok(json!("효과 시작 (started)"))
        }
        "start_ascii" => {
            let scene = a["scene"].as_str().filter(|x| ["xmas", "city", "autumn", "calm"].contains(x));
            crate::open_ascii_scene(app, false, None, scene).map_err(|e| e.to_string())?;
            Ok(json!("아스키 화면을 열었어요 (opened)"))
        }
        "list_running_apps" => Ok(json!(crate::shell::list()
            .into_iter()
            .filter_map(|w| serde_json::to_value(w).ok())
            .map(|w| json!({"title": w["title"], "exe": w["exe"], "aumid": w["aumid"], "minimized": w["min"]}))
            .collect::<Vec<_>>())),
        "launch" => {
            let q = str_arg(a, "target");
            // 독 레코드 이름이면 그 대상으로
            let target = items(s, "record")
                .into_iter()
                .find(|r| r["kind"] == "single" && r["title"].as_str().is_some_and(|x| x.eq_ignore_ascii_case(q)))
                .and_then(|r| r["target"].as_str().map(String::from))
                .unwrap_or_else(|| q.to_string());
            crate::launch::sta(move || crate::launch::launch(&target))?;
            Ok(json!("실행했어요 (launched)"))
        }
        "activate_app" => {
            let q = str_arg(a, "name").to_lowercase();
            let w = crate::shell::list()
                .into_iter()
                .filter_map(|w| serde_json::to_value(w).ok())
                .find(|w| [&w["title"], &w["exe"]].iter().any(|x| x.as_str().is_some_and(|x| x.to_lowercase().contains(&q))))
                .ok_or_else(|| format!("'{q}' 와 맞는 창이 없어요 — list_running_apps 로 확인 (no matching window)"))?;
            let keys: Vec<String> = serde_json::from_value(w["keys"].clone()).unwrap_or_default();
            crate::launch::sta(move || crate::watch::activate(&keys))?;
            Ok(json!({"activated": w["title"]}))
        }
        "add_to_shelf" => {
            let path = str_arg(a, "path");
            if !std::path::Path::new(path).exists() {
                return Err(format!("파일이 없어요: {path} (file not found)"));
            }
            // Desktop.tsx shelve 와 같은 규칙: 같은 경로는 새로, 최대 4개(오래된 것부터 뺀다)
            let mut all = items(s, "shelf");
            all.sort_by_key(|f| f["at"].as_i64());
            for f in all.iter().filter(|f| f["path"] == path) {
                s.delete(format!("shelf:{}", f["id"].as_str().unwrap_or_default()));
            }
            let mut left: Vec<_> = all.into_iter().filter(|f| f["path"] != path).collect();
            while left.len() >= 4 {
                let f = left.remove(0);
                s.delete(format!("shelf:{}", f["id"].as_str().unwrap_or_default()));
            }
            Ok(put(s, "shelf", json!({"id": new_id(), "path": path, "at": now})))
        }
        "send_to_mac" => {
            let path = str_arg(a, "path");
            let peer = crate::link::files_connected().ok_or("Mac 과 연결되어 있지 않아요 — Hera Link 를 확인해 주세요 (no Mac connected)")?;
            if !std::path::Path::new(path).is_file() {
                return Err(format!("파일이 없어요: {path} (file not found)"));
            }
            crate::link::send_file(app, path)?;
            Ok(json!(format!("{peer} 으로 보냈어요 (sent)")))
        }
        "search_clipboard_history" => {
            let q = str_arg(a, "query").to_lowercase();
            Ok(json!(crate::clip::list()
                .into_iter()
                .filter_map(|c| serde_json::to_value(c).ok())
                .filter(|c| c["text"].as_str().is_some_and(|t| t.to_lowercase().contains(&q)))
                .collect::<Vec<_>>()))
        }
        "get_status" => {
            let fg = crate::watch::STATE.lock().unwrap().0.clone().and_then(|f| serde_json::to_value(f).ok());
            let link = crate::link::status();
            Ok(json!({
                "now": proto::fmt_iso(now),
                "tzOffsetMin": tz_min(),
                "link": {"state": link.state, "peer": link.peer, "onPeer": link.on_peer},
                "macFiles": crate::link::files_connected(),
                "foreground": fg.map(|f| json!({"title": f["title"], "exe": f["exePath"]})),
                "next": next_item(s, now),
                "panelOpen": app.get_webview_window("panel").is_some(),
            }))
        }
        n => Err(format!("구현되지 않은 도구 '{n}'")),
    }
}

/* ── 이름 있는 파이프 서버 (Windows) ── */

/// 현재 사용자만 접근하는 보안 설명자 (SDDL "D:P(A;;GA;;;<내 SID>)")
#[cfg(windows)]
struct UserOnly(windows::Win32::Security::SECURITY_ATTRIBUTES);

#[cfg(windows)]
impl UserOnly {
    fn new() -> windows::core::Result<Self> {
        use windows::core::{PCWSTR, PWSTR};
        use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
        use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
        use windows::Win32::Security::{GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER};
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        unsafe {
            let mut tok = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok)?;
            let mut len = 0;
            let _ = GetTokenInformation(tok, TokenUser, None, 0, &mut len);
            let mut buf = vec![0u64; (len as usize).div_ceil(8)]; // TOKEN_USER 정렬
            let r = GetTokenInformation(tok, TokenUser, Some(buf.as_mut_ptr().cast()), len, &mut len);
            let _ = CloseHandle(tok);
            r?;
            let mut s = PWSTR::null();
            ConvertSidToStringSidW((*buf.as_ptr().cast::<TOKEN_USER>()).User.Sid, &mut s)?;
            let sid = s.to_string().unwrap_or_default();
            LocalFree(Some(HLOCAL(s.0.cast())));
            let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})").encode_utf16().chain(Some(0)).collect();
            let mut sd = PSECURITY_DESCRIPTOR::default();
            ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(sddl.as_ptr()), SDDL_REVISION_1, &mut sd, None)?;
            Ok(UserOnly(SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd.0, bInheritHandle: false.into() }))
        }
    }
}

#[cfg(windows)]
impl Drop for UserOnly {
    fn drop(&mut self) {
        unsafe { windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(self.0.lpSecurityDescriptor))) };
    }
}

/// 연결마다 스레드 1개, 한 줄 요청 → `handler` → 한 줄 응답. 첫 인스턴스 독점(FIRST_PIPE_INSTANCE: 이미 누가 만든 이름이면 실패).
#[cfg(windows)]
pub fn serve_pipe(name: &str, handler: impl Fn(&str) -> String + Send + Sync + 'static) -> std::io::Result<()> {
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::io::FromRawHandle;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_PIPE_CONNECTED;
    use windows::Win32::Storage::FileSystem::{FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
    use windows::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT};
    let handler = std::sync::Arc::new(handler);
    let sa = UserOnly::new()?;
    let wname: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let mut first = FILE_FLAG_FIRST_PIPE_INSTANCE;
    loop {
        let h = unsafe {
            CreateNamedPipeW(PCWSTR(wname.as_ptr()), PIPE_ACCESS_DUPLEX | first, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, PIPE_UNLIMITED_INSTANCES, 65536, 65536, 0, Some(&sa.0))
        };
        if h.is_invalid() {
            return Err(std::io::Error::last_os_error());
        }
        first = FILE_FLAGS_AND_ATTRIBUTES(0);
        let f = unsafe { std::fs::File::from_raw_handle(h.0) }; // drop = CloseHandle
        if let Err(e) = unsafe { ConnectNamedPipe(h, None) } {
            if e.code() != ERROR_PIPE_CONNECTED.to_hresult() {
                continue;
            }
        }
        let hd = handler.clone();
        std::thread::spawn(move || {
            // 클라이언트가 닫을 때까지(EOF) 읽어서, 응답을 다 읽기 전에 닫아 버리는 일이 없다
            for line in BufReader::new(&f).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                if writeln!(&f, "{}", hd(&line)).is_err() {
                    break;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perms(enabled: bool, groups: Value, always: &[&str]) -> Perms {
        Perms { enabled, groups, always: always.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn gate_rules() {
        let t = |n| proto::tool(n).unwrap();
        // 기본 꺼짐
        assert!(gate(&perms(false, Value::Null, &[]), t("list_todos")).unwrap_err().contains("꺼져"));
        // 켜짐 + 기본 그룹: 읽기·쓰기·화면 허용, 실행·파일·클립보드 거부
        let d = perms(true, Value::Null, &[]);
        assert_eq!(gate(&d, t("list_todos")), Ok(Gate::Allow));
        assert_eq!(gate(&d, t("add_todo")), Ok(Gate::Allow));
        assert_eq!(gate(&d, t("show_island_alert")), Ok(Gate::Allow));
        assert_eq!(gate(&d, t("delete_event")), Ok(Gate::Confirm)); // 삭제는 확인
        assert!(gate(&d, t("launch")).unwrap_err().contains("실행"));
        assert!(gate(&d, t("add_to_shelf")).is_err());
        assert!(gate(&d, t("search_clipboard_history")).is_err());
        // 그룹 켜면 확인 필요, '항상 허용' 이면 바로
        let on = perms(true, json!({"exec": true, "write": false}), &["activate_app"]);
        assert_eq!(gate(&on, t("launch")), Ok(Gate::Confirm));
        assert_eq!(gate(&on, t("activate_app")), Ok(Gate::Allow));
        assert!(gate(&on, t("add_note")).is_err()); // 쓰기 끔
    }

    #[test]
    fn confirm_answer_and_timeout() {
        let (id, rx) = ask();
        let h = std::thread::spawn(move || answer(id, true, true));
        assert_eq!(wait(id, &rx, Duration::from_secs(5)), Some((true, true)));
        h.join().unwrap();
        // 시간 초과 → None(거부), 늦은 답은 무시
        let (id, rx) = ask();
        assert_eq!(wait(id, &rx, Duration::from_millis(20)), None);
        assert!(!answer(id, true, false));
    }

    #[test]
    fn log_ring() {
        for i in 0..(LOG_MAX + 5) {
            log(json!({"i": i}));
        }
        let l = mcp_log();
        assert_eq!(l.len(), LOG_MAX);
        assert_eq!(l[0]["i"], LOG_MAX + 4); // 최신 먼저
    }
}
