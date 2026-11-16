// 메모 (a4): 메모 보드(떠 있는 창 `float-notes`)에 붙는 포스트잇 + '메모장으로 열기'.
// - 예전 바탕화면 메모(모니터마다 투명 창) · 앱 메모는 지웠다 → 처음 한 번 모든 메모를 보드 격자에 옮긴다 (글·색 그대로).
// - 메모장으로 열기 = %APPDATA%\Hera\notes\<id>.txt (UTF-8) 에 쓰고 notepad.exe 로 연다 (누를 때만).
//   그 메모장이 떠 있는 동안만 1초마다 파일 수정 시각을 보고, 바뀌면 메모에 다시 읽어 넣는다 (메모장이 닫히면 마지막으로 한 번 보고 끝 — 평소엔 비용 0).
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

/// 보드 격자 (옮길 때): 3열, 카드 210×140 · 간격 16
pub fn board_layout(mut notes: Vec<(String, Value)>) -> Vec<(String, Value)> {
    notes.sort_by(|a, b| a.0.cmp(&b.0));
    for (i, (_, v)) in notes.iter_mut().enumerate() {
        let (col, row) = (i % 3, i / 3);
        v["x"] = (16 + col * 232).into();
        v["y"] = (16 + row * 156).into();
        v["w"] = v["w"].as_f64().unwrap_or(210.0).clamp(180.0, 260.0).into();
        v["h"] = v["h"].as_f64().unwrap_or(140.0).clamp(110.0, 200.0).into();
        if let Some(o) = v.as_object_mut() {
            o.remove("appId"); // 앱 메모 → 보드 메모
            o.remove("pinned");
        }
    }
    notes
}

/// 시작 때 한 번: 바탕화면 좌표 메모를 보드로 (store `notes.board` = 1)
pub fn migrate(app: &AppHandle) {
    let Ok(s) = app.store("hera.json") else { return };
    if s.get("notes.board").is_some() {
        return;
    }
    let notes: Vec<(String, Value)> = s.entries().into_iter().filter(|(k, _)| k.starts_with("note:")).collect();
    for (k, v) in board_layout(notes) {
        s.set(k, v);
    }
    for k in ["notes.shown", "note.edit"] {
        s.delete(k);
    }
    s.set("notes.board", 1);
}

/// 메모 파일 자리 (id 는 평범한 글자만 — 경로로 새지 않게)
pub fn note_file(dir: &Path, id: &str) -> Option<PathBuf> {
    ((1..=64).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')).then(|| dir.join(format!("{id}.txt")))
}

/// UTF-8 (BOM 포함 — 오래된 메모장도 한글을 바로 읽게), 줄바꿈 CRLF. 쓴 뒤의 수정 시각을 돌려준다
pub fn write_note(path: &Path, text: &str) -> std::io::Result<SystemTime> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let body = text.replace("\r\n", "\n").replace('\n', "\r\n");
    std::fs::write(path, [&b"\xEF\xBB\xBF"[..], body.as_bytes()].concat())?;
    std::fs::metadata(path)?.modified()
}

/// since 뒤에 바뀌었으면 (글, 새 수정 시각). BOM · CRLF 는 걷어 낸다
pub fn read_back(path: &Path, since: SystemTime) -> Option<(String, SystemTime)> {
    let m = std::fs::metadata(path).ok()?.modified().ok()?;
    if m <= since {
        return None;
    }
    let b = std::fs::read(path).ok()?;
    let b = b.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&b);
    Some((String::from_utf8_lossy(b).replace("\r\n", "\n"), m))
}

pub fn with_text(note: &Value, text: &str) -> Value {
    let mut n = note.clone();
    n["text"] = text.into();
    n
}

/// 메모장이 바꾼 글을 메모에 (같으면 쓰지 않음)
fn sync_back(app: &AppHandle, id: &str, path: &Path, since: &mut SystemTime) {
    let Some((text, m)) = read_back(path, *since) else { return };
    *since = m;
    let Ok(s) = app.store("hera.json") else { return };
    let key = format!("note:{id}");
    if let Some(v) = s.get(&key).filter(|v| v["text"].as_str() != Some(&text)) {
        s.set(key, with_text(&v, &text));
    }
}

