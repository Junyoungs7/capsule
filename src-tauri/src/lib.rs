// Windows 전용 모듈 — 맥 등에서는 stub.rs 의 같은 이름 모듈(빈 구현)로 컴파일만 된다 (docs/mac-port.md)
#[cfg(windows)]
mod clip;
#[cfg(windows)]
mod edge;
#[cfg(windows)]
mod icons;
#[cfg(windows)]
mod launch;
#[cfg(windows)]
mod ocr;
#[cfg(windows)]
mod ripple;
#[cfg(windows)]
mod shell;
#[cfg(windows)]
mod appbar;
#[cfg(windows)]
mod watch;
#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
use stub::{appbar, clip, icons, launch, ocr, shell, watch};
mod holidays;
mod link;
mod link_files;
mod link_layout;
mod link_sync;
mod team;
pub mod mcp; // AI 연결(MCP) — docs/mcp.md
mod ui;
mod float;
mod term;
mod island;
mod pets; // 내 펫 (사용자 이미지 팩)
mod notes; // 메모 보드 · 메모장으로 열기
mod crossing; // Hera Link 넘어감: 벽 · 자리 · 한 번만

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_store::StoreExt;
use std::sync::atomic::{AtomicIsize, AtomicU32, AtomicUsize, Ordering};

// 아일랜드 창 = 주 모니터 폭 × 600 (island.rs). 모양은 CSS (노치 120×6 · 알약 · 허브 · 안의 화면) — 클릭 통과는 watch 루프의 히트 rect.
/// 터미널 드롭다운 단축키 기본값 (store `term.hotkey` 로 바꿈)
const TERM_HOTKEY: &str = "Ctrl+Backquote";
const SETTINGS: (f64, f64) = (940.0, 680.0); // (a6) 설정 창 (예전 패널 창 대신)
const PALETTE: (f64, f64) = (596.0, 460.0);
/// C3 팔레트 단축키 (Open Question 2 — Win+K 는 OS 예약, Alt+Space 는 PowerToys 와 충돌)
const PALETTE_HOTKEY: &str = "Ctrl+Alt+K";

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

fn overlay(app: &AppHandle, label: &'static str, query: &str, size: (f64, f64)) -> tauri::Result<WebviewWindow> {
    let win = builder(app, label, format!("index.html?surface={label}{query}"), size)
        .shadow(false)
        .focusable(false) // tao: WS_EX_NOACTIVATE (TOOLWINDOW 은 watch 루프가 유지)
        .build()?;
    let _ = ui::low_memory(&win); // 최적화일 뿐 — 실패해도 창은 쓴다
    watch::add_overlay(label, ui::hwnd(&win)); // 클릭 통과·전체화면 숨김 대상
    Ok(win)
}

/// (a4) 할 일 = 기간 (start ~ due). 예전 하루짜리 할 일은 start = due 로
pub(crate) fn migrate_todo(v: &serde_json::Value) -> Option<serde_json::Value> {
    (v.get("due").is_some_and(|d| d.is_string()) && v.get("start").is_none()).then(|| {
        let mut n = v.clone();
        n["start"] = v["due"].clone();
        n
    })
}

/// 배치: 아일랜드 = 주 모니터 작업 영역 오른쪽(왼쪽) 아래 모서리. DPI/작업 영역 변경 시 재호출.
pub(crate) fn place(app: &AppHandle) {
    let Ok(Some(m)) = app.primary_monitor() else { return };
    let (s, wa) = (m.scale_factor(), *m.work_area());
    island::place(app);
    let _ = (s, wa);
}

/// (a6) 설정 창 940×680: 처음 열 때 만들고(평소 0), 닫으면 파괴. 열려 있으면 그 섹션으로 + 앞으로.
/// sec = general|island|pet|link|chat|term|keys|about (연결은 `link:devices` 처럼 탭까지)
pub(crate) fn open_settings(app: &AppHandle, sec: &str) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("settings") {
        app.emit_to("settings", "settings-sec", sec)?;
        w.show()?;
        return w.set_focus();
    }
    let mut b = builder(app, "settings", format!("index.html?surface=settings&sec={sec}"), SETTINGS)
        .shadow(true) // Win11: 라운드 코너 + 그림자
        .center()
        .disable_drag_drop_handler();
    if let Some(island) = app.get_webview_window("island") {
        b = b.parent(&island)?; // 소유 창(owner = TOOLWINDOW 아일랜드) → Alt+Tab 에서 제외
    }
    let win = b.build()?;
    win.show()?;
    win.set_focus()
}

/// C3 팔레트: 시작 시 숨김 상태로 1회 생성해 두고 단축키마다 보이기/숨기기.
/// 결정(측정): 단축키마다 생성하면 invoke→첫 페인트 p50 240 / p95 309ms 로 150ms 초과 → 숨김 유지(+~10MB, idle 합 ≤150MB 안).
/// 열기 직전 포그라운드 창을 기억했다가 Esc 로 닫으면 돌려준다.
static PALETTE_PREV: AtomicIsize = AtomicIsize::new(0);
static TERM_KEY: std::sync::OnceLock<tauri_plugin_global_shortcut::Shortcut> = std::sync::OnceLock::new();

fn palette_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let win = builder(app, "palette", "index.html?surface=palette".into(), PALETTE).shadow(false).build()?;
    ui::low_memory(&win)?;
    Ok(win)
}

