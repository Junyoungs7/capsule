// 떠 있는 기능 창 (`float-<기능>`, URL ?surface=float&f=<기능>) = 아일랜드 안 화면을 '떼어낸' 모양. 필요할 때 만들고 닫으면 파괴.
// 떼어내기: 유령이 정착하면 같은 자리(클라이언트 영역)에 숨긴 채 만들고 '첫 페인트가 끝나면' 보인다(float_show + float_ready)
//   → 아일랜드가 유령을 지운다. 만드는 동안 유령은 같은 그림으로 멈춰 있어 생성 지연이 보이지 않는다.
// 흡수: 창을 머리줄로 끌어 아일랜드에 가까이 = WM_MOVING 마다 거리 → 'absorb-near', 놓으면(WM_EXITSIZEMOVE) 'absorb'
//   → 아일랜드가 같은 자리에 유령을 그린 뒤 float_absorbed → 창을 숨기고 파괴, 유령이 노치로 빨려 들어간다. (폴링 없음)
// 위치·크기 = store `float.<기능>` [x, y, w, h] (물리 px, 그려지는 곳 = 클라이언트 영역), '항상 위' = `float.<기능>.pin`.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_store::StoreExt;

/// (기능, 제목, 기본 크기 논리 px)
pub const FEATURES: [(&str, &str, (f64, f64)); 11] = [
    ("todo", "할 일", (380.0, 520.0)),
    ("calendar", "달력", (440.0, 600.0)),
    ("chat", "채팅", (400.0, 600.0)),
    ("term", "터미널", (760.0, 460.0)),
    ("clips", "최근 복사", (380.0, 480.0)),
    ("shelf", "선반", (360.0, 380.0)),
    ("snippets", "스니펫", (380.0, 460.0)),
    ("team", "Team", (400.0, 560.0)),
    ("link", "Link", (380.0, 420.0)),
    ("ocr", "OCR", (340.0, 260.0)),
    ("lp", "LP", (340.0, 488.0)),
];
const MIN: (f64, f64) = (300.0, 220.0);

static SAVE_GEN: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);
/// 준비(첫 페인트) 끝난 창 · 보이기를 기다리는 창 (label → 물리 rect)
static READY: Mutex<Vec<String>> = Mutex::new(Vec::new());
static PENDING: Mutex<Vec<(String, [i32; 4])>> = Mutex::new(Vec::new());
static APP: OnceLock<AppHandle> = OnceLock::new();

/// 저장된 rect 가 어느 모니터와도 64px 이상 겹치는가 (모니터를 뺐으면 버린다)
pub fn visible_on(r: [i32; 4], mons: &[[i32; 4]]) -> bool {
    mons.iter().any(|m| {
        let w = (r[0] + r[2]).min(m[0] + m[2]) - r[0].max(m[0]);
        let h = (r[1] + r[3]).min(m[1] + m[3]) - r[1].max(m[1]);
        w >= 64 && h >= 64
    })
}

/// 창 rect(물리) 의 위쪽 가운데 ↔ 노치(아일랜드 창 위쪽 가운데) 거리
pub fn notch_dist(r: [i32; 4], notch: (i32, i32)) -> f64 {
    let (cx, top) = (r[0] + r[2] / 2, r[1]);
    (((cx - notch.0) as f64).powi(2) + ((top - notch.1) as f64).powi(2)).sqrt()
}

fn save_later(app: &AppHandle, w: &WebviewWindow, f: String) {
    let gen = {
        let mut g = SAVE_GEN.lock().unwrap();
        let e = g.get_or_insert_with(HashMap::new).entry(f.clone()).or_insert(0);
        *e += 1;
        *e
    };
    let (h, w) = (app.clone(), w.clone());
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        if SAVE_GEN.lock().unwrap().as_ref().and_then(|g| g.get(&f)) != Some(&gen) {
            return;
        }
        let (Ok(p), Ok(z)) = (w.inner_position(), w.inner_size()) else { return }; // 그려지는 곳(클라이언트) 기준 — 유령 자리와 같은 좌표
        if w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(false) {
            return;
        }
        if let Ok(s) = h.store("hera.json") {
            s.set(format!("float.{f}"), serde_json::json!([p.x, p.y, z.width, z.height]));
        }
    });
}

