// 트레이 아이콘 + 패널(Win11 빠른 설정 자리) + 알림 카드.
// - 패널 `panel`: 시작할 때 숨긴 채 만들어 둔다 (웹뷰 하나 — 누르는 즉시 뜨게. 새로 만들면 첫 표시가 0.5초 넘게 걸린다).
//   트레이 왼쪽 클릭 = 열기/닫기, 작업 표시줄이 있는 모니터의 작업 영역 모서리(트레이 쪽)에 붙는다. 포커스를 잃거나 Esc = 숨김.
// - 알림 카드 `toast`: 그때만 만들고 사라지면 파괴 (평소 메모리 0). 오른쪽 아래, 작업 표시줄 위 — 패널이 열려 있으면 그 위.
// - 맥이 연결되면 트레이 아이콘에 초록 점.
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::image::Image;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

pub const PANEL_W: f64 = 368.0;
const TOAST: (f64, f64) = (364.0, 72.0);
const GAP: f64 = 12.0;

/// 패널 높이 (논리 px, JS 가 내용을 재서 알려 준다)
static PANEL_H: AtomicU32 = AtomicU32::new(520);
/// 패널을 연 자리 (트레이 아이콘 · 펫, 물리 px) — 모니터와 붙을 모서리를 정한다
static ANCHOR: Mutex<Option<(f64, f64)>> = Mutex::new(None);
/// 포커스를 잃어 숨긴 때 — 그 클릭이 트레이 아이콘이면 다시 열지 않는다 (닫기 클릭)
static HIDDEN_AT: Mutex<Option<Instant>> = Mutex::new(None);
static TOAST_NEXT: Mutex<Option<Value>> = Mutex::new(None);
static CONNECTED: AtomicBool = AtomicBool::new(false);

/// 작업 영역 [x, y, w, h] · 배율 · 연 자리 · 크기(논리) → 창 [x, y, w, h] (물리 px).
/// 연 자리가 있는 쪽 모서리에 붙는다: 작업 표시줄이 아래·오른쪽이면 오른쪽 아래, 위면 위, 왼쪽이면 왼쪽.
pub fn panel_rect(wa: [i32; 4], s: f64, at: (f64, f64), size: (f64, f64)) -> [i32; 4] {
    let (w, h) = ((size.0 * s).round() as i32, ((size.1 * s).round() as i32).min(wa[3] - (2.0 * GAP * s) as i32));
    let g = (GAP * s).round() as i32;
    let right = at.0 >= wa[0] as f64 + wa[2] as f64 / 2.0;
    let bottom = at.1 >= wa[1] as f64 + wa[3] as f64 / 2.0;
    let x = if right { wa[0] + wa[2] - g - w } else { wa[0] + g };
    let y = if bottom { wa[1] + wa[3] - g - h } else { wa[1] + g };
    [x, y, w, h]
}

/// 알림 카드: 작업 영역 오른쪽 아래. 패널이 같은 자리(아래쪽)에 열려 있으면 그 위로.
pub fn toast_rect(wa: [i32; 4], s: f64, panel: Option<[i32; 4]>) -> [i32; 4] {
    let (w, h, g) = ((TOAST.0 * s).round() as i32, (TOAST.1 * s).round() as i32, (GAP * s).round() as i32);
    let x = wa[0] + wa[2] - g - w;
    let bottom = panel.filter(|p| p[1] + p[3] / 2 > wa[1] + wa[3] / 2 && p[0] + p[2] > x).map_or(wa[1] + wa[3] - g, |p| p[1] - g);
    [x, bottom - h, w, h]
}

/// 트레이 아이콘에 초록 점 (오른쪽 아래, 테두리는 투명하게 파서 어떤 작업 표시줄 색에도 보이게)
pub fn dot_rgba(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut px = rgba.to_vec();
    let (cx, cy, r) = (w as f64 * 0.76, h as f64 * 0.76, w as f64 * 0.2);
    let ring = r + w as f64 * 0.07;
    for y in 0..h {
        for x in 0..w {
            let d = ((x as f64 + 0.5 - cx).powi(2) + (y as f64 + 0.5 - cy).powi(2)).sqrt();
            let i = ((y * w + x) * 4) as usize;
            if d <= r {
                px[i..i + 4].copy_from_slice(&[0x6c, 0xcb, 0x5f, 0xff]);
            } else if d <= ring {
                px[i + 3] = 0;
            }
        }
    }
    px
}

/// 엔진 상태가 바뀔 때 (link.rs) — 연결됨이 바뀐 때만 아이콘을 바꾼다
pub fn set_connected(app: &AppHandle, on: bool) {
    if CONNECTED.swap(on, Ordering::Relaxed) == on {
        return;
    }
    let (Some(t), Some(base)) = (app.tray_by_id("main"), app.default_window_icon()) else { return };
    let icon = if on { Image::new_owned(dot_rgba(base.rgba(), base.width(), base.height()), base.width(), base.height()) } else { base.clone().to_owned() };
    let _ = t.set_icon(Some(icon));
    let _ = t.set_tooltip(Some(if on { "Hera · 맥 연결됨" } else { "Hera" }));
}

