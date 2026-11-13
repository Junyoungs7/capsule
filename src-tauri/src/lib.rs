mod icons;
mod launch;
mod watch;

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_store::StoreExt;
use std::sync::atomic::{AtomicIsize, Ordering};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsWindow, SetForegroundWindow};

// 논리 px. 창은 최대 크기 고정, 모양은 CSS clip-path/크기 프리셋 (glass.css 의 .dock/.island + 여백 8px).
const DOCK: (f64, f64) = (960.0, 178.0);
const ISLAND: (f64, f64) = (440.0, 144.0);
const PANEL: (f64, f64) = (384.0, 540.0);
// C1: 서랍을 연 최대 크기로 고정 (카드 272 + 서랍 186 + 여백), 모양은 히트 rect 로
const TURNTABLE: (f64, f64) = (288.0, 520.0);
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
    low_memory(&win)?;
    watch::add_overlay(label, win.hwnd()?.0 as isize); // 클릭 통과·전체화면 숨김 대상
    Ok(win)
}

/// B0-5: 상주 웹뷰(독/아일랜드/턴테이블/숨긴 팔레트)는 상시 저메모리 모드
fn low_memory(win: &WebviewWindow) -> tauri::Result<()> {
    win.with_webview(|wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW};
        use windows::core::Interface;
        if let Ok(w) = wv.controller().CoreWebView2().and_then(|c| c.cast::<ICoreWebView2_19>()) {
            let _ = w.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW);
        }
    })
}

/// 주 모니터 작업 영역 기준 배치 (독 = 하단 중앙, 아일랜드 = 상단 중앙). DPI/작업 영역 변경 시 재호출.
pub(crate) fn place(app: &AppHandle) {
    let Ok(Some(m)) = app.primary_monitor() else { return };
    let (s, wa) = (m.scale_factor(), *m.work_area());
    let (x, y, w, h) = (wa.position.x as f64, wa.position.y as f64, wa.size.width as f64, wa.size.height as f64);
    for (label, (lw, lh)) in [("dock", DOCK), ("island", ISLAND)] {
        let Some(win) = app.get_webview_window(label) else { continue };
        let top = if label == "island" { y } else { y + h - lh * s };
        let _ = win.set_size(PhysicalSize::new((lw * s).round() as u32, (lh * s).round() as u32));
        let _ = win.set_position(PhysicalPosition::new((x + (w - lw * s) / 2.0).round() as i32, top.round() as i32));
    }
    if let Some(win) = app.get_webview_window("panel") {
        let _ = win.set_position(PhysicalPosition::new(
            (x + w - (PANEL.0 + 24.0) * s).round() as i32,
            (y + h - (PANEL.1 + 120.0) * s).max(y).round() as i32,
        ));
    }
}

/// 패널: 없으면 생성(지연 생성), 있으면 닫기 이벤트(JS 가 닫힘 애니메이션 후 close_panel 로 파괴).
fn toggle(app: &AppHandle, tab: &str) -> tauri::Result<()> {
    if app.get_webview_window("panel").is_some() {
        return app.emit_to("panel", "panel-close", ());
    }
    let mut b = builder(app, "panel", format!("index.html?surface=panel&tab={tab}"), PANEL)
        .shadow(true) // Win11: 라운드 코너 + 그림자
        .disable_drag_drop_handler(); // B0-4: panel 은 HTML5 드롭(URL)
    if let Some(dock) = app.get_webview_window("dock") {
        b = b.parent(&dock)?; // 소유 창(owner = TOOLWINDOW 독) → Alt+Tab 에서 제외
    }
    let win = b.build()?;
    // 독의 '패널 열림' 점: 생성/파괴를 이벤트로 (localStorage 공유 대체)
    let h = app.clone();
    win.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            let _ = h.emit("panel-state", false);
        }
    });
    app.emit("panel-state", true)?;
    // B0-2: panel 만 OS 백드롭
    let _ = window_vibrancy::apply_acrylic(&win, None);
    place(app);
    win.show()?;
    win.set_focus()
}