fn toggle_palette(app: &AppHandle) -> tauri::Result<()> {
    show_palette(app, None)
}

/// 팔레트 보이기. q = 처음 검색어 (허브 '스니펫' = ";"). 이미 보이면(q 없음) 닫기.
fn show_palette(app: &AppHandle, q: Option<String>) -> tauri::Result<()> {
    let win = match app.get_webview_window("palette") {
        Some(w) if w.is_visible()? && q.is_none() => return close_palette_win(app, true),
        Some(w) if w.is_visible()? => return app.emit_to("palette", "palette-open", q),
        Some(w) => w,
        None => palette_window(app)?,
    };
    PALETTE_PREV.store(ui::foreground(), Ordering::Relaxed);
    if let Ok(Some(m)) = app.primary_monitor() {
        let (s, wa) = (m.scale_factor(), *m.work_area());
        let (x, w) = (wa.position.x as f64, wa.size.width as f64);
        let y = wa.position.y as f64 + wa.size.height as f64 * 0.17 - 8.0 * s;
        win.set_position(PhysicalPosition::new((x + (w - PALETTE.0 * s) / 2.0).round() as i32, y.round() as i32))?;
    }
    win.show()?;
    // Alt+Tab 제외 = TOOLWINDOW, APPWINDOW 없음 (포커스는 받음 — NOACTIVATE 아님). tao 가 show 때 GWL_EXSTYLE 을 통째로 다시 쓰므로
    // 보이기 처리 뒤(메인 스레드 큐에서 show 다음 순서)에 OR 한다.
    let w = win.clone();
    app.run_on_main_thread(move || ui::toolwindow(&w))?;
    win.set_focus()?; // 전역 단축키(WM_HOTKEY)를 받은 직후라 전면 전환이 허용된다
    app.emit_to("palette", "palette-open", q)
}

fn close_palette_win(app: &AppHandle, restore: bool) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("palette") {
        w.hide()?;
    }
    if restore {
        ui::restore_foreground(PALETTE_PREV.load(Ordering::Relaxed));
    }
    Ok(())
}

#[tauri::command]
async fn palette(app: AppHandle, q: Option<String>) -> Result<(), String> {
    if q.is_some() {
        return show_palette(&app, q).map_err(|e| e.to_string());
    }
    toggle_palette(&app).map_err(|e| e.to_string())
}

/// v3 상용구 붙여넣기: 팔레트를 숨기고 직전 앱으로 포커스를 돌려준 뒤 그 앱에 붙여넣는다 (클립보드는 잠깐 빌림)
#[tauri::command]
async fn snippet_paste(app: AppHandle, text: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("palette") {
        let _ = w.hide();
    }
    tauri::async_runtime::spawn_blocking(move || clip::paste(&text, || ui::restore_foreground(PALETTE_PREV.load(Ordering::Relaxed)))).await.map_err(|e| e.to_string())?
}

/// 숨기기. restore = Esc/바깥 클릭(이전 앱으로 포커스 반환). 실행·포커스 잃음은 false.
#[tauri::command]
async fn close_palette(app: AppHandle, restore: bool) -> Result<(), String> {
    close_palette_win(&app, restore).map_err(|e| e.to_string())
}

/// C1 플래터 클릭 → 레코드의 앱 창 전면 (keys = exe 경로 / shell:appsfolder\aumid, 소문자)
#[tauri::command]
async fn activate(keys: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || launch::sta(move || watch::activate(&keys))).await.map_err(|e| e.to_string())?
}

/// C4 배터리 (잔량 %, 충전 중) — 없으면 null. 변화는 watch 루프가 'power' 로 알린다.
#[tauri::command]
fn power() -> Option<(u8, bool)> {
    watch::power()
}

/// v2 클립보드 기록 (메모리에만)
#[tauri::command]
fn clips() -> Vec<clip::Clip> {
    clip::list()
}

#[tauri::command]
async fn set_clip(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || clip::set(&text)).await.map_err(|e| e.to_string())?
}

/// v2 아스키 전체화면 창: 필요할 때 생성, 닫으면 JS 가 닫힘 애니메이션 후 파괴 (안 보일 때 메모리 0).
/// saver = 자리 비움 화면보호기(포커스 안 뺏음, 입력은 watch 루프가 감지). from = 위젯의 화면 rect(논리 px) → 그 자리에서 확대.
pub(crate) fn open_ascii(app: &AppHandle, saver: bool, from: Option<[f64; 4]>) -> tauri::Result<()> {
    open_ascii_scene(app, saver, from, None)
}

/// 아스키 장면 4 + 화면 효과 6 = 자리 비움 화면 덮개(a7)가 고르는 그림. 아스키 창이 ?scene= 으로 받는다.
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

/// 모니터마다 덮개 창 하나. 첫 창 = "ascii" (기존 이름), 나머지 "ascii-1" …
pub(crate) fn cover_rects(mons: &[Mon]) -> Vec<Cover> {
    mons.iter()
        .enumerate()
        .map(|(i, &(pos, size, s))| (if i == 0 { "ascii".into() } else { format!("ascii-{i}") }, pos, size, (size.0 as f64 / s, size.1 as f64 / s)))
        .collect()
}

/// 열려 있는 아스키/덮개 창 전부
pub(crate) fn ascii_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows().into_iter().filter(|(l, _)| l == "ascii" || l.starts_with("ascii-")).map(|(_, w)| w).collect()
}

