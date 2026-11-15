// 떠 있는 기능 창 (`float-<기능>`, URL ?surface=float&f=<기능>): 필요할 때 만들고 닫으면 파괴 → 평소 메모리 0.
// 위치·크기 = store `float.<기능>` [x, y, w, h] (물리 px, 옮기거나 키운 뒤 400ms 디바운스 저장), '항상 위' = `float.<기능>.pin`.
use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_store::StoreExt;

/// (기능, 제목, 기본 크기 논리 px)
pub const FEATURES: [(&str, &str, (f64, f64)); 7] = [
    ("todo", "할 일", (380.0, 520.0)),
    ("calendar", "달력", (420.0, 620.0)),
    ("chat", "채팅", (400.0, 600.0)),
    ("term", "터미널", (760.0, 480.0)),
    ("clips", "최근 복사", (380.0, 480.0)),
    ("shelf", "선반", (360.0, 380.0)),
    ("lp", "LP", (340.0, 488.0)),
];
const MIN: (f64, f64) = (300.0, 260.0);

static SAVE_GEN: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

/// 저장된 rect 가 어느 모니터와도 64px 이상 겹치는가 (모니터를 뺐으면 버린다)
pub fn visible_on(r: [i32; 4], mons: &[[i32; 4]]) -> bool {
    mons.iter().any(|m| {
        let w = (r[0] + r[2]).min(m[0] + m[2]) - r[0].max(m[0]);
        let h = (r[1] + r[3]).min(m[1] + m[3]) - r[1].max(m[1]);
        w >= 64 && h >= 64
    })
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
        let (Ok(p), Ok(z)) = (w.outer_position(), w.inner_size()) else { return };
        if w.is_minimized().unwrap_or(false) {
            return;
        }
        if let Ok(s) = h.store("hera.json") {
            s.set(format!("float.{f}"), serde_json::json!([p.x, p.y, z.width, z.height]));
        }
    });
}

/// 열기 (있으면 앞으로). 위치는 기억한 곳, 없으면 커서 모니터 가운데.
pub fn open(app: &AppHandle, f: &str) -> tauri::Result<()> {
    let Some(&(f, title, size)) = FEATURES.iter().find(|x| x.0 == f) else { return Ok(()) };
    let label = format!("float-{f}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        w.show()?;
        return w.set_focus();
    }
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
        .shadow(!lp) // LP 플레이어는 CSS 로 그린 유리 턴테이블 (창 그림자 없음)
        .skip_taskbar(lp) // 기능 창은 작업 표시줄에서 찾을 수 있게, LP 위젯만 숨김
        .always_on_top(pin)
        .visible(false);
    // 채팅 창만 네이티브 드롭(파일 경로 → 첨부), 나머지는 HTML5 드롭
    if f != "chat" {
        b = b.disable_drag_drop_handler();
    }
    let win = b.build()?;
    if !lp {
        let _ = window_vibrancy::apply_acrylic(&win, None);
    }
    let _ = crate::ui::low_memory(&win);
    match saved.filter(|r| visible_on(*r, &mons)) {
        Some([x, y, w, h]) => {
            win.set_position(PhysicalPosition::new(x, y))?;
            if !lp {
                win.set_size(PhysicalSize::new(w as u32, h as u32))?;
            }
        }
        None => {
            if let Ok(Some(m)) = app.primary_monitor() {
                let (sc, wa) = (m.scale_factor(), *m.work_area());
                let (w, h) = (size.0 * sc, size.1 * sc);
                win.set_position(PhysicalPosition::new((wa.position.x as f64 + (wa.size.width as f64 - w) / 2.0) as i32, (wa.position.y as f64 + (wa.size.height as f64 - h) / 3.0) as i32))?;
            }
        }
    }
    let (h, w2, fl) = (app.clone(), win.clone(), f.to_string());
    win.on_window_event(move |e| match e {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => save_later(&h, &w2, fl.clone()),
        WindowEvent::Destroyed => {
            let _ = h.emit("float-closed", &fl);
        }
        _ => {}
    });
    win.show()?;
    win.set_focus()?;
    let _ = app.emit("float-opened", f);
    Ok(())
}

#[tauri::command]
pub async fn float_open(app: AppHandle, f: String) -> Result<(), String> {
    open(&app, &f).map_err(|e| e.to_string())
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
}
