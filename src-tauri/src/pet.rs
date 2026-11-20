// 펫 (항상 있음 — 꾸미기와 상관없이). 기본 자리 = 주 모니터 오른쪽 아래, 작업 표시줄 위, 트레이 패널 자리 바로 왼쪽
// (패널이 덮지 않고, 오른쪽 끝 포탈과 겹치지 않게). 끌어서 어디든 옮기면 그 자리를 기억한다 (store `pet.pos` = [x, y] 물리 px).
// 창은 투명 · 클릭 통과, 펫 모양(히트 rect)만 누를 수 있다: 누르기 = 패널, 오른쪽 클릭 = 펫 메뉴(패널 fx), 끌기 = 옮기기.
// 이미지는 기본 펫 또는 내 이미지 (store `pet.kind` = "custom", 파일 = %APPDATA%\dev.hera.dock\pet\custom.<ext>). 전체화면 앱 중에는 숨김.
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::UI::WindowsAndMessaging::*;

/// 펫 창 (논리 px, 정사각형)
pub const SIZE: f64 = 84.0;
const MAX_IMG: usize = 8 << 20;
pub const IMG_EXT: [&str; 5] = ["png", "gif", "webp", "jpg", "jpeg"];
static HWND_PET: AtomicIsize = AtomicIsize::new(0);
static SHOWN: AtomicBool = AtomicBool::new(false);
static DRAGGING: AtomicBool = AtomicBool::new(false);
/// 옮겨 둔 자리 (왼쪽 위, 물리 px). None = 기본 자리
static POS: Mutex<Option<(i32, i32)>> = Mutex::new(None);
/// 마지막으로 놓은 rect — 같으면 옮기지 않는다
static LAST: Mutex<Option<[i32; 4]>> = Mutex::new(None);

/// 작업 영역 [l, t, r, b] · 배율 → 기본 자리 [x, y, w, h]: 오른쪽 아래, 패널(PANEL_W) 자리 바로 왼쪽
pub fn home_rect(wa: [i32; 4], s: f64) -> [i32; 4] {
    let w = (SIZE * s).round() as i32;
    let gap = (12.0 * s).round() as i32;
    let panel = ((crate::tray::PANEL_W + 20.0) * s).round() as i32;
    [wa[2] - gap - panel - w, wa[3] - gap - w, w, w]
}

/// 옮겨 둔 자리를 가장 가까운 작업 영역 안으로 (화면 밖으로 끌었거나 그 모니터를 뺐을 때). 작업 영역이 없으면 None → 기본 자리
pub fn fit(pos: (i32, i32), w: i32, works: &[[i32; 4]]) -> Option<(i32, i32)> {
    let c = (pos.0 + w / 2, pos.1 + w / 2);
    let off = |a: &[i32; 4]| (c.0 - c.0.max(a[0]).min(a[2])).abs() + (c.1 - c.1.max(a[1]).min(a[3])).abs();
    let wa = works.iter().min_by_key(|a| off(a))?;
    Some((pos.0.max(wa[0]).min(wa[2] - w), pos.1.max(wa[1]).min(wa[3] - w)))
}

/// 모든 모니터의 작업 영역 [l, t, r, b]
fn works() -> Vec<[i32; 4]> {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONULL};
    crate::watch::monitors()
        .into_iter()
        .filter_map(|(_, m, _, _)| unsafe {
            let h = MonitorFromPoint(POINT { x: (m[0] + m[2] / 2.0) as i32, y: (m[1] + m[3] / 2.0) as i32 }, MONITOR_DEFAULTTONULL);
            let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            GetMonitorInfoW(h, &mut mi).as_bool().then_some([mi.rcWork.left, mi.rcWork.top, mi.rcWork.right, mi.rcWork.bottom])
        })
        .collect()
}

/// 주 모니터 작업 영역 · 배율
fn primary_work() -> ([i32; 4], f64) {
    let mut r = RECT::default();
    let ok = unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, Some(&mut r as *mut _ as _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)) }.is_ok();
    let wa = if ok { [r.left, r.top, r.right, r.bottom] } else { [0, 0, 1920, 1032] };
    (wa, crate::watch::scale_at(wa[2] - 1, wa[3] - 1))
}

