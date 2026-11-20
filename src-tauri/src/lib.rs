// Hera for Windows: 트레이 + 설정 창 + (필요할 때만) 메모 보드 · 화면 효과 · 자리 비움 화면. 기능 목록·키·이벤트는 docs/spec.md.
// Windows 전용 모듈 — 맥 등에서는 stub.rs 의 같은 이름 모듈(빈 구현)로 컴파일만 된다 (docs/mac-port.md)
#[cfg(windows)]
mod drag;
#[cfg(windows)]
mod edge;
#[cfg(windows)]
mod launch;
#[cfg(windows)]
mod pet; // 펫 (항상 · 옮길 수 있음 · 내 이미지)
#[cfg(windows)]
mod ripple;
#[cfg(windows)]
mod shell;
#[cfg(windows)]
mod watch;
#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
use stub::{drag, launch, pet, shell, watch};
mod crossing; // Hera Link 넘어감: 벽 · 자리 · 한 번만
mod link;
mod link_files;
mod link_layout;
mod notes; // 메모 보드 · 메모장으로 열기
mod tray; // 트레이 아이콘 · 패널 · 알림 카드
mod ui;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_store::StoreExt;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

const SETTINGS: (f64, f64) = (720.0, 600.0);
const BOARD: (f64, f64) = (728.0, 520.0);

/// 테두리 없는 투명 창 (오버레이·효과·덮개 공통)
fn builder<'a>(app: &'a AppHandle, label: &'a str, url: String, (w, h): (f64, f64)) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .inner_size(w, h)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .title("Hera")
}

/// 클릭 통과 오버레이 (watch 루프가 히트 rect 밖은 통과 · NOACTIVATE · TOOLWINDOW 를 유지)
pub(crate) fn overlay(app: &AppHandle, label: &'static str, query: &str, size: (f64, f64)) -> tauri::Result<WebviewWindow> {
    let surface = label.split('-').next().unwrap_or(label); // "fx-1" → surface=fx
    let win = builder(app, label, format!("index.html?surface={surface}{query}"), size)
        .shadow(false)
        .focusable(false)
        .build()?;
    let _ = ui::low_memory(&win); // 최적화일 뿐 — 실패해도 창은 쓴다
    watch::add_overlay(label, ui::hwnd(&win));
    Ok(win)
}

/// 보통 Windows 창 (제목 표시줄 · Alt+Tab · 작업 표시줄) — 설정 · 메모 보드. 처음 열 때 만들고 닫으면 파괴 (평소 메모리 0).
fn normal(app: &AppHandle, label: &str, url: String, title: &str, size: (f64, f64)) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(480.0, 360.0)
        .maximizable(false)
        .center()
        .visible(false)
        .disable_drag_drop_handler()
        .build()
}

/// 설정 창: 있으면 그 섹션으로 + 앞으로. sec = general|link|deco|about (연결은 `link:devices` 처럼 탭까지)
pub(crate) fn open_settings(app: &AppHandle, sec: &str) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("settings") {
        app.emit_to("settings", "settings-sec", sec)?;
        let _ = w.unminimize();
        w.show()?;
        return w.set_focus();
    }
    let win = normal(app, "settings", format!("index.html?surface=settings&sec={sec}"), "Hera 설정", SETTINGS)?;
    win.show()?;
    win.set_focus()
}