/// 아스키 창 전부 닫기 요청 (JS 가 닫힘 애니메이션 후 스스로 파괴)
pub(crate) fn ascii_close_all(app: &AppHandle) {
    for w in ascii_windows(app) {
        let _ = w.emit_to(w.label(), "ascii-close", ());
    }
}

/// scene = 장면 (없으면: 화면보호기 = 무작위 덮개, 그 밖 = 계절·시간대 자동).
/// 화면보호기는 모든 모니터를 덮는다 (a7: 예전엔 primary_monitor 하나만 → 듀얼 모니터의 한쪽만 가려졌다).
pub(crate) fn open_ascii_scene(app: &AppHandle, saver: bool, from: Option<[f64; 4]>, scene: Option<&str>) -> tauri::Result<()> {
    if !ascii_windows(app).is_empty() {
        return Ok(());
    }
    let mons: Vec<_> = if saver {
        app.available_monitors()?
    } else {
        app.primary_monitor()?.into_iter().collect()
    };
    let mons: Vec<_> = mons.iter().map(|m| ((m.position().x, m.position().y), (m.size().width, m.size().height), m.scale_factor())).collect();
    // ponytail: 모든 모니터에 같은 장면 — 무게는 다른 장면과 같고(창 = 웹뷰 하나씩), 고르기·직전 피하기가 한 번이면 된다
    let picked = match scene {
        None if saver => {
            let mut b = [0u8; 4];
            let _ = getrandom::fill(&mut b);
            let i = pick_cover(COVER_LAST.load(Ordering::Relaxed), u32::from_le_bytes(b));
            COVER_LAST.store(i, Ordering::Relaxed);
            Some(COVER_SCENES[i])
        }
        s => s,
    };
    let q = from.map(|f| format!("&from={},{},{},{}", f[0], f[1], f[2], f[3])).unwrap_or_default() + &picked.map(|s| format!("&scene={s}")).unwrap_or_default();
    for (label, pos, size, logical) in cover_rects(&mons) {
        let win = builder(app, &label, format!("index.html?surface=ascii&saver={}{q}", saver as u8), logical)
            .shadow(false)
            .focusable(!saver)
            .disable_drag_drop_handler()
            .build()?;
        // Island 의 '아스키 재생 중 · <장면>' 은 실제 창 수명을 따른다 (다른 창이 열어도 · 입력으로 닫혀도)
        let h = app.clone();
        win.on_window_event(move |e| {
            if let WindowEvent::Destroyed = e {
                let _ = h.emit("ascii-closed", ());
            }
        });
        // 위치 먼저(그 모니터로 옮겨 DPI 가 바뀜) → 그 다음 물리 크기 (DPI 변경이 크기를 바꿔도 덮어씀)
        let (pos, size) = (PhysicalPosition::new(pos.0, pos.1), PhysicalSize::new(size.0, size.1));
        let r = win.set_position(pos).and_then(|_| win.set_size(size)).and_then(|_| win.show());
        if r.is_err() {
            let _ = win.destroy();
            return r;
        }
        if !saver {
            let _ = win.set_focus(); // 클릭 직후라 전면 전환 허용 → Esc 가 먹는다
        }
    }
    let _ = app.emit("ascii-open", serde_json::json!({ "scene": picked, "saver": saver }));
    Ok(())
}

#[tauri::command]
async fn ascii(app: AppHandle, from: Option<[f64; 4]>, scene: Option<String>) -> Result<(), String> {
    let scene = scene.filter(|s| ["xmas", "city", "autumn", "calm"].contains(&s.as_str()));
    open_ascii_scene(&app, false, from, scene.as_deref()).map_err(|e| e.to_string())
}

/// Island '아스키 재생 중' 정지 버튼: 아스키 창이 닫힘 애니메이션 후 스스로 파괴 (3초 안에 안 닫히면 강제)
#[tauri::command]
fn ascii_stop(app: AppHandle) {
    ascii_close_all(&app);
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        for w in ascii_windows(&h) {
            let _ = w.destroy();
        }
    });
}

const FX_KINDS: [&str; 6] = ["snow", "rain", "leaves", "dawn", "sunset", "moon"];
static FX_GEN: AtomicU32 = AtomicU32::new(0);