fn rect_now() -> [i32; 4] {
    let (wa, s) = primary_work();
    let home = home_rect(wa, s);
    let Some(p) = *POS.lock().unwrap() else { return home };
    let w = (SIZE * crate::watch::scale_at(p.0, p.1)).round() as i32;
    fit(p, w, &works()).map_or(home, |q| [q.0, q.1, w, w])
}

/// 시작 때 한 번: 펫 창을 만든다
pub fn sync(app: &AppHandle) {
    if app.get_webview_window("pet").is_some() {
        return;
    }
    let pos = app.store("hera.json").ok().and_then(|s| s.get("pet.pos")).and_then(|v| Some((v[0].as_i64()? as i32, v[1].as_i64()? as i32)));
    *POS.lock().unwrap() = pos;
    let Ok(win) = crate::overlay(app, "pet", "", (SIZE, SIZE)) else { return };
    HWND_PET.store(crate::ui::hwnd(&win), Ordering::Relaxed);
    *LAST.lock().unwrap() = None;
    SHOWN.store(false, Ordering::Relaxed);
}

/// watch 루프 (약 0.3초마다): 자리 (바뀐 때만) · 전체화면이면 숨김 · 맨 위 유지
pub fn tick(full: bool) {
    let h = HWND_PET.load(Ordering::Relaxed);
    if h == 0 || DRAGGING.load(Ordering::Relaxed) {
        return;
    }
    let hwnd = HWND(h as _);
    unsafe {
        let r = rect_now();
        if !full && *LAST.lock().unwrap() != Some(r) {
            *LAST.lock().unwrap() = Some(r);
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), r[0], r[1], r[2], r[3], SWP_NOACTIVATE);
        }
        if SHOWN.swap(!full, Ordering::Relaxed) == full {
            let _ = ShowWindow(hwnd, if full { SW_HIDE } else { SW_SHOWNOACTIVATE });
        }
        // 다른 최상위 창이 올라와도 다시 위로 (SWP_NOMOVE, 바뀐 것 없으면 싸다)
        if !full {
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

/// 펫 창 rect [l, t, r, b] (물리 px, 보일 때만) — 패널 자리 · 펼치기(drag.rs)
pub fn rect() -> Option<[i32; 4]> {
    let h = HWND(HWND_PET.load(Ordering::Relaxed) as _);
    if h.0.is_null() || !SHOWN.load(Ordering::Relaxed) {
        return None;
    }
    let mut r = RECT::default();
    unsafe { GetWindowRect(h, &mut r) }.ok()?;
    Some([r.left, r.top, r.right, r.bottom])
}

/// 누르기 → 패널 (view = "main"), 오른쪽 클릭 → 펫 메뉴 (view = "fx")
#[tauri::command]
pub fn pet_click(app: AppHandle, view: Option<String>) {
    let at = rect().map(|r| (((r[0] + r[2]) / 2) as f64, ((r[1] + r[3]) / 2) as f64));
    crate::tray::toggle(&app, at, view.as_deref().unwrap_or("main"));
}

/// 끌어서 옮기기: 단추를 뗄 때까지 커서를 따라간다 (JS 는 6px 넘게 끌면 부른다). 다 옮기면 그 모니터 작업 영역 안으로 맞추고 기억.
#[tauri::command]
pub fn pet_drag(app: AppHandle) {
    let h = HWND_PET.load(Ordering::Relaxed);
    if h == 0 || DRAGGING.swap(true, Ordering::Relaxed) {
        return;
    }
    std::thread::spawn(move || {
        let hwnd = HWND(h as _);
        let (mut r, mut p0) = (RECT::default(), POINT::default());
        unsafe {
            let _ = GetWindowRect(hwnd, &mut r);
            let _ = GetCursorPos(&mut p0);
        }
        let mut at = (r.left, r.top);
        while crate::watch::left_down() {
            let mut p = POINT::default();
            if unsafe { GetCursorPos(&mut p) }.is_ok() {
                at = (r.left + p.x - p0.x, r.top + p.y - p0.y);
                unsafe {
                    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), at.0, at.1, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
                }
            }
            std::thread::sleep(Duration::from_millis(8));
        }
        let at = fit(at, r.right - r.left, &works()).unwrap_or(at);
        *POS.lock().unwrap() = Some(at);
        *LAST.lock().unwrap() = None; // 다음 tick 이 맞춘 자리로 (배율이 다른 모니터면 크기도)
        if let Ok(s) = app.store("hera.json") {
            s.set("pet.pos", serde_json::json!([at.0, at.1]));
        }
        DRAGGING.store(false, Ordering::Relaxed);
    });
}