/// C1 턴테이블: 보이기 = 창 생성(+ 레코드 올리기), 숨기기 = 창 파괴(안 쓰면 메모리 0). 상태는 store `turntable.open`.
fn set_turntable(app: &AppHandle, show: bool, play: Option<String>) -> tauri::Result<()> {
    if let Ok(s) = app.store("hera.json") {
        s.set("turntable.open", show);
    }
    match (show, app.get_webview_window("turntable")) {
        (false, Some(w)) => w.destroy(),
        (false, None) => Ok(()),
        (true, Some(_)) => play.map_or(Ok(()), |id| app.emit_to("turntable", "tt-play", id)),
        (true, None) => {
            let win = overlay(app, "turntable", &play.map(|id| format!("&play={id}")).unwrap_or_default(), TURNTABLE)?;
            // 위치: 저장된 물리 px 가 어느 모니터 안이면 그대로, 아니면 주 모니터 작업 영역 왼쪽 가운데
            let on_screen = |&(x, y): &(i32, i32)| {
                app.available_monitors().unwrap_or_default().iter().any(|m| {
                    let (p, z) = (m.position(), m.size());
                    x >= p.x && y >= p.y && x < p.x + z.width as i32 && y < p.y + z.height as i32
                })
            };
            let saved = app.store("hera.json").ok().and_then(|s| s.get("turntable.pos")).and_then(|v| serde_json::from_value(v).ok()).filter(on_screen);
            let pos = saved.or_else(|| {
                let m = app.primary_monitor().ok()??;
                let (s, wa) = (m.scale_factor(), *m.work_area());
                Some((wa.position.x + (32.0 * s) as i32, wa.position.y + ((wa.size.height as f64 - TURNTABLE.1 * s) / 2.0).max(0.0) as i32))
            });
            if let Some((x, y)) = pos {
                win.set_position(PhysicalPosition::new(x, y))?;
            }
            let h = app.clone();
            win.on_window_event(move |e| match e {
                // 드래그 이동(data-tauri-drag-region) → 위치 저장
                WindowEvent::Moved(p) => {
                    if let Ok(s) = h.store("hera.json") {
                        s.set("turntable.pos", serde_json::json!([p.x, p.y]));
                    }
                }
                WindowEvent::Destroyed => watch::remove_overlay("turntable"),
                _ => {}
            });
            win.show()
        }
    }
}

#[tauri::command]
async fn turntable(app: AppHandle, show: bool, play: Option<String>) -> Result<(), String> {
    set_turntable(&app, show, play).map_err(|e| e.to_string())
}

/// C3 팔레트: 시작 시 숨김 상태로 1회 생성해 두고 단축키마다 보이기/숨기기.
/// 결정(측정): 단축키마다 생성하면 invoke→첫 페인트 p50 240 / p95 309ms 로 150ms 초과 → 숨김 유지(+~10MB, idle 합 ≤150MB 안).
/// 열기 직전 포그라운드 창을 기억했다가 Esc 로 닫으면 돌려준다.
static PALETTE_PREV: AtomicIsize = AtomicIsize::new(0);

fn palette_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let win = builder(app, "palette", "index.html?surface=palette".into(), PALETTE).shadow(false).build()?;
    low_memory(&win)?;
    Ok(win)
}

fn toggle_palette(app: &AppHandle) -> tauri::Result<()> {
    let win = match app.get_webview_window("palette") {
        Some(w) if w.is_visible()? => return close_palette_win(app, true),
        Some(w) => w,
        None => palette_window(app)?,
    };
    PALETTE_PREV.store(unsafe { GetForegroundWindow() }.0 as isize, Ordering::Relaxed);
    if let Ok(Some(m)) = app.primary_monitor() {
        let (s, wa) = (m.scale_factor(), *m.work_area());
        let (x, w) = (wa.position.x as f64, wa.size.width as f64);
        let y = wa.position.y as f64 + wa.size.height as f64 * 0.17 - 8.0 * s;
        win.set_position(PhysicalPosition::new((x + (w - PALETTE.0 * s) / 2.0).round() as i32, y.round() as i32))?;
    }
    win.show()?;
    win.set_focus()?; // 전역 단축키(WM_HOTKEY)를 받은 직후라 전면 전환이 허용된다
    app.emit_to("palette", "palette-open", ())
}

fn close_palette_win(app: &AppHandle, restore: bool) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("palette") {
        w.hide()?;
    }
    let prev = HWND(PALETTE_PREV.load(Ordering::Relaxed) as _);
    if restore && unsafe { IsWindow(Some(prev)) }.as_bool() {
        let _ = unsafe { SetForegroundWindow(prev) };
    }
    Ok(())
}

#[tauri::command]
async fn palette(app: AppHandle) -> Result<(), String> {
    toggle_palette(&app).map_err(|e| e.to_string())
}

/// 숨기기. restore = Esc/바깥 클릭(이전 앱으로 포커스 반환). 실행·포커스 잃음은 false.
#[tauri::command]
async fn close_palette(app: AppHandle, restore: bool) -> Result<(), String> {
    close_palette_win(&app, restore).map_err(|e| e.to_string())
}

