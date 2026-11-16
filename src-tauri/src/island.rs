// 아일랜드 창 (펫 캡슐 · 알림 알약 · 허브 · 안에서 여는 기능 화면). 창 = 작업 영역 오른쪽(왼쪽) 아래 모서리 680 × 680 (투명, 클릭 통과 = 히트 rect 만).
// 캡슐·허브·화면은 그 모서리에 붙어 위·안쪽으로 펼쳐진다 (store `island.place` = br | bl).
// - tall: 떼어내기·흡수 유령이 움직이는 동안만 작업 영역 전체. 모서리 기준이라 내용은 움직이지 않는다.
//   창 원점이 바뀌면 이미 보고된 히트 rect(클라이언트 기준)를 같은 만큼 옮긴다 — 안 그러면 캡슐이 클릭을 못 받는다 (a3 버그 5).
// - interactive: 안의 화면에 글자를 칠 때(할 일·채팅·터미널) 키보드 포커스를 받는다. 접히면 직전 앱으로 돌려준다.
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

pub const HEIGHT: f64 = 680.0; // 논리 px (펫 추가 440×640 · 설정 380×610 · 터미널 640×300 + 여백)
pub const WIDTH: f64 = 680.0;
pub static TALL: AtomicBool = AtomicBool::new(false);
pub static INTERACTIVE: AtomicBool = AtomicBool::new(false);
static PREV: AtomicIsize = AtomicIsize::new(0);

/// 작업 영역 (물리 px) → 아일랜드 창 (x, y, w, h). left = 왼쪽 아래.
pub fn bounds(wa: [i32; 4], scale: f64, left: bool, tall: bool) -> [i32; 4] {
    if tall {
        return [wa[0], wa[1] + 1, wa[2], wa[3] - 1]; // -1px: 작업 표시줄 자동 숨김이면 작업 영역 = 모니터 → '전체화면 앱' 판정 회피
    }
    let w = ((WIDTH * scale).round() as i32).min(wa[2]);
    let h = ((HEIGHT * scale).round() as i32).min(wa[3] - 1);
    [if left { wa[0] } else { wa[0] + wa[2] - w }, wa[1] + wa[3] - h, w, h]
}

pub fn left(app: &AppHandle) -> bool {
    app.store("hera.json").ok().and_then(|s| s.get("island.place")).is_some_and(|v| v == "bl")
}

pub fn place(app: &AppHandle) {
    let (Ok(Some(m)), Some(win)) = (app.primary_monitor(), app.get_webview_window("island")) else { return };
    let wa = m.work_area();
    let [x, y, w, h] = bounds([wa.position.x, wa.position.y, wa.size.width as i32, wa.size.height as i32], m.scale_factor(), left(app), TALL.load(Ordering::Relaxed));
    if let Ok(o) = win.outer_position() {
        crate::watch::shift_rects("island", (o.x - x) as f64, (o.y - y) as f64);
    }
    crate::ui::set_bounds(&win, x, y, w, h);
}

#[tauri::command]
pub fn island_tall(app: AppHandle, on: bool) {
    if TALL.swap(on, Ordering::Relaxed) != on {
        place(&app);
        // 화면 높이 표면을 접었으면 GPU·렌더러가 들고 있던 큰 텍스처를 바로 놓게 (저메모리 수준 다시 걸기)
        if !on {
            if let Some(w) = app.get_webview_window("island") {
                let _ = crate::ui::trim(&w);
            }
        }
    }
}

/// 키보드 포커스 받기/돌려주기
#[tauri::command]
pub fn island_focus(app: AppHandle, on: bool) {
    let Some(win) = app.get_webview_window("island") else { return };
    if on {
        if !INTERACTIVE.swap(true, Ordering::Relaxed) {
            PREV.store(crate::ui::foreground(), Ordering::Relaxed);
        }
        #[cfg(windows)]
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE};
            let h = windows::Win32::Foundation::HWND(crate::ui::hwnd(&win) as _);
            SetWindowLongPtrW(h, GWL_EXSTYLE, GetWindowLongPtrW(h, GWL_EXSTYLE) & !(WS_EX_NOACTIVATE.0 as isize));
        }
        let _ = win.set_focus();
    } else if INTERACTIVE.swap(false, Ordering::Relaxed) {
        // NOACTIVATE 는 watch 루프가 다음 틱에 다시 붙인다
        let prev = PREV.swap(0, Ordering::Relaxed);
        if crate::ui::foreground() == crate::ui::hwnd(&win) || prev != 0 {
            crate::ui::restore_foreground(prev);
        }
    }
}

/// 아일랜드 '스니펫': 직전 앱으로 포커스를 돌려준 뒤 그 앱에 붙여넣기
#[tauri::command]
pub async fn island_paste(app: AppHandle, text: String) -> Result<(), String> {
    island_focus(app, false);
    tauri::async_runtime::spawn_blocking(move || crate::clip::paste(&text, || {})).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn island_window_bounds() {
        let wa = [0, 0, 1920, 1032]; // 작업 표시줄 48px
        assert_eq!(bounds(wa, 1.0, false, false), [1240, 352, 680, 680]); // 오른쪽 아래
        assert_eq!(bounds(wa, 1.0, true, false), [0, 352, 680, 680]); // 왼쪽 아래
        assert_eq!(bounds([0, 0, 2560, 1392], 1.5, false, false), [1540, 372, 1020, 1020]);
        assert_eq!(bounds([-1920, 0, 1920, 1080], 1.0, false, true), [-1920, 1, 1920, 1079]); // tall = 작업 영역 - 1px (위쪽)
        assert_eq!(bounds([0, 0, 600, 500], 1.0, false, false), [0, 1, 600, 499]); // 작은 모니터
    }

    /// 버그 5 회귀: 떼어내기·흡수 동안 창이 커졌다 돌아와도 캡슐 히트 rect 는 화면 같은 자리
    #[test]
    fn tall_round_trip_keeps_capsule_hit() {
        let wa = [0, 0, 1920, 1032];
        let small = bounds(wa, 1.0, false, false);
        let tall = bounds(wa, 1.0, false, true);
        let cap = [580.0, 612.0, 84.0, 64.0]; // 작은 창 기준 클라이언트 rect (보통 캡슐 + 여유)
        let screen = |o: [i32; 4], r: [f64; 4]| (o[0] as f64 + r[0], o[1] as f64 + r[1]);
        let mut r = vec![cap];
        crate::watch::shift(&mut r, (small[0] - tall[0]) as f64, (small[1] - tall[1]) as f64);
        assert_eq!(screen(tall, r[0]), screen(small, cap));
        crate::watch::shift(&mut r, (tall[0] - small[0]) as f64, (tall[1] - small[1]) as f64);
        assert_eq!(r[0], cap);
    }
}
