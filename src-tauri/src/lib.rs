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
mod taskbar;
#[cfg(windows)]
mod watch;
#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
use stub::{clip, icons, launch, ocr, shell, taskbar, watch};
mod holidays;
mod link;
mod link_files;
mod link_layout;
mod link_sync;
mod team;
pub mod mcp; // AI 연결(MCP) — docs/mcp.md
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

/// v3: 떠 있는 턴테이블 창은 없어졌다 (LP 는 독 상자 → Island). 독에서 LP 를 끄는 동안 위치를 Island 창에 전달한다.
/// phase = start | move | end, (x, y) = 화면 좌표(논리 px), Island 가 자기 플래터 위인지 판단하고 end 에서 놓기 처리.
#[tauri::command]
fn lp_drag(app: AppHandle, phase: String, x: f64, y: f64, record_id: String) -> Result<(), String> {
    app.emit_to("island", "lp-drag", serde_json::json!({ "phase": phase, "x": x, "y": y, "recordId": record_id })).map_err(|e| e.to_string())
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
    open_ascii_scene(app, saver, from, None)
}

/// scene = xmas|city|autumn|calm (없으면 계절·시간대 자동) — 아스키 창이 ?scene= 으로 받는다
pub(crate) fn open_ascii_scene(app: &AppHandle, saver: bool, from: Option<[f64; 4]>, scene: Option<&str>) -> tauri::Result<()> {
    if app.get_webview_window("ascii").is_some() {
        return Ok(());
    }
    let Some(m) = app.primary_monitor()? else { return Ok(()) };
    let (pos, size, s) = (*m.position(), *m.size(), m.scale_factor());
    let q = from.map(|f| format!("&from={},{},{},{}", f[0], f[1], f[2], f[3])).unwrap_or_default() + &scene.map(|s| format!("&scene={s}")).unwrap_or_default();
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
    for l in ["dock", "island"] {
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

/* ── v3 메모 창: 모니터마다 투명 오버레이 1개, 보일 메모가 있을 때만 (없으면 600ms 뒤 파괴 — 접힘 애니메이션 시간) ── */
const NOTE_WINS: [&str; 4] = ["notes0", "notes1", "notes2", "notes3"];
static NOTES_GEN: AtomicU32 = AtomicU32::new(0);

/// 메모 창이 필요한가: (메모 펼침 && 바탕화면 메모 있음) || 지금 앞 앱에 붙은 메모 있음.
/// store: `notes.shown`(기본 true), `note:<id>` {appId?: 레코드 id}, 레코드 `record:<id>` {target, exe?}, 앞 앱 키 = watch 실행 키(소문자 exe / shell:appsfolder\aumid)
pub(crate) fn notes_needed(entries: &[(String, serde_json::Value)], shown: bool, fg_keys: &[String]) -> bool {
    let rec_key = |id: &str| {
        entries.iter().find(|(k, _)| k == &format!("record:{id}")).map(|(_, v)| v["exe"].as_str().or(v["target"].as_str()).unwrap_or("").to_lowercase())
    };
    entries.iter().filter(|(k, _)| k.starts_with("note:")).any(|(_, v)| match v["appId"].as_str() {
        None | Some("") => shown,
        Some(id) => rec_key(id).is_some_and(|k| !k.is_empty() && fg_keys.contains(&k)),
    })
}

fn fg_keys() -> Vec<String> {
    let st = watch::STATE.lock().unwrap();
    st.0.as_ref().map(|f| serde_json::to_value(f).unwrap_or_default()).map_or(vec![], |f| {
        let mut k = vec![f["exePath"].as_str().unwrap_or("").to_lowercase()];
        if let Some(a) = f["aumid"].as_str().filter(|a| !a.is_empty()) {
            k.push(format!(r"shell:appsfolder\{a}").to_lowercase());
        }
        k
    })
}

/// 메모 창 맞추기 (메모·펼침 변경, 앞 앱 변경 때)
pub(crate) fn notes_sync(app: &AppHandle) {
    let Ok(s) = app.store("hera.json") else { return };
    let need = notes_needed(&s.entries(), s.get("notes.shown").and_then(|v| v.as_bool()).unwrap_or(true), &fg_keys());
    let gen = NOTES_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    if need {
        let mons = app.available_monitors().unwrap_or_default();
        for (i, m) in mons.iter().take(NOTE_WINS.len()).enumerate() {
            let label = NOTE_WINS[i];
            if app.get_webview_window(label).is_some() {
                continue;
            }
            let (pos, size, sc) = (*m.position(), *m.size(), m.scale_factor());
            // 높이 -1px: 모니터를 꽉 채운 최상위 창은 셸이 전체화면 앱으로 본다 (효과 창과 같은 이유)
            let size = PhysicalSize::new(size.width, size.height.saturating_sub(1));
            let q = format!("&mon={i}&x={}&y={}&s={sc}", pos.x, pos.y);
            match overlay(app, label, &q, (size.width as f64 / sc, size.height as f64 / sc)) {
                Ok(win) => {
                    win.on_window_event(move |e| {
                        if let WindowEvent::Destroyed = e {
                            watch::remove_overlay(label);
                        }
                    });
                    let _ = win.set_position(pos).and_then(|_| win.set_size(size)).and_then(|_| win.show());
                    for l in ["dock", "island"] {
                        if let Some(w) = app.get_webview_window(l) {
                            ui::raise(&w); // 메모는 독·아일랜드 아래
                        }
                    }
                }
                Err(e) => eprintln!("notes window: {e}"),
            }
        }
    } else {
        let h = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(600));
            if NOTES_GEN.load(Ordering::Relaxed) == gen {
                for l in NOTE_WINS {
                    if let Some(w) = h.get_webview_window(l) {
                        let _ = w.destroy();
                    }
                }
            }
        });
    }
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
    let _ = app.emit_to("dock", "shelf-add", p.clone());
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
            team_state, team_create, team_invite, team_join, team_flags, team_name, team_dial, lp_drag, snippet_paste, ocr_start, ocr_region, ocr_save, palette, close_palette, activate, power, dock_tall, clips, set_clip, ascii, fx, windows_list, win_click, win_close,
            shell_key, thumbs, taskbar_lift, link_status, link_apply, link_import, link_trust, link_pair, link_unpair, link_send, link_plan, link_ambient,
            mcp::mcp_log, mcp::mcp_info, mcp::mcp_confirm // AI 연결(MCP)
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
                        if ocr {
                            tauri::async_runtime::spawn_blocking(move || ocr_open(&h).map_err(|e| eprintln!("ocr: {e}")));
                        } else {
                            tauri::async_runtime::spawn(async move { toggle_palette(&h) });
                        }
                    })
                    .build(),
            )?;
            let _ = h.global_shortcut().register(PALETTE_HOTKEY); // 다른 앱이 선점하면 실패 → 트레이 '검색' 으로 연다
            let _ = h.global_shortcut().register(OCR_HOTKEY); // v3 화면 글자 복사 (⌘K 에도 있음)
            // v3 메모 창: 메모·펼침이 바뀌거나 앞 앱이 바뀌면 다시 판단
            {
                use tauri::Listener;
                let a = h.clone();
                h.listen_any("store://change", move |e| {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                        let k = v["key"].as_str().unwrap_or("");
                        if k.starts_with("note:") || k == "notes.shown" || k.starts_with("record:") {
                            notes_sync(&a);
                        }
                    }
                });
                let a = h.clone();
                h.listen_any("foreground", move |_| notes_sync(&a));
                notes_sync(h);
            }

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn notes_window_rule() {
        let e = |v: Vec<(&str, serde_json::Value)>| v.into_iter().map(|(k, v)| (k.to_string(), v)).collect::<Vec<_>>();
        let rec = ("record:code", json!({ "id": "code", "target": "C:\\Apps\\Code.exe" }));
        let fg = vec![r"c:\apps\code.exe".to_string()];
        // 바탕화면 메모: 펼침일 때만
        assert!(notes_needed(&e(vec![("note:a", json!({ "text": "x" }))]), true, &[]));
        assert!(!notes_needed(&e(vec![("note:a", json!({ "text": "x" }))]), false, &[]));
        // 앱 메모: 그 앱이 앞에 있을 때만 (접힘과 무관)
        let app_note = ("note:b", json!({ "appId": "code" }));
        assert!(notes_needed(&e(vec![app_note.clone(), rec.clone()]), false, &fg));
        assert!(!notes_needed(&e(vec![app_note.clone(), rec.clone()]), true, &["c:\\other.exe".to_string()]));
        // 메모 없음 → 창 없음
        assert!(!notes_needed(&e(vec![rec]), true, &fg));
    }
}
