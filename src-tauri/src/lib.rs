mod watch;

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

// 논리 px. 창은 최대 크기 고정, 모양은 CSS clip-path/크기 프리셋 (glass.css 의 .dock/.island + 여백 8px).
const DOCK: (f64, f64) = (960.0, 178.0);
const ISLAND: (f64, f64) = (440.0, 144.0);
const PANEL: (f64, f64) = (384.0, 540.0);

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

fn overlay(app: &AppHandle, label: &str, size: (f64, f64)) -> tauri::Result<WebviewWindow> {
    let win = builder(app, label, format!("index.html?surface={label}"), size)
        .shadow(false)
        .focusable(false) // tao: WS_EX_NOACTIVATE (TOOLWINDOW 은 watch 루프가 유지)
        .build()?;
    // B0-5: 독/아일랜드는 상시 저메모리 모드
    win.with_webview(|wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW};
        use windows::core::Interface;
        if let Ok(w) = wv.controller().CoreWebView2().and_then(|c| c.cast::<ICoreWebView2_19>()) {
            let _ = w.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW);
        }
    })?;
    Ok(win)
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
    let mut b = builder(app, "panel", format!("index.html?surface=panel&tab={tab}"), PANEL).shadow(true); // Win11: 라운드 코너 + 그림자
    if let Some(dock) = app.get_webview_window("dock") {
        b = b.parent(&dock)?; // 소유 창(owner = TOOLWINDOW 독) → Alt+Tab 에서 제외
    }
    let win = b.build()?;
    // B0-2: panel 만 OS 백드롭
    let _ = window_vibrancy::apply_acrylic(&win, None);
    place(app);
    win.show()?;
    win.set_focus()
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if app.get_webview_window("panel").is_none() {
                let _ = toggle(app, "todo");
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![toggle_panel, close_panel, report_hit_rects, wallpaper, wallpaper_style])
        .setup(|app| {
            let h = app.handle();
            let dock = overlay(h, "dock", DOCK)?;
            let island = overlay(h, "island", ISLAND)?;
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
            watch::start(h.clone(), vec![("dock", dock.hwnd()?.0 as isize), ("island", island.hwnd()?.0 as isize)]);

            // 트레이: skipTaskbar 라 종료 경로가 필요. 자동 시작은 기본 꺼짐(사용자가 켤 때만).
            let auto = CheckMenuItem::with_id(app, "autostart", "로그인 시 자동 시작", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "panel", "패널 열기", true, None::<&str>)?,
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
                    "autostart" => {
                        let a = app.autolaunch();
                        let _ = if a.is_enabled().unwrap_or(false) { a.disable() } else { a.enable() };
                        let _ = auto.set_checked(a.is_enabled().unwrap_or(false));
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running hera");
}