/// v2 전체화면 효과 창: 투명·클릭 통과 오버레이(watch 루프가 TRANSPARENT|LAYERED|NOACTIVATE|TOOLWINDOW 유지)를 그때만 만들고
/// 25초 효과가 끝나면 JS 가 파괴. 독·아일랜드·턴테이블은 다시 맨 위로 올려 효과가 그 아래에 깔리게 한다. 전체화면 앱 중엔 안 만든다.
pub(crate) fn open_fx(app: &AppHandle, kind: &str) -> tauri::Result<()> {
    let Some(kind) = FX_KINDS.iter().find(|k| **k == kind) else { return Ok(()) };
    if watch::FULLSCREEN.load(Ordering::Relaxed) || app.get_webview_window("fx").is_some() {
        return Ok(());
    }
    let Some(m) = app.primary_monitor()? else { return Ok(()) };
    let (pos, size, s) = (*m.position(), *m.size(), m.scale_factor());
    // 높이 -1px: 모니터를 꽉 채운 최상위 창은 셸이 '전체화면 앱'으로 판정해(QUNS_BUSY) 독을 숨기게 된다
    let size = PhysicalSize::new(size.width, size.height.saturating_sub(1));
    let win = overlay(app, "fx", &format!("&fx={kind}"), (size.width as f64 / s, size.height as f64 / s))?;
    let h = app.clone();
    win.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            watch::remove_overlay("fx");
            let _ = h.emit("fx-closed", ()); // LP 플레이어 판 돌아옴 · Island 재생 중 알약 끔
        }
    });
    let r = win.set_position(pos).and_then(|_| win.set_size(size)).and_then(|_| win.show());
    if r.is_err() {
        let _ = win.destroy();
        return r;
    }
    if let Some(w) = app.get_webview_window("island") {
        ui::raise(&w);
    }
    let _ = app.emit("fx-open", kind);
    // 안전망: 웹뷰가 멈춰 onDone 이 안 와도 40초 뒤 파괴 (그 사이 새 효과가 열렸으면 그대로)
    let (h, gen) = (app.clone(), FX_GEN.fetch_add(1, Ordering::Relaxed) + 1);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(40));
        if FX_GEN.load(Ordering::Relaxed) == gen {
            if let Some(w) = h.get_webview_window("fx") {
                let _ = w.destroy();
            }
        }
    });
    Ok(())
}

/// store 변경 구독 (Rust). ⚠ tauri-plugin-store 는 store 잠금을 쥔 채 'store://change' 를 emit 하고, Rust 리스너는 그 emit 안에서
/// 바로 불린다 → 리스너가 store 를 다시 만지면 같은 스레드에서 재잠금(교착 또는 panic=abort). 그래서 전용 스레드로 넘겨 순서대로 처리한다.
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

/* ── v3 화면 글자 복사 (OCR) ── */
const OCR_HOTKEY: &str = "Ctrl+Alt+T";

/// 단축키·⌘K: 커서 모니터를 먼저 캡처하고 그 위에 어둡게·선택 창 (필요할 때만 생성)
pub(crate) fn ocr_open(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("ocr") {
        return w.set_focus().map_err(|e| e.to_string());
    }
    if let Some(p) = app.get_webview_window("palette").filter(|p| p.is_visible().unwrap_or(false)) {
        let _ = p.hide(); // 팔레트가 찍히지 않게
        std::thread::sleep(std::time::Duration::from_millis(120));
    }
    let r = ocr::capture_at_cursor()?;
    let m = app.monitor_from_point(r[0] as f64 + 1.0, r[1] as f64 + 1.0).ok().flatten().or(app.primary_monitor().ok().flatten()).ok_or("모니터 없음")?;
    let sc = m.scale_factor();
    let win = builder(app, "ocr", format!("index.html?surface=ocr&s={sc}"), (r[2] as f64 / sc, r[3] as f64 / sc)).shadow(false).disable_drag_drop_handler().build().map_err(|e| e.to_string())?;
    win.on_window_event(|e| {
        if let WindowEvent::Destroyed = e {
            ocr::clear(); // 캡처는 메모리에만, 창이 닫히면 버림
        }
    });
    let shown = win.set_position(PhysicalPosition::new(r[0], r[1])).and_then(|_| win.set_size(PhysicalSize::new(r[2] as u32, r[3] as u32))).and_then(|_| win.show());
    if let Err(e) = shown {
        let _ = win.destroy();
        return Err(e.to_string());
    }
    let _ = win.set_focus();
    Ok(())
}

#[tauri::command]
async fn ocr_start(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ocr_open(&app)).await.map_err(|e| e.to_string())?
}

/// 선택 영역(오버레이 CSS px) → (텍스트, 언어 태그)
#[tauri::command]
async fn ocr_region(window: WebviewWindow, x: f64, y: f64, w: f64, h: f64) -> Result<(String, String), String> {
    let s = window.scale_factor().unwrap_or(1.0);
    let r = [(x * s).round() as i32, (y * s).round() as i32, (w * s).round() as i32, (h * s).round() as i32];
    tauri::async_runtime::spawn_blocking(move || ocr::region(r))
    .await
    .map_err(|e| e.to_string())?
}

/// 결과를 Downloads\Hera 에 .txt 로 저장하고 독 선반에 ('shelf-add')
#[tauri::command]
fn ocr_save(app: AppHandle, text: String) -> Result<String, String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?.join("Hera");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let path = link_files::safe_name(&dir, &format!("화면 글자 {ts}.txt"));
    std::fs::write(&path, text.replace('\n', "\r\n").as_bytes()).map_err(|e| e.to_string())?;
    let p = path.display().to_string();
    let _ = app.emit_to("island", "shelf-add", p.clone());
    Ok(p)
}

/* ── Hera Team (team.rs) ── */
#[tauri::command]
fn team_state(app: AppHandle) -> team::app::State {
    team::app::state(&app)
}

#[tauri::command]
fn team_create(app: AppHandle, name: String, color: String) -> team::Group {
    team::app::create(&app, &name, &color)
}

/// (6자리 코드, 초대 문자열)
#[tauri::command]
fn team_invite(app: AppHandle, group: String) -> Result<(String, String), String> {
    team::app::invite(&app, &group)
}