/// 그 점의 모니터 작업 영역 [x, y, w, h] 과 배율 (없으면 주 모니터)
fn work_area(app: &AppHandle, at: Option<(f64, f64)>) -> Option<([i32; 4], f64)> {
    let m = at.and_then(|(x, y)| app.monitor_from_point(x, y).ok().flatten()).or_else(|| app.primary_monitor().ok().flatten())?;
    let wa = m.work_area();
    Some(([wa.position.x, wa.position.y, wa.size.width as i32, wa.size.height as i32], m.scale_factor()))
}

pub fn create_panel(app: &AppHandle) -> tauri::Result<()> {
    let win = WebviewWindowBuilder::new(app, "panel", WebviewUrl::App("index.html?surface=panel".into()))
        .inner_size(PANEL_W, PANEL_H.load(Ordering::Relaxed) as f64)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true) // Win11: 둥근 모서리 + 그림자
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .title("Hera")
        .build()?;
    let _ = crate::ui::low_memory(&win);
    let h = app.clone();
    win.on_window_event(move |e| {
        if let WindowEvent::Focused(false) = e {
            hide(&h);
        }
    });
    Ok(())
}

fn place_panel(app: &AppHandle, win: &WebviewWindow) {
    let at = *ANCHOR.lock().unwrap();
    let Some((wa, s)) = work_area(app, at) else { return };
    let at = at.unwrap_or(((wa[0] + wa[2]) as f64, (wa[1] + wa[3]) as f64));
    let r = panel_rect(wa, s, at, (PANEL_W, PANEL_H.load(Ordering::Relaxed) as f64));
    crate::ui::set_bounds(win, r[0], r[1], r[2], r[3]);
}

/// 열기/닫기. at = 누른 자리 (트레이 아이콘 · 펫, 물리 px)
pub fn toggle(app: &AppHandle, at: Option<(f64, f64)>, view: &str) {
    let Some(win) = app.get_webview_window("panel") else { return };
    if win.is_visible().unwrap_or(false) {
        return hide(app);
    }
    if HIDDEN_AT.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(300)) {
        return; // 방금 이 클릭으로 포커스를 잃어 닫혔다
    }
    show(app, at, view);
}

/// view = "main" (트레이) | "fx" (펫: 효과 메뉴)
pub fn show(app: &AppHandle, at: Option<(f64, f64)>, view: &str) {
    let Some(win) = app.get_webview_window("panel") else { return };
    if at.is_some() {
        *ANCHOR.lock().unwrap() = at;
    }
    place_panel(app, &win);
    let _ = app.emit_to("panel", "panel-show", view);
    let _ = win.show();
    let _ = win.set_focus();
}

pub fn hide(app: &AppHandle) {
    let Some(win) = app.get_webview_window("panel") else { return };
    if win.is_visible().unwrap_or(false) {
        *HIDDEN_AT.lock().unwrap() = Some(Instant::now());
        let _ = win.hide();
        let _ = app.emit_to("panel", "panel-hide", ());
    }
}

/// 열린 패널 rect (알림 카드를 그 위에 놓으려고)
fn panel_open(app: &AppHandle) -> Option<[i32; 4]> {
    let w = app.get_webview_window("panel").filter(|w| w.is_visible().unwrap_or(false))?;
    let (p, z) = (w.outer_position().ok()?, w.outer_size().ok()?);
    Some([p.x, p.y, z.width as i32, z.height as i32])
}

/// 알림 카드 1장 (kind = recv | sent | fail | link | pair). 전체화면 앱 중엔 띄우지 않는다.
pub fn toast(app: &AppHandle, kind: &str, title: &str, sub: &str) {
    if crate::watch::FULLSCREEN.load(Ordering::Relaxed) {
        return;
    }
    let v = json!({ "kind": kind, "title": title, "sub": sub });
    *TOAST_NEXT.lock().unwrap() = Some(v.clone());
    let h = app.clone();
    // 창 만들기는 메인 스레드 밖에서 (이벤트 콜백 안에서 불릴 수 있다)
    tauri::async_runtime::spawn(async move {
        let win = match h.get_webview_window("toast") {
            Some(w) => {
                let _ = h.emit_to("toast", "toast", v);
                w
            }
            None => {
                let Ok(w) = WebviewWindowBuilder::new(&h, "toast", WebviewUrl::App("index.html?surface=toast".into()))
                    .inner_size(TOAST.0, TOAST.1)
                    .resizable(false)
                    .decorations(false)
                    .transparent(true)
                    .shadow(true)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .focusable(false) // 포커스를 뺏지 않는다 (누르기는 된다)
                    .visible(false)
                    .title("Hera")
                    .build()
                else {
                    return;
                };
                let _ = crate::ui::low_memory(&w);
                w
            }
        };
        let Some((wa, s)) = work_area(&h, None) else { return };
        let r = toast_rect(wa, s, panel_open(&h));
        crate::ui::set_bounds(&win, r[0], r[1], r[2], r[3]);
        let _ = win.show();
    });
}