/// C1 플래터 클릭 → 레코드의 앱 창 전면 (keys = exe 경로 / shell:appsfolder\aumid, 소문자)
#[tauri::command]
async fn activate(keys: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || watch::activate(&keys)).await.map_err(|e| e.to_string())?
}

/// C4 배터리 (잔량 %, 충전 중) — 없으면 null. 변화는 watch 루프가 'power' 로 알린다.
#[tauri::command]
fn power() -> Option<(u8, bool)> {
    watch::power()
}

#[tauri::command]
async fn toggle_panel(app: AppHandle, tab: String) -> Result<(), String> {
    toggle(&app, &tab).map_err(|e| e.to_string())
}

#[tauri::command]
fn close_panel(window: WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

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
    tauri::async_runtime::spawn_blocking(move || launch::launch(&target)).await.map_err(|e| e.to_string())?
}

/// 아이콘 PNG 의 절대 경로 (JS 가 convertFileSrc → asset protocol, scope = $APPDATA/icons/**)
#[tauri::command]
async fn icon(app: AppHandle, target: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("icons");
    tauri::async_runtime::spawn_blocking(move || icons::icon(&dir, &target).map(|p| p.display().to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn start_apps() -> Result<Vec<(String, String)>, String> {
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
    tauri::async_runtime::spawn_blocking(move || launch::lnk_target(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn panel_open(app: AppHandle) -> bool {
    app.get_webview_window("panel").is_some()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if app.get_webview_window("panel").is_none() {
                let _ = toggle(app, "todo");
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            toggle_panel, close_panel, report_hit_rects, wallpaper, wallpaper_style, launch, icon, start_apps, watch_state, panel_open, alarms_ready, lnk_target,
            turntable, palette, close_palette, activate, power
        ])
        .setup(|app| {
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
            let h = app.handle();
            let dock = overlay(h, "dock", "", DOCK)?;
            let island = overlay(h, "island", "", ISLAND)?;
            place(h);
            for w in [&dock, &island] {
                let h = h.clone();
                w.on_window_event(move |e| {
                    if let WindowEvent::ScaleFactorChanged { .. } = e {
                        place(&h);
                    }
                });
                w.show()?;
            }
            watch::start(h.clone());
            palette_window(h)?;
            if s.get("turntable.open").and_then(|v| v.as_bool()).unwrap_or(false) {
                set_turntable(h, true, None)?;
            }

            // C3: 전역 단축키 → 팔레트 (창 생성은 비동기 스레드에서 — toggle_panel 과 같은 경로)
            h.plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, _, e| {
                        if e.state == ShortcutState::Pressed {
                            let h = app.clone();
                            tauri::async_runtime::spawn(async move { toggle_palette(&h) });
                        }
                    })
                    .build(),
            )?;
            let _ = h.global_shortcut().register(PALETTE_HOTKEY); // 다른 앱이 선점하면 실패 → 트레이 '검색' 으로 연다

            // 트레이: skipTaskbar 라 종료 경로가 필요. 자동 시작은 기본 꺼짐(사용자가 켤 때만).
            let auto = CheckMenuItem::with_id(app, "autostart", "로그인 시 자동 시작", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "panel", "패널 열기", true, None::<&str>)?,
                    &MenuItem::with_id(app, "palette", format!("검색 ({PALETTE_HOTKEY})"), true, None::<&str>)?,
                    &MenuItem::with_id(app, "turntable", "턴테이블 보이기/숨기기", true, None::<&str>)?,
                    &auto,
                    &MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?,
                ],
            )?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("Hera")
                .menu(&menu)
                .on_menu_event(move |app, e| match e.id().as_ref() {
                    "panel" => {
                        let _ = toggle(app, "todo");
                    }
                    "palette" | "turntable" => {
                        let (h, id) = (app.clone(), e.id().as_ref().to_string());
                        tauri::async_runtime::spawn(async move {
                            if id == "palette" {
                                toggle_palette(&h)
                            } else {
                                set_turntable(&h, h.get_webview_window("turntable").is_none(), None)
                            }
                        });
                    }
                    "autostart" => {
                        let a = app.autolaunch();
                        let _ = if a.is_enabled().unwrap_or(false) { a.disable() } else { a.enable() };
                        let _ = auto.set_checked(a.is_enabled().unwrap_or(false));
                    }
                    "quit" => {
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
        .run(tauri::generate_context!())
        .expect("error while running hera");
}
