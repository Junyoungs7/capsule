// Windows 전용 모듈 — 맥 등에서는 stub.rs 의 같은 이름 모듈(빈 구현)로 컴파일만 된다 (docs/mac-port.md)
#[cfg(windows)]
mod clip;
#[cfg(windows)]
mod icons;
#[cfg(windows)]
mod launch;
#[cfg(windows)]
mod shell;
#[cfg(windows)]
mod taskbar;
#[cfg(windows)]
mod watch;
#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
use stub::{clip, icons, launch, shell, taskbar, watch};
mod link;
mod link_files;
mod ui;

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_store::StoreExt;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};

// 논리 px. 창은 최대 크기 고정, 모양은 CSS clip-path/크기 프리셋 (glass.css 의 .dock/.island + 여백 8px).
/// 높이 = 독 178 + 위 여유 72 (자동 숨김 작업 표시줄이 올라오면 독이 창 안에서 스프링으로 그만큼 올라간다 — 창 이동 없음)
const DOCK: (f64, f64) = (960.0, 250.0);
/// 독 창 최대 폭 (실행 중 앱이 늘면 줄이 길어진다) — 작업 영역 폭으로 제한
const DOCK_MAX_W: f64 = 1600.0;
/// v2 앱 묶음 팝오버가 열린 동안 독 창을 위로 키운 높이 (팝오버 3줄 + 작업 표시줄 여유). 내용은 CSS 로 하단 고정이라 그대로.
const DOCK_TALL: f64 = 640.0;
static DOCK_IS_TALL: AtomicBool = AtomicBool::new(false);
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
    let _ = ui::low_memory(&win); // 최적화일 뿐 — 실패해도 창은 쓴다
    watch::add_overlay(label, ui::hwnd(&win)); // 클릭 통과·전체화면 숨김 대상
    Ok(win)
}