/// 메모 보드 창: 자리·크기는 store `board.rect` [x, y, w, h] (물리 px, 바깥 창)
pub(crate) fn open_board(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("notes") {
        let _ = w.unminimize();
        w.show()?;
        return w.set_focus();
    }
    let win = normal(app, "notes", "index.html?surface=notes".into(), "Hera 메모", BOARD)?;
    let saved = app.store("hera.json").ok().and_then(|s| s.get("board.rect")).and_then(|v| serde_json::from_value::<[i32; 4]>(v).ok());
    let mons: Vec<[i32; 4]> = app.available_monitors().unwrap_or_default().iter().map(|m| [m.position().x, m.position().y, m.size().width as i32, m.size().height as i32]).collect();
    if let Some([x, y, w, h]) = saved.filter(|r| ui::visible_on(*r, &mons)) {
        ui::set_bounds(&win, x, y, w, h);
    }
    static GEN: AtomicU32 = AtomicU32::new(0);
    let (h, w2) = (app.clone(), win.clone());
    win.on_window_event(move |e| {
        if let WindowEvent::Moved(_) | WindowEvent::Resized(_) = e {
            // 끄는 동안 쓰지 않고, 멈춘 뒤 0.4초에 한 번
            let (h, w, gen) = (h.clone(), w2.clone(), GEN.fetch_add(1, Ordering::Relaxed) + 1);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                if GEN.load(Ordering::Relaxed) != gen || w.is_minimized().unwrap_or(true) {
                    return;
                }
                if let (Ok(p), Ok(z), Ok(s)) = (w.outer_position(), w.outer_size(), h.store("hera.json")) {
                    s.set("board.rect", serde_json::json!([p.x, p.y, z.width, z.height]));
                }
            });
        }
    });
    win.show()?;
    win.set_focus()
}

/// 아스키 장면 4 + 화면 효과 6 = 자리 비움 화면(덮개)이 고르는 그림. 아스키 창이 ?scene= 으로 받는다.
pub(crate) const COVER_SCENES: [&str; 10] = ["xmas", "city", "autumn", "calm", "snow", "rain", "leaves", "dawn", "sunset", "moon"];
static COVER_LAST: AtomicUsize = AtomicUsize::new(usize::MAX);

/// 무작위 장면 (직전 것은 빼고). r = 난수.
pub(crate) fn pick_cover(prev: usize, r: u32) -> usize {
    let n = COVER_SCENES.len();
    if prev >= n {
        return r as usize % n;
    }
    (prev + 1 + r as usize % (n - 1)) % n
}

/// 모니터 = (물리 위치, 물리 크기, 배율)
type Mon = ((i32, i32), (u32, u32), f64);
/// 덮개 창 = (라벨, 물리 위치, 물리 크기, 논리 크기)
type Cover = (String, (i32, i32), (u32, u32), (f64, f64));

/// 모니터마다 덮개 창 하나. 첫 창 = "ascii", 나머지 "ascii-1" …
pub(crate) fn cover_rects(mons: &[Mon]) -> Vec<Cover> {
    mons.iter()
        .enumerate()
        .map(|(i, &(pos, size, s))| (if i == 0 { "ascii".into() } else { format!("ascii-{i}") }, pos, size, (size.0 as f64 / s, size.1 as f64 / s)))
        .collect()
}

/// 모든 모니터, 주 모니터가 맨 앞
fn monitors_primary_first(app: &AppHandle) -> tauri::Result<Vec<tauri::Monitor>> {
    let prim = app.primary_monitor()?.map(|m| *m.position());
    let mut v = app.available_monitors()?;
    v.sort_by_key(|m| Some(*m.position()) != prim);
    Ok(v)
}

/// 열려 있는 덮개 창 전부
pub(crate) fn ascii_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows().into_iter().filter(|(l, _)| l == "ascii" || l.starts_with("ascii-")).map(|(_, w)| w).collect()
}

/// 덮개 창 전부 닫기 요청 (JS 가 닫힘 애니메이션 후 스스로 파괴)
pub(crate) fn ascii_close_all(app: &AppHandle) {
    for w in ascii_windows(app) {
        let _ = w.emit_to(w.label(), "ascii-close", ());
    }
}