/// 숨긴 채 만들기 (있으면 그대로). 자리는 기억한 곳, 없으면 주 모니터 가운데 위쪽.
fn create(app: &AppHandle, f: &str) -> tauri::Result<Option<WebviewWindow>> {
    let _ = APP.set(app.clone());
    let Some(&(f, title, size)) = FEATURES.iter().find(|x| x.0 == f) else { return Ok(None) };
    let label = format!("float-{f}");
    if let Some(w) = app.get_webview_window(&label) {
        return Ok(Some(w));
    }
    READY.lock().unwrap().retain(|l| l != &label);
    let s = app.store("hera.json").ok();
    let saved = s.as_ref().and_then(|s| s.get(format!("float.{f}"))).and_then(|v| serde_json::from_value::<[i32; 4]>(v).ok());
    let pin = s.as_ref().and_then(|s| s.get(format!("float.{f}.pin"))).and_then(|v| v.as_bool()).unwrap_or(f == "lp");
    let mons: Vec<[i32; 4]> = app.available_monitors().unwrap_or_default().iter().map(|m| [m.position().x, m.position().y, m.size().width as i32, m.size().height as i32]).collect();
    let lp = f == "lp";
    let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(format!("index.html?surface=float&f={f}").into()))
        .title(format!("Hera · {title}"))
        .inner_size(size.0, size.1)
        .min_inner_size(MIN.0, MIN.1)
        .resizable(!lp)
        .decorations(false)
        .transparent(true)
        .shadow(!lp) // OS 그림자·둥근 모서리 (유령도 같은 모양으로 그린다). LP 는 CSS 유리 턴테이블
        .skip_taskbar(lp) // 떼어낸 창은 작업 표시줄에서 찾을 수 있게, LP 위젯만 숨김
        .always_on_top(pin)
        .visible(false);
    // 채팅 창만 네이티브 드롭(파일 경로 → 첨부), 나머지는 HTML5 드롭
    if f != "chat" {
        b = b.disable_drag_drop_handler();
    }
    let win = b.build()?;
    let _ = crate::ui::low_memory(&win);
    match saved.filter(|r| visible_on(*r, &mons)) {
        Some([x, y, w, h]) => {
            let sz = if lp { win.inner_size().map_or((w, h), |s| (s.width as i32, s.height as i32)) } else { (w, h) };
            crate::ui::set_client_bounds(&win, x, y, sz.0, sz.1);
        }
        None => {
            if let Ok(Some(m)) = app.primary_monitor() {
                let (sc, wa) = (m.scale_factor(), *m.work_area());
                let (w, h) = (size.0 * sc, size.1 * sc);
                win.set_position(PhysicalPosition::new((wa.position.x as f64 + (wa.size.width as f64 - w) / 2.0) as i32, (wa.position.y as f64 + (wa.size.height as f64 - h) / 3.0) as i32))?;
            }
        }
    }
    #[cfg(windows)]
    absorb::watch(&win);
    let (h, w2, fl) = (app.clone(), win.clone(), f.to_string());
    win.on_window_event(move |e| match e {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => save_later(&h, &w2, fl.clone()),
        WindowEvent::Destroyed => {
            let l = format!("float-{fl}");
            READY.lock().unwrap().retain(|x| x != &l);
            PENDING.lock().unwrap().retain(|(x, _)| x != &l);
            let _ = h.emit("float-closed", &fl);
            // 닫힌 웹뷰의 메모리를 남은 웹뷰(아일랜드)도 함께 줄이게 — 같은 렌더러·GPU 프로세스를 나눠 쓴다
            if let Some(i) = h.get_webview_window("island") {
                let _ = crate::ui::trim(&i);
            }
        }
        _ => {}
    });
    Ok(Some(win))
}

/// 바로 열기 (LP 위젯 · 이미 떼어낸 창 앞으로)
pub fn open(app: &AppHandle, f: &str) -> tauri::Result<()> {
    let Some(win) = create(app, f)? else { return Ok(()) };
    let _ = win.unminimize();
    win.show()?;
    let _ = app.emit("float-opened", f);
    win.set_focus()
}