/// 초대 문자열 · 6자리 코드 · "코드@IP"
#[tauri::command]
async fn team_join(app: AppHandle, input: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || team::app::join(&app, &input)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn team_flags(app: AppHandle, group: String, alarms: bool, news: bool) {
    team::app::flags(&app, &group, alarms, news)
}

#[tauri::command]
fn team_name(app: AppHandle, name: String) {
    team::app::set_name(&app, &name)
}

#[tauri::command]
fn team_dial(app: AppHandle, ip: String) -> Result<(), String> {
    team::app::dial(&app, &ip)
}

/// 수동 '지금 보기' (스위치와 무관, 전체화면 중엔 무시)
#[tauri::command]
async fn fx(app: AppHandle, kind: String) -> Result<(), String> {
    open_fx(&app, &kind).map_err(|e| e.to_string())
}

/* ── Hera Link (link.rs 엔진 · link_files.rs 파일 채널) ── */
#[tauri::command]
fn link_status() -> (link::Status, Option<String>) {
    (link::status(), link::files_connected())
}

/// 패널에서 설정을 바꾼 뒤: 엔진 감독 스레드가 다시 읽고, 켜졌으면 파일 채널도 시작
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

/// 패널 배치 캔버스: 모든 모니터(PC·맥) + 변환된 엔진 링크 구간 + 표현 못 하는 배치 설명
#[tauri::command]
fn link_plan(app: AppHandle) -> (Vec<link_layout::Mon>, link_layout::Plan) {
    link::plan(&app)
}

/// 상대 PC 에 아스키(ascii)·화면보호기(saver)·효과(fx) 켜기/끄기
#[tauri::command]
fn link_ambient(kind: String, fx: Option<String>, action: String) -> Result<(), String> {
    link::ambient(&kind, fx.as_deref(), &action)
}

#[tauri::command]
fn link_pair(ok: bool) {
    link::pair_confirm(ok);
}

#[tauri::command]
fn link_unpair(app: AppHandle) {
    link::unpair(&app);
}

#[tauri::command]
async fn link_send(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || link::send_file(&app, &path)).await.map_err(|e| e.to_string())?
}

/// 허브(레이아웃 A) 아이콘: 떠 있는 창이 아닌 것들. 나머지(할 일·달력·채팅·터미널·최근 복사·선반·LP)는 float_open.
#[tauri::command]
async fn hub_action(app: AppHandle, kind: String) -> Result<(), String> {
    let e = |e: tauri::Error| e.to_string();
    match kind.as_str() {
        "notes" => float::open(&app, "notes").map_err(e), // (a4) 메모 보드
        "ocr" => tauri::async_runtime::spawn_blocking(move || ocr_open(&app)).await.map_err(|e| e.to_string())?,
        "snippets" => show_palette(&app, Some(";".into())).map_err(e),
        "team" => open_settings(&app, "chat").map_err(e),
        "link" => open_settings(&app, "link").map_err(e),
        "settings" => open_settings(&app, "general").map_err(e),
        "palette" => show_palette(&app, Some(String::new())).map_err(e),
        _ => Err(format!("unknown hub action {kind}")),
    }
}

/* ── 팀 채팅 (team.rs: 메시지 = chat:<id> 동기화, 파일 = 보낸 사람에게서 직접) ── */
#[tauri::command]
async fn chat_send_paths(app: AppHandle, group: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| team::app::chat_send_file(&app, &group, std::path::Path::new(p))).collect())
        .await
        .map_err(|e| e.to_string())?
}

/// '+' 로 고른 파일 (웹뷰 File = 경로 없음): 바이트를 받아 임시 파일 → 같은 경로
#[tauri::command]
async fn chat_attach(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let h = request.headers();
    let group = h.get("x-group").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let name = h.get("x-name").and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_else(|| "file".into());
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("raw body expected".into()) };
    let dir = std::env::temp_dir().join(format!("hera-chat-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = link_files::safe_name(&dir, &name);
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    let r = tauri::async_runtime::spawn_blocking(move || {
        let r = team::app::chat_send_file(&app, &group, &tmp);
        let _ = std::fs::remove_file(&tmp);
        r
    })
    .await
    .map_err(|e| e.to_string())?;
    r
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(x) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(x);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 채팅 사진·파일 복사 = 파일을 클립보드에 / 선반에 놓기
#[tauri::command]
fn clip_files(paths: Vec<String>) -> Result<(), String> {
    clip::set_files(&paths)
}

/// (a9) Windows 파일 열기 대화상자 → 경로들 (취소 = 빈 목록)
#[tauri::command]
async fn pick_files(multi: bool) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || launch::pick_files(multi)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn shelf_add(app: AppHandle, path: String) -> Result<(), String> {
    app.emit_to("island", "shelf-add", path).map_err(|e| e.to_string())
}

/* ── 미니 터미널 (term.rs: ConPTY 셸 1개, 창과 따로 산다) ── */
#[tauri::command]
fn term_start(app: AppHandle, cols: u16, rows: u16) -> Result<String, String> {
    term::start(&app, cols, rows)
}

#[tauri::command]
fn term_write(app: AppHandle, data: String) -> Result<(), String> {
    term::write(&app, &data)
}

#[tauri::command]
fn term_resize(cols: u16, rows: u16) {
    term::resize(cols, rows)
}

#[tauri::command]
fn term_kill() {
    term::kill()
}

#[tauri::command]
fn term_state() -> term::TermState {
    term::state()
}

/// '아라에서 이어서 하기' → 이어 간 폴더
#[tauri::command]
async fn term_to_ara(with_cmd: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || term::to_ara(with_cmd)).await.map_err(|e| e.to_string())?
}

/// '상단 공간 확보' 스위치 (store `appbar.on` 변경으로도 맞춰진다 — 이 커맨드는 즉시 반영용)
#[tauri::command]
fn appbar_set(app: AppHandle, on: bool) {
    appbar::set(&app, on);
}

/// LP 플레이어: 효과 레코드를 내림 → 효과 창 닫기 (JS 가 사라짐 애니메이션 후 파괴, 3초 안전망)
#[tauri::command]
fn fx_stop(app: AppHandle) {
    let _ = app.emit_to("fx", "fx-close", ());
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        if let Some(w) = h.get_webview_window("fx") {
            let _ = w.destroy();
        }
    });
}

