// 떠 있는 기능 창 (`float-<기능>`, URL ?surface=float&f=<기능>) = 아일랜드 안 화면을 '떼어낸' 모양. 필요할 때 만들고 닫으면 파괴.
// 떼어내기: 먼저 숨긴 채 만들고(float_prepare) 첫 페인트가 끝나면(float_ready → 'float-ready') 아일랜드가 유령을 움직인다
//   → 다 움직이면 float_show 로 같은 자리에 보인다. 창 생성과 움직임이 겹치지 않는다 (a3 버그 2).
// 끌기: 머리줄은 OS 캡션 끌기(HTCAPTION · 이동 루프)를 쓰지 않는다 — 스냅·최대화가 끼어든다 (a3 버그 3).
//   웹뷰가 포인터를 잡고 float_drag(start|move|end) → Rust 가 커서(GetCursorPos)로 SetWindowPos. 캡슐까지 거리 → 'absorb-near',
//   캡슐 위에서 놓거나 'Island로' → 'absorb' → 아일랜드가 같은 자리에 유령을 그린 뒤 float_absorbed → 창 파괴, 유령이 캡슐로.
// 위치·크기 = store `float.<기능>` [x, y, w, h] (물리 px, 그려지는 곳 = 클라이언트 영역), '항상 위' = `float.<기능>.pin`.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_store::StoreExt;

/// (기능, 제목, 기본 크기 논리 px) = 아일랜드 안 화면 크기 + 머리줄 40
pub const FEATURES: [(&str, &str, (f64, f64)); 12] = [
    ("notes", "메모 보드", (728.0, 520.0)), // 포스트잇 3열
    ("todo", "할 일", (380.0, 460.0)),
    ("calendar", "달력", (480.0, 460.0)),
    ("chat", "채팅", (400.0, 520.0)),
    ("term", "터미널", (640.0, 340.0)),
    ("clips", "최근 복사", (380.0, 440.0)),
    ("shelf", "선반", (360.0, 380.0)),
    ("snippets", "스니펫", (380.0, 440.0)),
    ("team", "Team", (400.0, 480.0)),
    ("link", "Link", (380.0, 400.0)),
    ("ocr", "OCR", (360.0, 340.0)),
    ("lp", "LP", (452.0, 612.0)),
];
const MIN: (f64, f64) = (300.0, 220.0);

/// 떼어낸 창 크기 = 잰 내용 크기 (작게는 MIN, 크게는 기본 크기의 1.5배까지 — 내용이 그보다 길면 그때만 스크롤)
pub fn fit_size(fit: (f64, f64), base: (f64, f64)) -> (f64, f64) {
    (fit.0.clamp(MIN.0, base.0 * 1.5).round(), fit.1.clamp(MIN.1, base.1 * 1.5).round())
}

static SAVE_GEN: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);
/// 준비(첫 페인트) 끝난 창 · 보이기를 기다리는 창 (label → 물리 rect)
static READY: Mutex<Vec<String>> = Mutex::new(Vec::new());
static PENDING: Mutex<Vec<(String, Option<[i32; 4]>)>> = Mutex::new(Vec::new());
static APP: OnceLock<AppHandle> = OnceLock::new();

/// 저장된 rect 가 어느 모니터와도 64px 이상 겹치는가 (모니터를 뺐으면 버린다)
pub fn visible_on(r: [i32; 4], mons: &[[i32; 4]]) -> bool {
    mons.iter().any(|m| {
        let w = (r[0] + r[2]).min(m[0] + m[2]) - r[0].max(m[0]);
        let h = (r[1] + r[3]).min(m[1] + m[3]) - r[1].max(m[1]);
        w >= 64 && h >= 64
    })
}

/// 처음 자리 (기억한 곳이 없을 때): 캡슐 기둥 옆 (오른쪽 아래면 왼쪽으로 464 논리 px), 작업 표시줄 위 72 — 프로토타입 winTarget
pub fn default_pos(wa: [i32; 4], s: f64, size: (i32, i32), left: bool) -> (i32, i32) {
    let gap = (464.0 * s) as i32;
    let x = if left { wa[0] + gap } else { wa[0] + wa[2] - gap - size.0 };
    let m = (24.0 * s) as i32;
    (x.clamp(wa[0] + m, (wa[0] + wa[2] - m - size.0).max(wa[0] + m)), (wa[1] + wa[3] - (72.0 * s) as i32 - size.1).max(wa[1] + m))
}

/// 끌기: 커서가 창을 잡은 곳(grab = 커서 - 클라이언트 원점)을 그대로 두고 따라간다
pub fn drag_to(cursor: (i32, i32), grab: (i32, i32)) -> (i32, i32) {
    (cursor.0 - grab.0, cursor.1 - grab.1)
}