fn show_at(app: &AppHandle, label: &str, r: [i32; 4]) {
    let Some(win) = app.get_webview_window(label) else { return };
    let lp = label == "float-lp";
    crate::ui::set_client_bounds(&win, r[0], r[1], if lp { win.outer_size().map_or(r[2], |s| s.width as i32) } else { r[2] }, if lp { win.outer_size().map_or(r[3], |s| s.height as i32) } else { r[3] });
    let _ = win.show();
    let _ = win.set_focus();
    let f = label.trim_start_matches("float-").to_string();
    let _ = app.emit("float-opened", &f);
    let _ = app.emit_to("island", "float-shown", &f);
}

/// 아일랜드 CSS rect (아일랜드 창 기준 논리 px) → 화면 물리 px
fn to_screen(app: &AppHandle, r: [f64; 4]) -> [i32; 4] {
    let (o, s) = app.get_webview_window("island").map_or((PhysicalPosition::new(0, 0), 1.0), |w| (w.outer_position().unwrap_or_default(), w.scale_factor().unwrap_or(1.0)));
    [o.x + (r[0] * s).round() as i32, o.y + (r[1] * s).round() as i32, (r[2] * s).round() as i32, (r[3] * s).round() as i32]
}

#[tauri::command]
pub async fn float_open(app: AppHandle, f: String) -> Result<(), String> {
    open(&app, &f).map_err(|e| e.to_string())
}

/// 떼어내기 끝: 유령 자리(아일랜드 CSS rect)에 보이기 — 아직 그려질 준비가 안 됐으면 준비되는 순간
#[tauri::command]
pub async fn float_show(app: AppHandle, f: String, rect: [f64; 4]) -> Result<(), String> {
    if create(&app, &f).map_err(|e| e.to_string())?.is_none() {
        return Err(format!("unknown view {f}"));
    }
    let label = format!("float-{f}");
    let r = to_screen(&app, rect);
    if READY.lock().unwrap().contains(&label) {
        show_at(&app, &label, r);
    } else {
        PENDING.lock().unwrap().push((label, r));
    }
    Ok(())
}

/// 떠 있는 창의 첫 페인트가 끝남 (JS 가 2 프레임 뒤 부름)
#[tauri::command]
pub fn float_ready(app: AppHandle, window: WebviewWindow) {
    let label = window.label().to_string();
    READY.lock().unwrap().push(label.clone());
    let p = {
        let mut p = PENDING.lock().unwrap();
        p.iter().position(|(l, _)| l == &label).map(|i| p.remove(i).1)
    };
    if let Some(r) = p {
        show_at(&app, &label, r);
    }
}

/// 흡수: 아일랜드가 같은 자리에 유령을 그렸다 → 창을 숨기고 파괴 (자리는 이미 저장돼 있다)
#[tauri::command]
pub fn float_absorbed(app: AppHandle, f: String) {
    if let Some(w) = app.get_webview_window(&format!("float-{f}")) {
        let _ = w.hide();
        let _ = w.destroy();
    }
}

/// ✕ · Esc: 파괴 (메모리 반환). 터미널은 셸이 Rust 쪽에서 계속 돈다 — 창만 닫힌다.
#[tauri::command]
pub fn float_close(window: WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

/// '항상 위' 핀
#[tauri::command]
pub fn float_pin(app: AppHandle, window: WebviewWindow, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())?;
    if let (Some(f), Ok(s)) = (window.label().strip_prefix("float-"), app.store("hera.json")) {
        s.set(format!("float.{f}.pin"), on);
    }
    Ok(())
}

/* ── 흡수: 창 이동을 서브클래스로 받는다 (WM_MOVING = 끄는 중 rect, WM_EXITSIZEMOVE = 놓음). 폴링 없음. ── */
#[cfg(windows)]
mod absorb {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{WM_EXITSIZEMOVE, WM_MOVING};

    static LABELS: Mutex<Vec<(isize, String)>> = Mutex::new(Vec::new());
    static NEAR: AtomicBool = AtomicBool::new(false);