/// 제자리로 (오른쪽 아래)
#[tauri::command]
pub fn pet_home(app: AppHandle) {
    *POS.lock().unwrap() = None;
    *LAST.lock().unwrap() = None;
    if let Ok(s) = app.store("hera.json") {
        s.delete("pet.pos");
    }
}

fn img_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("pet"))
}

/// 내 이미지로 바꾸기 (설정 창에서 고른 파일 · base64). 예전 내 이미지는 지운다 → `pet.kind` = "custom", `pet.img` = 바꾼 시각
#[tauri::command]
pub fn pet_set_image(app: AppHandle, name: String, data: String) -> Result<(), String> {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if !IMG_EXT.contains(&ext.as_str()) {
        return Err("PNG · GIF · WebP · JPG 이미지만 쓸 수 있어요".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_IMG {
        return Err("8MB보다 작은 이미지를 골라 주세요".into());
    }
    let dir = img_dir(&app).ok_or("저장할 곳을 찾지 못했어요")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for e in IMG_EXT {
        let _ = std::fs::remove_file(dir.join(format!("custom.{e}")));
    }
    std::fs::write(dir.join(format!("custom.{ext}")), bytes).map_err(|e| e.to_string())?;
    let s = app.store("hera.json").map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    s.set("pet.img", now);
    s.set("pet.kind", "custom");
    Ok(())
}

/// 내 이미지 (data URL). 없으면 None
#[tauri::command]
pub fn pet_image(app: AppHandle) -> Option<String> {
    let dir = img_dir(&app)?;
    IMG_EXT.iter().find_map(|e| {
        let b = std::fs::read(dir.join(format!("custom.{e}"))).ok()?;
        let mime = if e.starts_with("jp") { "jpeg" } else { e };
        Some(format!("data:image/{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(b)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_is_bottom_right_left_of_the_panel() {
        // 1920×1080, 아래 작업 표시줄 48 → 작업 영역 [0,0,1920,1032]
        let r = home_rect([0, 0, 1920, 1032], 1.0);
        let panel = crate::tray::PANEL_W as i32 + 20;
        assert_eq!(r, [1920 - 12 - panel - 84, 1032 - 12 - 84, 84, 84]);
        assert!(r[0] + r[2] <= 1920 - 12 - crate::tray::PANEL_W as i32, "패널 자리와 겹치지 않는다");
        // 150%: 크기 · 간격도 1.5배, 작업 표시줄 위
        let r = home_rect([0, 0, 3840, 2088], 1.5);
        assert_eq!((r[2], r[1] + r[3]), (126, 2088 - 18));
    }

    #[test]
    fn moved_pet_stays_on_a_monitor() {
        let works = [[0, 0, 1920, 1032], [1920, 0, 3840, 1080]];
        assert_eq!(fit((100, 100), 84, &works), Some((100, 100)));
        assert_eq!(fit((1850, 980), 84, &works), Some((1836, 948)), "가운데가 첫 모니터 → 그 작업 영역 안으로");
        assert_eq!(fit((3800, 500), 84, &works), Some((3756, 500)), "오른쪽 끝 밖으로 반쯤 → 안으로");
        assert_eq!(fit((5000, 500), 84, &works), Some((3756, 500)), "뺀 모니터 → 가장 가까운 모니터");
        assert_eq!(fit((5000, 500), 84, &[]), None);
    }
}