/// 자리 비움 화면: 모든 모니터를 무작위 장면(직전 것 빼고)으로 덮는다. 포커스는 뺏지 않고, 입력은 watch 루프가 감지해 닫는다.
pub(crate) fn open_cover(app: &AppHandle, scene: Option<&str>) -> tauri::Result<()> {
    if !ascii_windows(app).is_empty() {
        return Ok(());
    }
    let mons = monitors_primary_first(app)?;
    let mons: Vec<_> = mons.iter().map(|m| ((m.position().x, m.position().y), (m.size().width, m.size().height), m.scale_factor())).collect();
    // ponytail: 모든 모니터에 같은 장면 — 고르기·직전 피하기가 한 번이면 된다
    let mut b = [0u8; 4];
    let _ = getrandom::fill(&mut b);
    let i = scene.and_then(|s| COVER_SCENES.iter().position(|x| *x == s)).unwrap_or_else(|| pick_cover(COVER_LAST.load(Ordering::Relaxed), u32::from_le_bytes(b)));
    COVER_LAST.store(i, Ordering::Relaxed);
    for (label, pos, size, logical) in cover_rects(&mons) {
        let win = builder(app, &label, format!("index.html?surface=ascii&scene={}", COVER_SCENES[i]), logical)
            .shadow(false)
            .focusable(false)
            .disable_drag_drop_handler()
            .build()?;
        // 위치 먼저(그 모니터로 옮겨 DPI 가 바뀜) → 그 다음 물리 크기
        let (pos, size) = (PhysicalPosition::new(pos.0, pos.1), PhysicalSize::new(size.0, size.1));
        let r = win.set_position(pos).and_then(|_| win.set_size(size)).and_then(|_| win.show());
        if r.is_err() {
            let _ = win.destroy();
            return r;
        }
    }
    Ok(())
}

const FX_KINDS: [&str; 6] = ["snow", "rain", "leaves", "dawn", "sunset", "moon"];
static FX_GEN: AtomicU32 = AtomicU32::new(0);
// ponytail: 효과 창 라벨은 &'static (watch 오버레이 목록) — 모니터 4개까지, 더 필요하면 늘린다
const FX_LABELS: [&str; 4] = ["fx", "fx-1", "fx-2", "fx-3"];

/// 열려 있는 효과 창 전부
pub(crate) fn fx_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    FX_LABELS.iter().filter_map(|l| app.get_webview_window(l)).collect()
}

/// 전체화면 효과 창: 투명·클릭 통과 오버레이를 그때만 만들고 25초 효과가 끝나면 JS 가 파괴. 전체화면 앱 중엔 안 만든다.
pub(crate) fn open_fx(app: &AppHandle, kind: &str) -> tauri::Result<()> {
    let Some(kind) = FX_KINDS.iter().find(|k| **k == kind) else { return Ok(()) };
    if watch::FULLSCREEN.load(Ordering::Relaxed) || !fx_windows(app).is_empty() {
        return Ok(());
    }
    for (m, label) in monitors_primary_first(app)?.iter().zip(FX_LABELS) {
        let (pos, size, s) = (*m.position(), *m.size(), m.scale_factor());
        // 높이 -1px: 모니터를 꽉 채운 최상위 창은 셸이 '전체화면 앱'으로 판정한다(QUNS_BUSY)
        let size = PhysicalSize::new(size.width, size.height.saturating_sub(1));
        let win = overlay(app, label, &format!("&fx={kind}"), (size.width as f64 / s, size.height as f64 / s))?;
        win.on_window_event(move |e| {
            if let WindowEvent::Destroyed = e {
                watch::remove_overlay(label);
            }
        });
        let r = win.set_position(pos).and_then(|_| win.set_size(size)).and_then(|_| win.show());
        if r.is_err() {
            let _ = win.destroy();
            return r;
        }
    }
    // 안전망: 웹뷰가 멈춰 onDone 이 안 와도 40초 뒤 파괴 (그 사이 새 효과가 열렸으면 그대로)
    let (h, gen) = (app.clone(), FX_GEN.fetch_add(1, Ordering::Relaxed) + 1);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(40));
        if FX_GEN.load(Ordering::Relaxed) == gen {
            fx_windows(&h).into_iter().for_each(|w| drop(w.destroy()));
        }
    });
    Ok(())
}