    pub fn watch(win: &WebviewWindow) {
        let h = crate::ui::hwnd(win);
        LABELS.lock().unwrap().push((h, win.label().to_string()));
        unsafe {
            let _ = SetWindowSubclass(HWND(h as _), Some(proc_), 0x4E7A, 0);
        }
    }

    fn notch(app: &AppHandle) -> Option<((i32, i32), f64, [i32; 2])> {
        let w = app.get_webview_window("island")?;
        let (p, z, s) = (w.outer_position().ok()?, w.outer_size().ok()?, w.scale_factor().ok()?);
        Some(((p.x + z.width as i32 / 2, p.y), s, [p.x, p.y]))
    }

    fn report(h: HWND, r: RECT, end: bool) {
        let Some(app) = APP.get() else { return };
        let Some(label) = LABELS.lock().unwrap().iter().find(|(x, _)| *x == h.0 as isize).map(|(_, l)| l.clone()) else { return };
        if label == "float-lp" {
            return; // LP 위젯은 바탕화면 소품 — 흡수하지 않는다
        }
        let Some((n, s, o)) = notch(app) else { return };
        let rr = [r.left, r.top, r.right - r.left, r.bottom - r.top];
        let d = notch_dist(rr, n) / s; // 논리 px
        let f = label.trim_start_matches("float-").to_string();
        // 아일랜드 CSS 좌표 (흡수 유령을 같은 자리에 그린다)
        let css = [(rr[0] - o[0]) as f64 / s, (rr[1] - o[1]) as f64 / s, rr[2] as f64 / s, rr[3] as f64 / s];
        if end {
            let was = NEAR.swap(false, Ordering::Relaxed);
            let _ = app.emit_to("island", "absorb-near", serde_json::json!({ "f": f, "d": 9999.0 }));
            if was && d < 80.0 {
                let _ = app.emit_to("island", "absorb", serde_json::json!({ "f": f, "rect": css }));
            }
            return;
        }
        let near = d < 200.0;
        if near || NEAR.load(Ordering::Relaxed) {
            let _ = app.emit_to("island", "absorb-near", serde_json::json!({ "f": f, "d": d, "rect": css }));
        }
        NEAR.store(near, Ordering::Relaxed);
    }

    unsafe extern "system" fn proc_(h: HWND, m: u32, wp: WPARAM, lp: LPARAM, _: usize, _: usize) -> LRESULT {
        match m {
            WM_MOVING => report(h, *(lp.0 as *const RECT), false),
            WM_EXITSIZEMOVE => {
                // 흡수 유령은 그려지는 곳(클라이언트) 그대로 — 보이지 않는 테두리만큼 어긋나지 않게
                let (mut c, mut o) = (RECT::default(), windows::Win32::Foundation::POINT::default());
                let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(h, &mut c);
                let _ = windows::Win32::Graphics::Gdi::ClientToScreen(h, &mut o);
                report(h, RECT { left: o.x, top: o.y, right: o.x + c.right, bottom: o.y + c.bottom }, true);
            }
            0x0082 /* WM_NCDESTROY */ => LABELS.lock().unwrap().retain(|(x, _)| *x != h.0 as isize),
            _ => {}
        }
        DefSubclassProc(h, m, wp, lp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_rect_must_touch_a_monitor() {
        let mons = [[0, 0, 1920, 1080], [1920, 0, 2560, 1440]];
        assert!(visible_on([100, 100, 400, 500], &mons));
        assert!(visible_on([1900, 100, 400, 500], &mons)); // 두 모니터 걸침
        assert!(!visible_on([5000, 100, 400, 500], &mons)); // 빠진 모니터 자리
        assert!(!visible_on([-380, 100, 400, 500], &mons)); // 20px 만 걸침
        assert!(visible_on([-336, 100, 400, 500], &mons)); // 64px 걸침
    }

    #[test]
    fn absorb_distance_from_notch() {
        assert_eq!(notch_dist([760, 0, 400, 300], (960, 0)), 0.0); // 창 위쪽 가운데가 노치에
        assert!((notch_dist([760, 60, 400, 300], (960, 0)) - 60.0).abs() < 1e-9);
        assert!(notch_dist([100, 400, 400, 300], (960, 0)) > 200.0);
    }
}