/// 설정 창 열기 (허브 '설정' · '전체 설정' · 'Link 설정' · 트레이)
#[tauri::command]
async fn settings_open(app: AppHandle, sec: String) -> Result<(), String> {
    open_settings(&app, &sec).map_err(|e| e.to_string())
}

/// 자기 창 닫기 (설정 창 · OCR 등)
#[tauri::command]
fn close_self(window: WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

/// Windows 시작 시 실행: on = None 이면 읽기만. 트레이 체크 표시도 같이
#[tauri::command]
fn autostart(app: AppHandle, on: Option<bool>) -> bool {
    let a = app.autolaunch();
    if let Some(on) = on {
        let _ = if on { a.enable() } else { a.disable() };
    }
    let now = a.is_enabled().unwrap_or(false);
    if let Some(m) = app.try_state::<AutoMenu>() {
        let _ = m.0.set_checked(now);
    }
    now
}
struct AutoMenu(tauri::menu::CheckMenuItem<tauri::Wry>);

#[tauri::command]
fn report_hit_rects(window: WebviewWindow, rects: Vec<[f64; 4]>) {
    watch::set_rects(window.label(), rects);
}

/// B0-1 ② 배경화면 페이크: 현재 배경화면 파일 바이트 (JS 가 축소·블러해 정적 캔버스로 그림)
#[tauri::command]
async fn wallpaper() -> Result<tauri::ipc::Response, String> {
    let p = watch::wallpaper_path();
    if p.is_empty() {
        return Err("no wallpaper".into());
    }
    std::fs::read(p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
fn wallpaper_style() -> (String, String) {
    watch::wallpaper_style()
}

#[tauri::command]
async fn launch(target: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || launch::sta(move || launch::launch(&target))).await.map_err(|e| e.to_string())?
}

/// 아이콘 PNG 의 절대 경로 (JS 가 convertFileSrc → asset protocol, scope = $APPDATA/icons/**)
#[tauri::command]
async fn icon(app: AppHandle, target: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("icons");
    tauri::async_runtime::spawn_blocking(move || icons::icon(&dir, &target).map(|p| p.display().to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// 선반 → 밖(탐색기·앱)으로 파일 끌어내기. OLE DoDragDrop 은 UI(메인) 스레드에서만 → run_on_main_thread.
#[tauri::command]
async fn drag_out(app: AppHandle, win: WebviewWindow, path: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("icons");
    let p = path.clone();
    let img = tauri::async_runtime::spawn_blocking(move || icons::icon(&dir, &p)).await.map_err(|e| e.to_string())?;
    let w = win.clone();
    win.run_on_main_thread(move || {
        let image = img.map_or(drag::Image::Raw(vec![]), drag::Image::File);
        if let Err(e) = drag::start_drag(&w, drag::DragItem::Files(vec![path.into()]), image, |_, _| {}, Default::default()) {
            eprintln!("drag_out: {e}");
        }
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_apps()-> Result<Vec<(String, String)>, String> {
    tauri::async_runtime::spawn_blocking(launch::start_apps).await.map_err(|e| e.to_string())?
}

/// 마지막 포그라운드 앱 + 실행 집합 (창이 늦게 떠도 즉시 표시)
#[tauri::command]
fn watch_state() -> (Option<watch::Fg>, Vec<String>) {
    watch::STATE.lock().unwrap().clone()
}

/// B4: island 의 'alarm' 리스너 준비 완료 → watch 루프가 알림 검사 시작
#[tauri::command]
fn alarms_ready() {
    watch::ALARMS_READY.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// B5: .lnk 의 대상 exe (레코드 추가 시 1회 → 실행 점 매칭용)
#[tauri::command]
async fn lnk_target(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || launch::sta(move || launch::lnk_target(&path))).await.map_err(|e| e.to_string())?
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = open_settings(app, "general"); // 두 번째 실행 = 설정 창
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            settings_open, close_self, autostart, report_hit_rects, wallpaper, wallpaper_style, launch, icon, drag_out, start_apps, watch_state, alarms_ready, lnk_target,
            ascii_stop, team_state, team_create, team_invite, team_join, team_flags, team_name, team_dial, snippet_paste, ocr_start, ocr_region, ocr_save, palette, close_palette, activate, power, clips, set_clip, ascii, fx, fx_stop,
            float::float_open, float::float_close, float::float_pin, float::float_show, float::float_prepare, float::float_ready, float::float_drag, float::float_absorbed, island::island_tall, island::island_focus, island::island_paste, hub_action, appbar_set, chat_send_paths, chat_attach, clip_files, pick_files, shelf_add, term_start, term_write, term_resize, term_kill, term_state, term_to_ara, link_status, link_apply, link_import, link_trust, link_pair, link_unpair, link_send, link_plan, link_ambient,
            notes::note_notepad, pets::pet_list, pets::pet_save, pets::pet_delete, pets::pet_import, pets::pet_export,
            mcp::mcp_log, mcp::mcp_info, mcp::mcp_confirm // AI 연결(MCP)
        ])
        .setup(|app| {
            // 깨진 hera.json: 스토어 플러그인은 읽기 오류를 무시하고 빈 스토어로 열어 곧 덮어쓴다 → 먼저 옆으로 치워 둔다
            let file = app.path().app_data_dir()?.join("hera.json");
            if std::fs::read(&file).is_ok_and(|b| serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&b).is_err()) {
                let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
                let bak = file.with_file_name(format!("hera.json.bak-{ts}"));
                eprintln!("hera.json 이 깨져 있어 {}로 옮기고 새로 만든다: {:?}", bak.display(), std::fs::rename(&file, &bak));
            }
            // 첫 실행 시드 (Rust 에서 1회 — 여러 창이 동시에 시드하는 경쟁 없음)
            let s = app.store("hera.json")?;
            if !s.has("seeded") {
                for (id, title, target, cover, glyph) in [
                    ("calc", "계산기", r"shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", "#334155", "calc"),
                    ("notepad", "메모장", r"shell:AppsFolder\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App", "#0EA5E9", "notepad"),
                    ("github", "GitHub", "https://github.com", "#1F2937", "text"),
                ] {
                    s.set(format!("record:{id}"), serde_json::json!({ "id": id, "title": title, "target": target, "kind": "single", "cover": cover, "glyph": glyph }));
                }
                s.set("dock.pinned", serde_json::json!(["calc", "notepad", "github"]));
                s.set("seeded", true);
            }
            // (a4) 할 일 기간: 예전 하루짜리(due 만) → start = due (한 번, 이미 start 가 있으면 그대로)
            for (k, v) in s.entries() {
                if let Some(n) = k.starts_with("todo:").then(|| migrate_todo(&v)).flatten() {
                    s.set(k, n);
                }
            }
            let h = app.handle();
            // 상단 공간 확보(AppBar): 지난 실행이 못 돌려준 예약부터 정리 → 설정이 켜져 있으면 다시 등록
            appbar::cleanup_stale(h);
            if s.get("appbar.on").and_then(|v| v.as_bool()).unwrap_or(false) {
                appbar::set(h, true);
            }
            let island = overlay(h, "island", "", (island::WIDTH, island::HEIGHT))?;
            place(h);
            {
                let h = h.clone();
                island.on_window_event(move |e| {
                    if let WindowEvent::ScaleFactorChanged { .. } = e {
                        place(&h);
                        appbar::refresh(&h);
                    }
                });
            }
            island.show()?;
            watch::start(h.clone());
            clip::start(h.clone());
            shell::start(h.clone());
            // Hera Link: 기본 꺼짐. 켜져 있을 때만 엔진·파일 채널이 뜬다 (꺼져 있으면 스레드 1개가 대기만)
            link::start(h.clone());
            team::app::start(h); // 그룹이 있을 때만 포트·비콘
            link::files_start(h);
            mcp::start(h.clone()); // AI 연결(MCP): 파이프 대기 (꺼져 있으면 호출을 거절)
            // 팔레트는 부가 기능 — 실패해도 시작은 계속 (첫 단축키 때 다시 만든다)
            if let Err(e) = palette_window(h) {
                eprintln!("palette window: {e}");
            }
            // v3: 턴테이블 창 제거 → 남은 설정 정리
            for k in ["turntable.open", "turntable.pos"] {
                s.delete(k);
            }

            // C3: 전역 단축키 → 팔레트 (창 생성은 비동기 스레드에서 — toggle_panel 과 같은 경로)
            h.plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, sc, e| {
                        if e.state != ShortcutState::Pressed {
                            return;
                        }
                        let h = app.clone();
                        let ocr = OCR_HOTKEY.parse::<tauri_plugin_global_shortcut::Shortcut>().is_ok_and(|o| &o == sc);
                        let term = TERM_KEY.get().is_some_and(|t| t == sc);
                        if term {
                            // 터미널 드롭다운: 아일랜드가 노치에서 펼쳐지고 키보드를 받는다
                            island::island_focus(h.clone(), true);
                            let _ = h.emit_to("island", "island-open", "term");
                        } else if ocr {
                            tauri::async_runtime::spawn_blocking(move || ocr_open(&h).map_err(|e| eprintln!("ocr: {e}")));
                        } else {
                            tauri::async_runtime::spawn(async move { toggle_palette(&h) });
                        }
                    })
                    .build(),
            )?;
            let _ = h.global_shortcut().register(PALETTE_HOTKEY); // 다른 앱이 선점하면 실패 → 트레이 '검색' 으로 연다
            let _ = h.global_shortcut().register(OCR_HOTKEY); // v3 화면 글자 복사 (⌘K 에도 있음)
            // 터미널 드롭다운 (기본 Ctrl+`, store `term.hotkey` 로 바꿀 수 있음 — 다음 실행부터)
            let tk = s.get("term.hotkey").and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| TERM_HOTKEY.into());
            if let Ok(k) = tk.parse::<tauri_plugin_global_shortcut::Shortcut>().or_else(|_| TERM_HOTKEY.parse()) {
                if h.global_shortcut().register(k).is_ok() {
                    let _ = TERM_KEY.set(k);
                }
            }
            notes::migrate(h); // (a4) 바탕화면 메모 → 메모 보드
            {
                let a = h.clone();
                listen_store(h, move |k, v| {
                    if k == "island.place" {
                        island::place(&a); // 오른쪽 아래 ↔ 왼쪽 아래
                    }
                    if k == "appbar.on" {
                        appbar::set(&a, v.and_then(|v| v.as_bool()).unwrap_or(false));
                    }
                });
            }

            // 트레이: skipTaskbar 라 종료 경로가 필요. 자동 시작은 기본 꺼짐(사용자가 켤 때만).
            let auto = CheckMenuItem::with_id(app, "autostart", "로그인 시 자동 시작", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
            let fx_on = s.get("fx.enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            let fx_item = CheckMenuItem::with_id(app, "fx", "날씨·계절 효과", true, fx_on, None::<&str>)?;
            app.manage(watch::FxMenu(fx_item.clone()));
            app.manage(AutoMenu(auto.clone()));

            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "settings", "설정 열기", true, None::<&str>)?,
                    &MenuItem::with_id(app, "palette", format!("검색 ({PALETTE_HOTKEY})"), true, None::<&str>)?,
                    &fx_item,
                    &auto,
                    &MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?,
                ],
            )?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("Hera")
                .menu(&menu)
                .on_menu_event(move |app, e| match e.id().as_ref() {
                    "settings" => {
                        let _ = open_settings(app, "general");
                    }
                    "palette" => {
                        let h = app.clone();
                        tauri::async_runtime::spawn(async move { toggle_palette(&h) });
                    }
                    "fx" => {
                        // 체크 표시는 메뉴가 이미 뒤집었다 → 그 값을 저장 (패널 스위치는 store 변경 이벤트로 따라온다)
                        if let (Ok(s), Some(m)) = (app.store("hera.json"), app.try_state::<watch::FxMenu>()) {
                            s.set("fx.enabled", m.0.is_checked().unwrap_or(true));
                        }
                    }
                    "autostart" => {
                        let a = app.autolaunch();
                        let _ = if a.is_enabled().unwrap_or(false) { a.disable() } else { a.enable() };
                        let _ = auto.set_checked(a.is_enabled().unwrap_or(false));
                    }
                    "quit" => {
                        appbar::release(app); // 상단 예약은 꼭 돌려준다
                        // 디바운스(100ms) 대기 중인 쓰기를 즉시 저장 (플러그인도 Exit 에서 저장하지만 순서 보장용)
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
        .run(|app, e| {
            if let tauri::RunEvent::Exit = e {
                appbar::release(app); // 어떤 경로로 끝나도 상단 예약 해제
                term::kill(); // 터미널 셸도 함께 정리
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn todo_range_migration() {
        let old = json!({ "id": "a", "title": "보고서", "due": "2026-11-18T09:00:00.000Z", "done": false });
        let n = migrate_todo(&old).unwrap();
        assert_eq!(n["start"], n["due"]);
        assert_eq!(n["title"], "보고서");
        assert!(migrate_todo(&n).is_none()); // 두 번 하지 않는다
        assert!(migrate_todo(&json!({ "id": "b", "title": "기한 없음" })).is_none());
        assert!(migrate_todo(&json!({ "start": "2026-11-16T00:00:00.000Z", "due": "2026-11-18T09:00:00.000Z" })).is_none()); // 이미 기간
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
        // 직전 것을 뺀 나머지 9개에 고르게 (r 의 모든 나머지)
        for p in 0..COVER_SCENES.len() {
            let got: std::collections::HashSet<_> = (0..9).map(|r| pick_cover(p, r)).collect();
            assert_eq!(got.len(), 9);
            assert!(!got.contains(&p));
        }
    }

    #[test]
    fn cover_one_window_per_monitor() {
        // 왼쪽(음수 원점) 1080p 100% · 가운데 주 모니터 4K 150% · 위쪽 1440p 125%
        let mons = [((-1920, 0), (1920, 1080), 1.0), ((0, 0), (3840, 2160), 1.5), ((3840, -300), (2560, 1440), 1.25)];
        let r = cover_rects(&mons);
        assert_eq!(r.len(), 3);
        assert_eq!(r.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["ascii", "ascii-1", "ascii-2"]);
        assert_eq!((r[0].1, r[0].2, r[0].3), ((-1920, 0), (1920, 1080), (1920.0, 1080.0)));
        assert_eq!((r[1].1, r[1].2, r[1].3), ((0, 0), (3840, 2160), (2560.0, 1440.0)));
        assert_eq!((r[2].1, r[2].2, r[2].3), ((3840, -300), (2560, 1440), (2048.0, 1152.0)));
        // 덮개끼리 겹치지 않고 각 모니터를 정확히 덮는다
        for (a, m) in r.iter().zip(&mons) {
            assert_eq!((a.1, a.2), (m.0, m.1));
        }
        assert_eq!(cover_rects(&mons[..1]).len(), 1);
        assert!(cover_rects(&[]).is_empty());
    }
}