/// store 변경 구독 (Rust). ⚠ tauri-plugin-store 는 store 잠금을 쥔 채 'store://change' 를 emit 하고, Rust 리스너는 그 emit 안에서
/// 바로 불린다 → 리스너가 store 를 다시 만지면 교착. 그래서 전용 스레드로 넘겨 순서대로 처리한다.
pub(crate) fn listen_store(app: &AppHandle, f: impl Fn(&str, Option<serde_json::Value>) + Send + 'static) {
    use tauri::Listener;
    let (tx, rx) = std::sync::mpsc::channel::<(String, Option<serde_json::Value>)>();
    std::thread::spawn(move || {
        for (k, v) in rx {
            f(&k, v);
        }
    });
    app.listen_any("store://change", move |e| {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
            if let Some(k) = v["key"].as_str() {
                let _ = tx.send((k.to_string(), (v["exists"] == true).then(|| v["value"].clone())));
            }
        }
    });
}

/// store 의 켜고 끄는 값 (없으면 dflt)
pub(crate) fn flag(app: &AppHandle, key: &str, dflt: bool) -> bool {
    app.store("hera.json").ok().and_then(|s| s.get(key)).and_then(|v| v.as_bool()).unwrap_or(dflt)
}

/* ── 선반: store `shelf:<id>` = { id, path, at, from } (from = "pc" | "mac"). 넣기는 모두 여기로 (넘치면 오래된 것부터 뺀다) ── */
pub const SHELF_MAX: usize = 8;

/// 새 선반 목록: 같은 경로는 앞으로 옮기고, 넘치면 오래된 것(at 작은 것)부터 뺀다 → (넣을 항목, 지울 키)
pub fn shelf_plan(cur: &[(String, serde_json::Value)], paths: &[String], from: &str, now: i64) -> (Vec<(String, serde_json::Value)>, Vec<String>) {
    let mut del: Vec<String> = cur.iter().filter(|(_, v)| paths.iter().any(|p| v["path"].as_str() == Some(p))).map(|(k, _)| k.clone()).collect();
    let mut keep: Vec<&(String, serde_json::Value)> = cur.iter().filter(|(k, _)| !del.contains(k)).collect();
    keep.sort_by_key(|(_, v)| v["at"].as_i64().unwrap_or(0));
    let over = (keep.len() + paths.len()).saturating_sub(SHELF_MAX);
    del.extend(keep.iter().take(over).map(|(k, _)| k.clone()));
    let add = paths
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let id = format!("{:x}{i}", now);
            (format!("shelf:{id}"), serde_json::json!({ "id": id, "path": p, "at": now + i as i64, "from": from }))
        })
        .collect();
    (add, del)
}

pub(crate) fn shelve(app: &AppHandle, paths: &[String], from: &str) {
    let Ok(s) = app.store("hera.json") else { return };
    let cur: Vec<(String, serde_json::Value)> = s.entries().into_iter().filter(|(k, _)| k.starts_with("shelf:")).collect();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let (add, del) = shelf_plan(&cur, paths, from, now);
    for k in del {
        s.delete(k);
    }
    for (k, v) in add {
        s.set(k, v);
    }
}

#[tauri::command]
fn shelf_add(app: AppHandle, paths: Vec<String>) {
    shelve(&app, &paths, "pc");
}

/// 선반 '열기' · 설정 폴더 열기 (기본 앱으로)
#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || launch::sta(move || launch::launch(&path))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn board_open(app: AppHandle) -> Result<(), String> {
    open_board(&app).map_err(|e| e.to_string())
}

/// 설정 '지금 한 번 보기'
#[tauri::command]
async fn fx(app: AppHandle, kind: String) -> Result<(), String> {
    open_fx(&app, &kind).map_err(|e| e.to_string())
}

/// 펫 메뉴 → 아스키 화면 지금 (잠깐 뒤부터 입력이 있으면 닫힌다 — watch::arm_cover)
#[tauri::command]
async fn cover(app: AppHandle, scene: String) -> Result<(), String> {
    open_cover(&app, Some(&scene)).map_err(|e| e.to_string())?;
    watch::arm_cover();
    Ok(())
}

/* ── Hera Link (link.rs 엔진 · link_files.rs 파일 채널) ── */
#[tauri::command]
fn link_status() -> (link::Status, Option<String>) {
    (link::status(), link::files_connected())
}