/// 커서 ↔ 캡슐 거리 (논리 px) → (자석: 가까움, 놓으면 흡수)
pub fn absorb_state(d: f64) -> (bool, bool) {
    (d < NEAR_D, d < ABSORB_D)
}
pub const NEAR_D: f64 = 160.0;
/// 놓으면 흡수되는 거리 (논리 px, 커서 ↔ 캡슐 히트 rect)
pub const ABSORB_D: f64 = 48.0;

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
/// fit = 떼어낸 화면의 잰 크기 (논리 px, 머리줄 포함) — 내용에 맞춘 창 (스크롤 없음). enter = 떼어내기 등장 (첫 그림은 들어오기 전 모양)
fn create(app: &AppHandle, f: &str, fit: Option<(f64, f64)>, enter: bool) -> tauri::Result<Option<WebviewWindow>> {
    let _ = APP.set(app.clone());
    let Some(&(f, title, size)) = FEATURES.iter().find(|x| x.0 == f) else { return Ok(None) };
    let size = fit.map_or(size, |z| fit_size(z, size));
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
    let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(format!("index.html?surface=float&f={f}{}", if enter { "&enter=1" } else { "" }).into()))
        .title(format!("Hera · {title}"))
        .inner_size(size.0, size.1)
        .min_inner_size(MIN.0, MIN.1)
        .resizable(!lp)
        .maximizable(false) // 두 번 누르기·Win+↑ 최대화 없음
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
            let sc = win.scale_factor().unwrap_or(1.0);
            let sz = if lp { win.inner_size().map_or((w, h), |s| (s.width as i32, s.height as i32)) } else if fit.is_some() { ((size.0 * sc) as i32, (size.1 * sc) as i32) } else { (w, h) };
            crate::ui::set_client_bounds(&win, x, y, sz.0, sz.1);
        }
        None => {
            if let Ok(Some(m)) = app.primary_monitor() {
                let (sc, wa) = (m.scale_factor(), *m.work_area());
                let sz = ((size.0 * sc) as i32, (size.1 * sc) as i32);
                let (x, y) = default_pos([wa.position.x, wa.position.y, wa.size.width as i32, wa.size.height as i32], sc, sz, crate::island::left(app));
                crate::ui::set_client_bounds(&win, x, y, sz.0, sz.1);
            }
        }
    }
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
    let Some(win) = create(app, f, None, false)? else { return Ok(()) };
    let _ = win.unminimize();
    win.show()?;
    let _ = app.emit("float-opened", f);
    win.set_focus()
}