/// 알림 카드가 처음 그릴 내용 (만드는 동안 온 것 중 마지막)
#[tauri::command]
pub fn toast_next() -> Option<Value> {
    TOAST_NEXT.lock().unwrap().take()
}

/// 사라짐 애니메이션 끝 → 파괴 (메모리 반환)
#[tauri::command]
pub fn toast_done(app: AppHandle) {
    if let Some(w) = app.get_webview_window("toast") {
        let _ = w.destroy();
    }
}

/// 알림 카드 누름 → 패널 (페어링 숫자 확인 등)
#[tauri::command]
pub fn toast_click(app: AppHandle) {
    toast_done(app.clone());
    show(&app, None, "main");
}

/// 패널 내용 높이가 바뀜 (논리 px) — 열려 있으면 같은 모서리에 붙인 채 크기만
#[tauri::command]
pub fn panel_fit(app: AppHandle, h: f64) {
    PANEL_H.store(h.clamp(120.0, 900.0).round() as u32, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window("panel") {
        place_panel(&app, &w);
    }
}

#[tauri::command]
pub fn panel_hide(app: AppHandle) {
    hide(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 작업 표시줄이 아래 · 위 · 왼쪽 · 오른쪽, 배율 1 · 1.5 — 패널은 늘 작업 영역 안, 트레이 쪽 모서리에서 12 논리 px
    #[test]
    fn panel_sits_at_the_tray_corner() {
        let size = (PANEL_W, 520.0);
        // 아래 (1920×1080, 작업 표시줄 48) — 트레이 = 오른쪽 아래
        let wa = [0, 0, 1920, 1032];
        assert_eq!(panel_rect(wa, 1.0, (1880.0, 1056.0), size), [1920 - 12 - 368, 1032 - 12 - 520, 368, 520]);
        // 위 작업 표시줄 — 트레이 = 오른쪽 위
        let wa = [0, 48, 1920, 1032];
        assert_eq!(panel_rect(wa, 1.0, (1880.0, 24.0), size), [1540, 60, 368, 520]);
        // 왼쪽 세로 작업 표시줄 — 트레이 = 왼쪽 아래
        let wa = [62, 0, 1858, 1080];
        assert_eq!(panel_rect(wa, 1.0, (30.0, 1040.0), size), [74, 1080 - 12 - 520, 368, 520]);
        // 오른쪽 세로 — 트레이 = 오른쪽 아래
        let wa = [0, 0, 1858, 1080];
        assert_eq!(panel_rect(wa, 1.0, (1890.0, 1040.0), size)[0], 1858 - 12 - 368);
        // 4K 150% · 보조 모니터(음수 원점)
        let wa = [-3840, 0, 3840, 2088];
        let r = panel_rect(wa, 1.5, (-40.0, 2120.0), size);
        assert_eq!(r, [-18 - 552, 2088 - 18 - 780, 552, 780]);
        // 작은 화면: 높이는 작업 영역 안으로
        let r = panel_rect([0, 0, 1280, 600], 1.0, (1270.0, 590.0), (PANEL_W, 900.0));
        assert!(r[1] >= 0 && r[3] <= 600 - 24, "{r:?}");
    }

    #[test]
    fn toast_goes_above_an_open_panel() {
        let wa = [0, 0, 1920, 1032];
        let t = toast_rect(wa, 1.0, None);
        assert_eq!(t, [1920 - 12 - 364, 1032 - 12 - 72, 364, 72]);
        let panel = panel_rect(wa, 1.0, (1880.0, 1056.0), (PANEL_W, 520.0));
        let t = toast_rect(wa, 1.0, Some(panel));
        assert_eq!(t[1] + t[3], panel[1] - 12, "패널 바로 위");
        // 위쪽에 붙은 패널은 비켜 갈 필요 없다
        let top = panel_rect([0, 48, 1920, 1032], 1.0, (1880.0, 24.0), (PANEL_W, 520.0));
        assert_eq!(toast_rect([0, 48, 1920, 1032], 1.0, Some(top))[1], 48 + 1032 - 12 - 72);
        assert_eq!(toast_rect(wa, 1.5, None), [1920 - 18 - 546, 1032 - 18 - 108, 546, 108]);
    }

    #[test]
    fn green_dot_on_the_icon() {
        let (w, h) = (32u32, 32u32);
        let base = vec![200u8; (w * h * 4) as usize];
        let px = dot_rgba(&base, w, h);
        let at = |x: u32, y: u32| &px[((y * w + x) * 4) as usize..((y * w + x) * 4 + 4) as usize];
        assert_eq!(at(24, 24), [0x6c, 0xcb, 0x5f, 0xff]); // 점 가운데
        assert_eq!(at(4, 4), [200, 200, 200, 200]); // 아이콘 나머지는 그대로
        assert_eq!(at(24, 16)[3], 0); // 점 둘레는 투명
    }
}