/// 설정을 바꾼 뒤: 엔진 감독 스레드가 다시 읽고, 켜졌으면 파일 채널도 시작
#[tauri::command]
fn link_apply(app: AppHandle) {
    link::apply();
    link::files_start(&app);
    link::update_edges(&app);
}

#[tauri::command]
async fn link_import(app: AppHandle) -> Result<link::Cfg, String> {
    tauri::async_runtime::spawn_blocking(move || link::import(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn link_trust(app: AppHandle, fp: String) -> Result<(), String> {
    link::trust(&app, &fp)
}

/// 배치 캔버스: 모든 모니터(PC·맥) + 변환된 엔진 링크 구간 + 표현 못 하는 배치 설명
#[tauri::command]
fn link_plan(app: AppHandle) -> (Vec<link_layout::Mon>, link_layout::Plan) {
    link::plan(&app)
}

#[tauri::command]
fn link_pair(ok: bool) {
    link::pair_confirm(ok);
}

#[tauri::command]
fn link_unpair(app: AppHandle) {
    link::unpair(&app);
}

/// edge·pos = 가장자리 포탈로 보냄 (맥이 그 자리에 물결)
#[tauri::command]
async fn link_send(app: AppHandle, path: String, edge: Option<String>, pos: Option<f64>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || link::send_file(&app, &path, edge.zip(pos))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn settings_open(app: AppHandle, sec: String) -> Result<(), String> {
    open_settings(&app, &sec).map_err(|e| e.to_string())
}

/// 자기 창 닫기 (설정 · 덮개 · 효과)
#[tauri::command]
fn close_self(window: WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

/// Windows 시작 시 실행: on = None 이면 읽기만
#[tauri::command]
fn autostart(app: AppHandle, on: Option<bool>) -> bool {
    let a = app.autolaunch();
    if let Some(on) = on {
        let _ = if on { a.enable() } else { a.disable() };
    }
    a.is_enabled().unwrap_or(false)
}

#[tauri::command]
fn report_hit_rects(window: WebviewWindow, rects: Vec<[f64; 4]>) {
    watch::set_rects(window.label(), rects);
}

/// 지금은 읽지 않는 예전 키 (캡슐 · 허브 · 할 일 · 달력 · 채팅 · Team · 터미널 · MCP · OCR · 상용구 · LP · 최근 복사 · 상단 공간). 시작 때 한 번 지운다.
const OLD_KEYS: [&str; 22] = [
    "alarm.", "appbar.", "chat", "dock.", "event:", "float.", "group:", "island.", "lp.", "mcp.", "record:", "seeded", "snippet", "sync.", "team", "term.", "todo", "tomb:",
    "turntable.", "note.edit", "notes.shown", "fx.enabled",
];

pub fn old_key(k: &str) -> bool {
    OLD_KEYS.iter().any(|p| k.starts_with(p))
}

/// 꺼짐 기록: release 는 panic = "abort" 라 어느 스레드든 panic 하나면 앱이 말없이 꺼진다 → 꺼지기 전에 이유를 남긴다.
/// %APPDATA%\dev.hera.dock\crash.log (64KB 넘으면 새로)
fn crash_log(line: &str) {
    let Some(dir) = std::env::var_os("APPDATA").map(|a| std::path::PathBuf::from(a).join("dev.hera.dock")) else { return };
    let p = dir.join("crash.log");
    let _ = std::fs::create_dir_all(&dir);
    if std::fs::metadata(&p).is_ok_and(|m| m.len() > 64 * 1024) {
        let _ = std::fs::remove_file(&p);
    }
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        use std::io::Write;
        let _ = writeln!(f, "[{t}] {line}");
    }
}

pub fn run() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let th = std::thread::current().name().unwrap_or("?").to_string();
        crash_log(&format!("panic in thread '{th}': {info}"));
        prev(info);
    }));
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            tray::show(app, None, "main"); // 두 번째 실행 = 패널
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            settings_open, close_self, autostart, report_hit_rects, shelf_add, open_path, board_open, fx, cover,
            link_status, link_apply, link_import, link_trust, link_pair, link_unpair, link_send, link_plan, notes::note_notepad,
            tray::panel_fit, tray::panel_hide, tray::toast_next, tray::toast_done, tray::toast_click, drag::drag_file, drag::drag_hide, drag::portal_drop_here, pet::pet_click, pet::pet_drag, pet::pet_home, pet::pet_set_image, pet::pet_image,
        ])
        .setup(|app| {
            // 깨진 hera.json: 스토어 플러그인은 읽기 오류를 무시하고 빈 스토어로 열어 곧 덮어쓴다 → 먼저 옆으로 치워 둔다
            let file = app.path().app_data_dir()?.join("hera.json");
            if std::fs::read(&file).is_ok_and(|b| serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&b).is_err()) {
                let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
                let bak = file.with_file_name(format!("hera.json.bak-{ts}"));
                eprintln!("hera.json 이 깨져 있어 {}로 옮기고 새로 만든다: {:?}", bak.display(), std::fs::rename(&file, &bak));
            }
            let s = app.store("hera.json")?;
            // 펫 고르기는 캡슐에서 작업 표시줄 펫으로 (기본 펫만 — 내 펫은 지웠다)
            if let Some(p) = s.get("island.pet").filter(|p| p.as_str().is_some_and(|p| !p.starts_with("custom:"))) {
                if !s.has("pet.kind") {
                    s.set("pet.kind", p);
                }
            }
            for (k, _) in s.entries() {
                if old_key(&k) {
                    s.delete(k);
                }
            }
            let h = app.handle();
            tray::create_panel(h)?;
            // 끌기 오버레이 (받침 · 포탈): 숨겨 두고 파일을 끌 때만 그 모니터를 덮는다 (drag.rs)
            let d = overlay(h, "drag", "", (800.0, 600.0))?;
            drag::set_hwnd(ui::hwnd(&d));
            watch::start(h.clone());
            shell::start(h.clone());
            // Hera Link: 기본 꺼짐. 켜져 있을 때만 엔진·파일 채널이 뜬다 (꺼져 있으면 스레드 1개가 대기만)
            link::start(h.clone());
            link::files_start(h);
            notes::migrate(h);
            pet::sync(h); // 펫 (항상)
            listen_store(h, move |k, _| {
                if matches!(k, "ascii.idleMin" | "deco.enabled" | "locator.enabled") {
                    watch::RECHECK.store(true, Ordering::Relaxed); // 2초 기다리지 않고 바로 적용
                }
            });

            let menu = Menu::with_items(app, &[&MenuItem::with_id(app, "settings", "설정", true, None::<&str>)?, &MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("Hera")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|t, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, position, .. } = e {
                        tray::toggle(t.app_handle(), Some((position.x, position.y)), "main");
                    }
                })
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "settings" => {
                        let _ = open_settings(app, "general");
                    }
                    "quit" => {
                        // 디바운스(100ms) 대기 중인 쓰기를 즉시 저장
                        if let Ok(s) = app.store("hera.json") {
                            let _ = s.save();
                        }
                        app.exit(0)
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building hera")
        .run(|_, e| {
            // 창이 모두 닫혀도 트레이 앱은 계속 (끝내기 = 트레이 메뉴 '끝내기' → exit(0) 만)
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = e {
                crash_log("exit requested with no windows left — kept running");
                api.prevent_exit();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// (a13) 권한 목록(capability)에 없는 창은 store·이벤트 호출이 모두 거절된다 — Rust 가 만드는 창 라벨은 모두 들어 있어야 한다.
    #[test]
    fn every_window_label_has_the_capability() {
        let cap: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let pats: Vec<&str> = cap["windows"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
        let covered = |l: &str| pats.iter().any(|p| p.strip_suffix('*').map_or(*p == l, |pre| l.starts_with(pre)));
        let mut labels = vec!["settings".to_string(), "notes".into(), "panel".into(), "toast".into(), "drag".into(), "pet".into()];
        labels.extend(FX_LABELS.iter().map(|s| s.to_string()));
        let mons: Vec<Mon> = (0..3).map(|i| ((i * 1920, 0), (1920, 1080), 1.0)).collect();
        labels.extend(cover_rects(&mons).into_iter().map(|c| c.0));
        for l in labels {
            assert!(covered(&l), "권한 목록에 창 {l} 없음 → store·이벤트 호출이 거절된다");
        }
    }

    #[test]
    fn old_keys_go_new_keys_stay() {
        for k in ["record:calc", "todo:1", "event:x", "chat.unread", "chatin:f", "team.group:g", "term.hotkey", "mcp.enabled", "island.pos", "float.notes", "appbar.on", "lp.star", "alarm.fired", "sync.meta", "fx.enabled", "dock.pinned", "seeded", "snippet:a", "note.edit"] {
            assert!(old_key(k), "{k} 는 지워야 한다");
        }
        for k in ["note:1", "note.color", "notes.board", "shelf:a", "link.cfg", "link.share", "locator.enabled", "ripple.enabled", "deco.enabled", "fx.city", "fx.coords", "fx.weather", "ascii.idleMin", "pet.kind", "board.rect"] {
            assert!(!old_key(k), "{k} 는 남아야 한다");
        }
    }

    #[test]
    fn shelf_rules() {
        let cur = |n: usize| (0..n).map(|i| (format!("shelf:{i}"), json!({ "id": i.to_string(), "path": format!("C:\\f{i}"), "at": i as i64 }))).collect::<Vec<_>>();
        // 같은 경로는 앞으로 (중복 없음)
        let (add, del) = shelf_plan(&cur(3), &["C:\\f1".into()], "pc", 100);
        assert_eq!(del, ["shelf:1"]);
        assert_eq!((add.len(), add[0].1["path"].as_str(), add[0].1["from"].as_str()), (1, Some("C:\\f1"), Some("pc")));
        // 넘치면 오래된 것부터
        let (add, del) = shelf_plan(&cur(SHELF_MAX), &["C:\\new".into(), "C:\\new2".into()], "mac", 100);
        assert_eq!(del, ["shelf:0", "shelf:1"]);
        assert_eq!(add.iter().map(|a| a.1["at"].as_i64().unwrap()).collect::<Vec<_>>(), [100, 101]);
        assert!(add.iter().all(|a| a.1["from"] == "mac"));
        assert_eq!(shelf_plan(&[], &[], "pc", 1), (vec![], vec![]));
    }

    #[test]
    fn cover_picks_both_kinds_without_repeat() {
        let mut prev = usize::MAX;
        let mut seen = [false; COVER_SCENES.len()];
        let mut x = 12345u32;
        for _ in 0..500 {
            x = x.wrapping_mul(1103515245).wrapping_add(12345);
            let i = pick_cover(prev, x >> 8);
            assert!(i < COVER_SCENES.len());
            assert_ne!(i, prev, "직전 장면이 바로 다시 나오면 안 된다");
            seen[i] = true;
            prev = i;
        }
        assert!(seen.iter().all(|&s| s), "아스키·효과 모든 장면이 나온다");
        for p in 0..COVER_SCENES.len() {
            let got: std::collections::HashSet<_> = (0..9).map(|r| pick_cover(p, r)).collect();
            assert_eq!(got.len(), 9);
            assert!(!got.contains(&p));
        }
    }

    #[test]
    fn cover_one_window_per_monitor() {
        let mons = [((-1920, 0), (1920, 1080), 1.0), ((0, 0), (3840, 2160), 1.5), ((3840, -300), (2560, 1440), 1.25)];
        let r = cover_rects(&mons);
        assert_eq!(r.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["ascii", "ascii-1", "ascii-2"]);
        assert_eq!((r[1].1, r[1].2, r[1].3), ((0, 0), (3840, 2160), (2560.0, 1440.0)));
        assert_eq!((r[2].1, r[2].2, r[2].3), ((3840, -300), (2560, 1440), (2048.0, 1152.0)));
        assert!(cover_rects(&[]).is_empty());
    }
}