fn show_at(app: &AppHandle, label: &str, r: Option<[i32; 4]>) {
    let Some(win) = app.get_webview_window(label) else { return };
    let lp = label == "float-lp";
    if let Some(r) = r {
        crate::ui::set_client_bounds(&win, r[0], r[1], if lp { win.outer_size().map_or(r[2], |s| s.width as i32) } else { r[2] }, if lp { win.outer_size().map_or(r[3], |s| s.height as i32) } else { r[3] });
    }
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

/// 떼어내기 준비: 숨긴 채 만들기 → 그려질 클라이언트 rect (물리 px). 준비되면(첫 페인트) 'float-ready'
#[tauri::command]
pub async fn float_prepare(app: AppHandle, f: String, fit: Option<[f64; 2]>) -> Result<[i32; 4], String> {
    let win = create(&app, &f, fit.map(|z| (z[0], z[1])), true).map_err(|e| e.to_string())?.ok_or(format!("unknown view {f}"))?;
    let label = win.label().to_string();
    if READY.lock().unwrap().contains(&label) {
        let _ = app.emit_to("island", "float-ready", &f);
    }
    let (p, z) = (win.inner_position().map_err(|e| e.to_string())?, win.inner_size().map_err(|e| e.to_string())?);
    Ok([p.x, p.y, z.width as i32, z.height as i32])
}

/// 떼어내기 끝: 보이기 (rect = 아일랜드 CSS rect 자리로, 없으면 준비한 자리 그대로) — 아직 그려질 준비가 안 됐으면 준비되는 순간
#[tauri::command]
pub async fn float_show(app: AppHandle, f: String, rect: Option<[f64; 4]>) -> Result<(), String> {
    if create(&app, &f, None, false).map_err(|e| e.to_string())?.is_none() {
        return Err(format!("unknown view {f}"));
    }
    let label = format!("float-{f}");
    let r = rect.map(|r| to_screen(&app, r));
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
    let _ = app.emit_to("island", "float-ready", label.trim_start_matches("float-"));
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

/* ── 머리줄 끌기 = 직접 이동 (OS 이동 루프를 쓰지 않는다) ──
   OS 캡션 끌기(HTCAPTION)는 화면 가장자리에서 Aero Snap·최대화가 먼저 잡아 흡수가 일어나지 않았다 (a3 버그 3 원인).
   phase = start | move | end | absorb('캡슐로'). 커서는 Rust 가 직접 읽는다 (DPI·모니터와 무관한 물리 px). */
static GRAB: Mutex<Vec<(String, (i32, i32))>> = Mutex::new(Vec::new());
static NEAR: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 캡슐 화면 rect (물리 px) · 배율 · 아일랜드 창 원점
fn capsule(app: &AppHandle) -> Option<([f64; 4], f64, (i32, i32))> {
    let isl = app.get_webview_window("island")?;
    let (o, s) = (isl.outer_position().ok()?, isl.scale_factor().ok()?);
    let c = *crate::watch::hit_rects("island").first()?;
    Some(([o.x as f64 + c[0], o.y as f64 + c[1], c[2], c[3]], s, (o.x, o.y)))
}

#[tauri::command]
pub fn float_drag(app: AppHandle, window: WebviewWindow, phase: String) {
    use std::sync::atomic::Ordering;
    let label = window.label().to_string();
    let cur = crate::ui::cursor();
    if phase == "start" {
        let Ok(p) = window.inner_position() else { return };
        let mut g = GRAB.lock().unwrap();
        g.retain(|(l, _)| l != &label);
        g.push((label, (cur.0 - p.x, cur.1 - p.y)));
        return;
    }
    if phase == "move" {
        let Some(grab) = GRAB.lock().unwrap().iter().find(|(l, _)| l == &label).map(|x| x.1) else { return };
        let (x, y) = drag_to(cur, grab);
        crate::ui::move_client(&window, x, y);
    }
    if label == "float-lp" || !label.starts_with("float-") {
        return; // LP 위젯은 바탕화면 소품 — 흡수하지 않는다 · 설정 창은 끌기만
    }
    let (Ok(p), Ok(z)) = (window.inner_position(), window.inner_size()) else { return };
    let Some((cap, s, o)) = capsule(&app) else { return };
    let f = label.trim_start_matches("float-").to_string();
    // 아일랜드 CSS 좌표 (흡수 유령을 같은 자리에 그린다)
    let css = [(p.x - o.0) as f64 / s, (p.y - o.1) as f64 / s, z.width as f64 / s, z.height as f64 / s];
    if phase == "absorb" {
        let _ = app.emit_to("island", "absorb", serde_json::json!({ "f": f, "rect": css }));
        return;
    }
    let d = crate::watch::rect_dist(cur.0 as f64, cur.1 as f64, cap) / s;
    let (near, absorb) = absorb_state(d);
    if phase == "end" {
        GRAB.lock().unwrap().retain(|(l, _)| l != &label);
        let was = NEAR.swap(false, Ordering::Relaxed);
        let _ = app.emit_to("island", "absorb-near", serde_json::json!({ "f": f, "d": 9999.0 }));
        if was && absorb {
            let _ = app.emit_to("island", "absorb", serde_json::json!({ "f": f, "rect": css }));
        }
        return;
    }
    if near || NEAR.load(Ordering::Relaxed) {
        let _ = app.emit_to("island", "absorb-near", serde_json::json!({ "f": f, "d": d }));
    }
    NEAR.store(near, Ordering::Relaxed);
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
    fn detached_window_fits_its_content() {
        let base = (380.0, 460.0); // 할 일 기본
        assert_eq!(fit_size((380.0, 292.4), base), (380.0, 292.0)); // 짧은 목록 = 짧은 창 (빈 공간·스크롤 없음)
        assert_eq!(fit_size((380.0, 120.0), base), (380.0, MIN.1)); // 너무 작지 않게
        assert_eq!(fit_size((380.0, 2000.0), base), (380.0, 690.0)); // 아주 긴 내용만 스크롤
    }

    #[test]
    fn drag_math() {
        // 머리줄 (30, 12) 을 잡고 끌면 창은 커서 - (30, 12)
        assert_eq!(drag_to((1000, 500), (30, 12)), (970, 488));
        // 화면 위 가장자리까지 끌어도 OS 스냅·최대화가 없으니 그대로 따라간다
        assert_eq!(drag_to((640, 3), (30, 12)), (610, -9));
        // 처음 자리: 오른쪽 아래 캡슐 기둥 옆 · 작업 표시줄 위
        let wa = [0, 0, 1920, 1032];
        assert_eq!(default_pos(wa, 1.0, (380, 460), false), (1920 - 464 - 380, 1032 - 72 - 460));
        assert_eq!(default_pos(wa, 1.0, (380, 460), true), (464, 500));
        assert_eq!(default_pos([0, 0, 800, 600], 1.0, (640, 340), false), (24, 188)); // 작은 화면: 안쪽으로
    }

    #[test]
    fn absorb_against_capsule() {
        use crate::watch::rect_dist;
        let cap = [1830.0, 964.0, 80.0, 60.0]; // 오른쪽 아래 캡슐 (화면 물리 px)
        assert_eq!(absorb_state(rect_dist(1860.0, 990.0, cap)), (true, true)); // 캡슐 위에서 놓음
        assert_eq!(absorb_state(rect_dist(1800.0, 940.0, cap)), (true, true)); // 38px 옆
        assert_eq!(absorb_state(rect_dist(1700.0, 900.0, cap)), (true, false)); // 자석만
        assert_eq!(absorb_state(rect_dist(960.0, 10.0, cap)), (false, false)); // 화면 위 (예전 노치 자리) = 아무 일 없음
    }
}