/// 주 모니터 작업 영역 기준 배치 (독 = 하단 중앙, 아일랜드 = 상단 중앙). DPI/작업 영역 변경 시 재호출.
pub(crate) fn place(app: &AppHandle) {
    let Ok(Some(m)) = app.primary_monitor() else { return };
    let (s, wa) = (m.scale_factor(), *m.work_area());
    let (x, y, w, h) = (wa.position.x as f64, wa.position.y as f64, wa.size.width as f64, wa.size.height as f64);
    let dock_h = if DOCK_IS_TALL.load(Ordering::Relaxed) { DOCK_TALL } else { DOCK.1 };
    let dock_w = DOCK_MAX_W.min(w / s);
    for (label, (lw, lh)) in [("dock", (dock_w, dock_h)), ("island", ISLAND)] {
        let Some(win) = app.get_webview_window(label) else { continue };
        let top = if label == "island" { y } else { y + h - lh * s };
        ui::set_bounds(&win, (x + (w - lw * s) / 2.0).round() as i32, top.round() as i32, (lw * s).round() as i32, (lh * s).round() as i32);
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
            // Destroyed(→ OVERLAYS 정리)를 먼저 걸고, 이후 단계가 실패하면 창을 파괴한다 (죽은 오버레이 항목이 남지 않게)
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
            let r = pos.map_or(Ok(()), |(x, y)| win.set_position(PhysicalPosition::new(x, y))).and_then(|_| win.show());
            if r.is_err() {
                let _ = win.destroy();
            }
            r
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
    ui::low_memory(&win)?;
    Ok(win)
}

fn toggle_palette(app: &AppHandle) -> tauri::Result<()> {
    let win = match app.get_webview_window("palette") {
        Some(w) if w.is_visible()? => return close_palette_win(app, true),
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
    app.emit_to("palette", "palette-open", ())
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
    tauri::async_runtime::spawn_blocking(move || launch::sta(move || watch::activate(&keys))).await.map_err(|e| e.to_string())?
}

/// C4 배터리 (잔량 %, 충전 중) — 없으면 null. 변화는 watch 루프가 'power' 로 알린다.
#[tauri::command]
fn power() -> Option<(u8, bool)> {
    watch::power()
}

/// v2 앱 묶음 팝오버: 열기 전 독 창을 위로 키우고, 닫힘 애니메이션 뒤 되돌린다 (히트 rect 는 JS 가 다시 보낸다)
#[tauri::command]
fn dock_tall(app: AppHandle, tall: bool) {
    DOCK_IS_TALL.store(tall, Ordering::Relaxed);
    place(&app);
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
    if app.get_webview_window("ascii").is_some() {
        return Ok(());
    }
    let Some(m) = app.primary_monitor()? else { return Ok(()) };
    let (pos, size, s) = (*m.position(), *m.size(), m.scale_factor());
    let q = from.map(|f| format!("&from={},{},{},{}", f[0], f[1], f[2], f[3])).unwrap_or_default();
    let win = builder(app, "ascii", format!("index.html?surface=ascii&saver={}{q}", saver as u8), (size.width as f64 / s, size.height as f64 / s))
        .shadow(false)
        .focusable(!saver)
        .disable_drag_drop_handler()
        .build()?;
    let r = win.set_position(pos).and_then(|_| win.set_size(size)).and_then(|_| win.show());
    if r.is_err() {
        let _ = win.destroy();
        return r;
    }
    if !saver {
        let _ = win.set_focus(); // 독 클릭 직후라 전면 전환 허용 → Esc 가 먹는다
    }
    Ok(())
}

#[tauri::command]
async fn ascii(app: AppHandle, from: Option<[f64; 4]>) -> Result<(), String> {
    open_ascii(&app, false, from).map_err(|e| e.to_string())
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
    win.on_window_event(|e| {
        if let WindowEvent::Destroyed = e {
            watch::remove_overlay("fx");
        }
    });
    let r = win.set_position(pos).and_then(|_| win.set_size(size)).and_then(|_| win.show());
    if r.is_err() {
        let _ = win.destroy();
        return r;
    }
    for l in ["turntable", "dock", "island"] {
        if let Some(w) = app.get_webview_window(l) {
            ui::raise(&w);
        }
    }
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

/// 수동 '지금 보기' (스위치와 무관, 전체화면 중엔 무시)
#[tauri::command]
async fn fx(app: AppHandle, kind: String) -> Result<(), String> {
    open_fx(&app, &kind).map_err(|e| e.to_string())
}

/* ── 작업 표시줄 대체 (shell.rs / taskbar.rs) ── */
#[tauri::command]
fn windows_list() -> Vec<shell::Win> {
    shell::list()
}

#[tauri::command]
async fn win_click(hwnd: isize) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || shell::click(hwnd)).await.map_err(|e| e.to_string())?
}

/// 자동 숨김 작업 표시줄이 펼쳐져 있으면 그 높이(물리 px), 아니면 0. 변화는 'taskbar-lift' 이벤트.
#[tauri::command]
fn taskbar_lift() -> i32 {
    shell::lift()
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
}

#[tauri::command]
async fn link_import(app: AppHandle) -> Result<link::Cfg, String> {
    tauri::async_runtime::spawn_blocking(move || link::import(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn link_trust(app: AppHandle, fp: String) -> Result<(), String> {
    link::trust(&app, &fp)
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

#[tauri::command]
fn win_close(hwnd: isize) -> Result<(), String> {
    shell::close(hwnd)
}

#[tauri::command]
async fn shell_key(kind: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || shell::key(&kind)).await.map_err(|e| e.to_string())?
}

/// 창 목록 팝오버의 DWM 썸네일 (호출한 창 = 독에 그린다). 빈 목록 = 모두 해제.
#[tauri::command]
fn thumbs(window: WebviewWindow, list: Vec<(isize, [f64; 4])>) -> Result<usize, String> {
    Ok(shell::thumbs(ui::hwnd(&window), list))
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
            toggle_panel, close_panel, report_hit_rects, wallpaper, wallpaper_style, launch, icon, drag_out, start_apps, watch_state, panel_open, alarms_ready, lnk_target,
            turntable, palette, close_palette, activate, power, dock_tall, clips, set_clip, ascii, fx, windows_list, win_click, win_close,
            shell_key, thumbs, taskbar_lift, link_status, link_apply, link_import, link_trust, link_pair, link_unpair, link_send
        ])
        .setup(|app| {
            // 깨진 hera.json: 스토어 플러그인은 읽기 오류를 무시하고 빈 스토어로 열어 곧 덮어쓴다 → 먼저 옆으로 치워 둔다
            let file = app.path().app_data_dir()?.join("hera.json");
            if std::fs::read(&file).is_ok_and(|b| serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&b).is_err()) {
                let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
                let bak = file.with_file_name(format!("hera.json.bak-{ts}"));
                eprintln!("hera.json 이 깨져 있어 {} 로 옮기고 새로 만든다: {:?}", bak.display(), std::fs::rename(&file, &bak));
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
            // 작업 표시줄은 건드리지 않는다. 이전 빌드가 숨긴 채 남겼다면 1회 되살림.
            taskbar::recover();
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
            clip::start(h.clone());
            shell::start(h.clone());
            // Hera Link: 기본 꺼짐. 켜져 있을 때만 엔진·파일 채널이 뜬다 (꺼져 있으면 스레드 1개가 대기만)
            link::start(h.clone());
            link::files_start(h);
            // 팔레트·턴테이블은 부가 기능 — 실패해도 시작은 계속 (팔레트는 첫 단축키 때 다시 만든다)
            if let Err(e) = palette_window(h) {
                eprintln!("palette window: {e}");
            }
            if s.get("turntable.open").and_then(|v| v.as_bool()).unwrap_or(false) {
                if let Err(e) = set_turntable(h, true, None) {
                    eprintln!("turntable window: {e}");
                }
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
            let fx_on = s.get("fx.enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            let fx_item = CheckMenuItem::with_id(app, "fx", "날씨·계절 효과", true, fx_on, None::<&str>)?;
            app.manage(watch::FxMenu(fx_item.clone()));

            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "panel", "패널 열기", true, None::<&str>)?,
                    &MenuItem::with_id(app, "palette", format!("검색 ({PALETTE_HOTKEY})"), true, None::<&str>)?,
                    &MenuItem::with_id(app, "turntable", "턴테이블 보이기/숨기기", true, None::<&str>)?,
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
