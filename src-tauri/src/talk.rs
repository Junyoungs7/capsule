// 전체 톡 · 빠른 톡 · 초대 (시안 talk.html · quick.html). 서버 없이 PC끼리 직접 — 사람은 people.rs 연결, 내 맥은 link.rs 파일 채널.
// 전체 톡: 등록한 사람 모두 + 내 맥. 기록은 이 PC 에만 %APPDATA%\dev.hera.dock\talk.json (최근 500개). 꺼져 있던 사람은 그동안의 말을 못 받는다.
//   메시지 {"t":"talk","id","at","text"?,"file"?:{name,size}} · 파일은 따로 보내고(선반으로) 톡에는 카드만.
// 빠른 톡(펫 오른쪽 클릭): 친한 친구(⭐ `people:<pk>.fav`)에게만 {"t":"poke","text"} — 저장 안 함. 받는 PC 는 펫 위로 얼굴 + 말풍선 (drag.rs poke_show).
// 초대: {"t":"intro","people":[{pk,name}]} — 내가 등록한 사람끼리 서로 등록되게 (받는 쪽은 보낸 사람이 등록된 사람일 때만 연결이 열리므로 그 사람을 믿는다).
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

pub const KEEP: usize = 500;
static LOG: Mutex<Option<Vec<Value>>> = Mutex::new(None);

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("talk.json"))
}

/// 기록에 하나 더하고 오래된 것부터 KEEP 개만 남긴다 (순수 — 시험)
pub fn append(log: &mut Vec<Value>, m: Value) -> bool {
    if m["id"].is_string() && log.iter().any(|x| x["id"] == m["id"]) {
        return false; // 같은 메시지를 두 번 받음
    }
    log.push(m);
    let over = log.len().saturating_sub(KEEP);
    log.drain(..over);
    true
}

fn with_log<R>(app: &AppHandle, f: impl FnOnce(&mut Vec<Value>) -> R) -> R {
    let mut g = LOG.lock().unwrap();
    let log = g.get_or_insert_with(|| file(app).and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default());
    f(log)
}