#[tauri::command]
pub fn note_notepad(app: AppHandle, id: String) -> Result<String, String> {
    let dir = app.path().data_dir().map_err(|e| e.to_string())?.join("Hera").join("notes");
    let path = note_file(&dir, &id).ok_or("잘못된 메모 id")?;
    let s = app.store("hera.json").map_err(|e| e.to_string())?;
    let note = s.get(format!("note:{id}")).ok_or("메모가 없어요")?;
    let mut since = write_note(&path, note["text"].as_str().unwrap_or_default()).map_err(|e| e.to_string())?;
    // 사용자가 누른 때만 (시험은 이 커맨드를 부르지 않는다 — write_note/read_back 을 가짜 경로로 시험)
    let mut child = std::process::Command::new("notepad.exe").arg(&path).spawn().map_err(|e| e.to_string())?;
    let p = path.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let done = !matches!(child.try_wait(), Ok(None));
        sync_back(&app, &id, &p, &mut since);
        if done {
            break;
        }
    });
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn notes_move_onto_the_board() {
        let out = board_layout(vec![
            ("note:b".into(), json!({ "id": "b", "text": "앱 메모", "color": 3, "x": 0, "y": 0, "w": 248, "h": 150, "appId": "vscode", "pinned": false })),
            ("note:a".into(), json!({ "id": "a", "text": "바탕화면 메모", "color": 1, "x": 1500, "y": 900, "w": 210, "h": 140, "pinned": true })),
            ("note:c".into(), json!({ "id": "c", "text": "", "color": 0, "x": 10, "y": 10, "w": 600, "h": 40 })),
            ("note:d".into(), json!({ "id": "d", "text": "넷째", "color": 4 })),
        ]);
        let get = |k: &str| out.iter().find(|(x, _)| x == k).unwrap().1.clone();
        assert_eq!((get("note:a")["x"].as_u64(), get("note:a")["y"].as_u64()), (Some(16), Some(16))); // 화면 밖이던 메모도 보드 안
        assert_eq!((get("note:b")["x"].as_u64(), get("note:d")["y"].as_u64()), (Some(248), Some(172))); // 격자 (4번째 = 둘째 줄)
        assert_eq!((get("note:b")["text"].clone(), get("note:b")["color"].clone()), (json!("앱 메모"), json!(3))); // 글·색 그대로
        assert!(get("note:b").get("appId").is_none() && get("note:a").get("pinned").is_none());
        assert_eq!((get("note:c")["w"].as_f64(), get("note:c")["h"].as_f64()), (Some(260.0), Some(110.0))); // 크기는 보드에 맞게
    }

    #[test]
    fn notepad_round_trip_with_a_fake_path() {
        let dir = std::env::temp_dir().join(format!("hera-notes-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(note_file(&dir, "../evil").is_none() && note_file(&dir, "a/b").is_none() && note_file(&dir, "").is_none());
        let p = note_file(&dir, "4f3ed521-5233-4b27").unwrap();
        let since = write_note(&p, "배너 QA\n- [ ] 3시").unwrap();
        let raw = std::fs::read(&p).unwrap();
        assert!(raw.starts_with(b"\xEF\xBB\xBF") && raw.windows(2).any(|w| w == b"\r\n")); // UTF-8 BOM · CRLF (메모장 기본)
        assert!(read_back(&p, since).is_none()); // 안 바뀜 → 다시 쓰지 않음
        // 메모장에서 고쳐 저장 (BOM 없이 · CRLF) — 수정 시각이 지나게 조금 뒤
        std::thread::sleep(Duration::from_millis(30));
        std::fs::write(&p, "배너 QA\r\n- [x] 3시\r\n한 줄 더").unwrap();
        let (t, m) = read_back(&p, since).expect("changed");
        assert_eq!(t, "배너 QA\n- [x] 3시\n한 줄 더");
        assert!(read_back(&p, m).is_none());
        let n = with_text(&json!({ "id": "x", "text": "old", "color": 2, "x": 16 }), &t);
        assert_eq!((n["text"].as_str(), n["color"].as_u64(), n["x"].as_u64()), (Some(t.as_str()), Some(2), Some(16)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