fn save(app: &AppHandle, log: &[Value]) {
    if let Some(p) = file(app) {
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec(log).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

/// 기록에 넣고 창들에 알린다
fn add(app: &AppHandle, m: Value) -> bool {
    let added = with_log(app, |log| {
        let ok = append(log, m.clone());
        if ok {
            save(app, log);
        }
        ok
    });
    if added {
        let _ = app.emit("talk", &m);
    }
    added
}

fn talk_open_now(app: &AppHandle) -> bool {
    app.get_webview_window("talk").is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
}

fn bump_unread(app: &AppHandle) {
    if let Ok(s) = app.store("hera.json") {
        let n = s.get("talk.unread").and_then(|v| v.as_u64()).unwrap_or(0);
        s.set("talk.unread", n + 1);
    }
}

/// 상대(사람 pk 또는 "mac")에게서 온 메시지 (people.rs · link.rs 가 부른다)
pub fn received(app: &AppHandle, from: &str, name: &str, m: &Value) {
    match m["t"].as_str().unwrap_or("") {
        "talk" => {
            let text: String = m["text"].as_str().unwrap_or("").chars().take(4000).collect();
            let file = m["file"].as_object().map(|f| json!({ "name": f.get("name").and_then(|v| v.as_str()).unwrap_or("file"), "size": f.get("size").and_then(|v| v.as_u64()).unwrap_or(0) }));
            if text.is_empty() && file.is_none() {
                return;
            }
            let id = m["id"].as_str().map(String::from).unwrap_or_else(|| format!("{from}-{}", now()));
            let msg = json!({ "id": id, "at": now(), "from": from, "name": name, "text": text, "file": file });
            if add(app, msg) && !talk_open_now(app) {
                bump_unread(app);
                // 파일 카드는 파일 받음 알림이 따로 뜬다
                if file.is_none() {
                    crate::tray::toast(app, "talk", &format!("{name} · 전체 톡"), &text);
                }
            }
        }
        "poke" => {
            let text: String = m["text"].as_str().unwrap_or("").chars().take(200).collect();
            if text.trim().is_empty() {
                return;
            }
            let _ = app.emit_to("pet", "pet-react", "chat");
            #[cfg(windows)]
            let shown = !crate::watch::FULLSCREEN.load(std::sync::atomic::Ordering::Relaxed) && crate::drag::poke_show(app, from, name, &text);
            #[cfg(not(windows))]
            let shown = false;
            if !shown {
                crate::tray::toast(app, "talk", &format!("{name}의 한마디"), &text);
            }
        }
        "intro" => {
            let me = crate::people::my_pk(app);
            let Ok(s) = app.store("hera.json") else { return };
            let mut added = vec![];
            for p in m["people"].as_array().into_iter().flatten().take(64) {
                let (Some(pk), Some(nm)) = (p["pk"].as_str(), p["name"].as_str()) else { continue };
                if pk == me || crate::link_files::unhex32(pk).is_none() || s.has(format!("people:{pk}")) {
                    continue;
                }
                let nm: String = nm.chars().filter(|c| !c.is_control()).take(40).collect();
                s.set(format!("people:{pk}"), json!({ "id": pk, "name": nm, "at": now(), "via": name }));
                added.push(nm);
            }
            if !added.is_empty() {
                let who = added.join(" · ");
                crate::tray::toast(app, "sent", &format!("{name}님이 초대했어요"), &format!("{who}님과 서로 등록됐어요"));
                add(app, json!({ "id": format!("sys-{}", now()), "at": now(), "from": "sys", "text": format!("{name}님이 초대해 {who}님과 서로 등록됐어요") }));
            }
        }
        _ => {}
    }
}

fn new_id() -> String {
    format!("{}-{:08x}", now(), u32::from_le_bytes(crate::link_files::random32()[..4].try_into().unwrap_or([0; 4])))
}

/// 전체 톡 받는 곳: 켜진 등록한 사람 + 연결된 내 맥
fn send_all(app: &AppHandle, msg: Value) {
    crate::people::deliver(app, crate::people::online(app, false), msg.clone());
    if crate::link::files_connected().is_some() {
        crate::link::send(msg);
    }
}

/// 톡 기록 (창이 열릴 때)
#[tauri::command]
pub fn talk_list(app: AppHandle) -> Vec<Value> {
    with_log(&app, |log| log.clone())
}

#[tauri::command]
pub fn talk_send(app: AppHandle, text: String) -> Result<(), String> {
    let text: String = text.trim().chars().take(4000).collect();
    if text.is_empty() {
        return Ok(());
    }
    let id = new_id();
    add(&app, json!({ "id": id, "at": now(), "from": "me", "text": text }));
    std::thread::spawn(move || send_all(&app, json!({ "t": "talk", "id": id, "text": text })));
    Ok(())
}

/// 톡 창에 끌어 놓은 파일: 켜진 사람 모두 · 내 맥에게 파일, 톡에는 카드
#[tauri::command]
pub fn talk_file(app: AppHandle, paths: Vec<String>) {
    std::thread::spawn(move || {
        for p in &paths {
            let name = Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            let id = new_id();
            add(&app, json!({ "id": id, "at": now(), "from": "me", "file": { "name": name, "size": size } }));
            send_all(&app, json!({ "t": "talk", "id": id, "file": { "name": name, "size": size } }));
        }
        for pk in crate::people::online(&app, false) {
            crate::people::send_files(&app, &pk, &paths);
        }
        if crate::link::files_connected().is_some() {
            for p in &paths {
                let _ = crate::link::send_file(&app, p, None);
            }
        }
    });
}

/// 이 PC 의 톡 기록 지우기 (다른 사람 기록은 그대로)
#[tauri::command]
pub fn talk_clear(app: AppHandle) {
    with_log(&app, |log| {
        log.clear();
        save(&app, log);
    });
    let _ = app.emit("talk-cleared", ());
}

/// 초대: 고른 사람(pks)과 나머지 등록한 사람들이 서로 등록되게 (켜져 있는 사람끼리)
#[tauri::command]
pub fn talk_invite(app: AppHandle, pks: Vec<String>) -> Vec<String> {
    let all = crate::people::registered(&app);
    let card = |pk: &str| all.iter().find(|(k, _)| k == pk).map(|(k, n)| json!({ "pk": k, "name": n }));
    let on = crate::people::online(&app, false);
    let mut names = vec![];
    for x in pks.iter().filter(|x| on.contains(x)) {
        let others: Vec<Value> = all.iter().filter(|(k, _)| k != x).map(|(k, n)| json!({ "pk": k, "name": n })).collect();
        let Some(xc) = card(x) else { continue };
        crate::people::deliver(&app, vec![x.clone()], json!({ "t": "intro", "people": others }));
        crate::people::deliver(&app, on.iter().filter(|k| *k != x).cloned().collect(), json!({ "t": "intro", "people": [xc] }));
        names.push(xc["name"].as_str().unwrap_or("").to_string());
    }
    if !names.is_empty() {
        add(&app, json!({ "id": format!("sys-{}", now()), "at": now(), "from": "sys", "text": format!("{}님을 초대했어요 — 톡 사람들과 서로 등록돼요", names.join(" · ")) }));
    }
    names
}

/// 빠른 톡: 켜진 친한 친구(⭐)에게만, 저장 안 함 → 보낸 사람 수
#[tauri::command]
pub fn poke_send(app: AppHandle, text: String) -> usize {
    let text: String = text.trim().chars().take(200).collect();
    let to = crate::people::online(&app, true);
    if text.is_empty() || to.is_empty() {
        return 0;
    }
    let n = to.len();
    crate::people::deliver(&app, to, json!({ "t": "poke", "text": text }));
    let _ = app.emit_to("pet", "pet-react", "sent");
    n
}

/// 톡 창을 보면 안 읽은 수 0
#[tauri::command]
pub fn talk_read(app: AppHandle) {
    if let Ok(s) = app.store("hera.json") {
        s.set("talk.unread", 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_keeps_the_last_500_and_drops_duplicates() {
        let mut log = vec![];
        for i in 0..520 {
            assert!(append(&mut log, json!({ "id": format!("m{i}"), "text": "x" })));
        }
        assert_eq!(log.len(), KEEP);
        assert_eq!(log[0]["id"], "m20", "가장 오래된 것부터 빠진다");
        assert!(!append(&mut log, json!({ "id": "m519" })), "같은 id 는 한 번만");
        assert_eq!(log.len(), KEEP);
    }
}
