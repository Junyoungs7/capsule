// 아일랜드 창 (노치 · 알약 · 허브 · 안에서 여는 기능 화면). 창 = 맨 위 가운데 680 × 600 (투명, 클릭 통과 = 히트 rect 만).
// - tall: 떼어내기·흡수 애니메이션 동안만 주 모니터 전체 (유령 화면이 화면 어디로든 따라가게). 가운데·위쪽 기준이라 내용은 움직이지 않는다.
//   평소엔 작게 — 투명 표면이 클수록 GPU 프로세스 메모리가 는다 (모니터 전체 ≈ +40MB).
// - interactive: 안의 화면에 글자를 칠 때(할 일·채팅·터미널) 키보드 포커스를 받는다. 접히면 직전 앱으로 돌려준다.
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

use tauri::{AppHandle, Manager};

pub const HEIGHT: f64 = 600.0; // 논리 px (터미널 640×300 · 달력 480×420 + 알약)
pub const WIDTH: f64 = 680.0;
pub static TALL: AtomicBool = AtomicBool::new(false);
pub static INTERACTIVE: AtomicBool = AtomicBool::new(false);
static PREV: AtomicIsize = AtomicIsize::new(0);

/// 주 모니터 (물리 px) → 아일랜드 창 (x, y, w, h)
pub fn bounds(mon: [i32; 4], scale: f64, tall: bool) -> [i32; 4] {
    if tall {
        return [mon[0], mon[1], mon[2], mon[3] - 1]; // -1px: 꽉 채운 최상위 창 = '전체화면 앱' 판정 회피
    }
    // 가운데 정렬 — 폭이 모니터와 홀짝이 같아야 가운데가 반 픽셀도 안 움직인다
    let mut w = ((WIDTH * scale).round() as i32).min(mon[2]);
    if (mon[2] - w) % 2 != 0 {
        w += 1;
    }
    let h = ((HEIGHT * scale).round() as i32).min(mon[3] - 1);
    [mon[0] + (mon[2] - w) / 2, mon[1], w, h]
}

pub fn place(app: &AppHandle) {
    let (Ok(Some(m)), Some(win)) = (app.primary_monitor(), app.get_webview_window("island")) else { return };
    let (p, z) = (m.position(), m.size());
    let [x, y, w, h] = bounds([p.x, p.y, z.width as i32, z.height as i32], m.scale_factor(), TALL.load(Ordering::Relaxed));
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
        assert_eq!(bounds([0, 0, 1920, 1080], 1.0, false), [620, 0, 680, 600]);
        assert_eq!(bounds([0, 0, 2560, 1440], 1.5, false), [770, 0, 1020, 900]);
        assert_eq!(bounds([0, 0, 1921, 1080], 1.0, false), [620, 0, 681, 600]); // 홀짝 맞춤 → 가운데 그대로
        assert_eq!(bounds([-1920, 0, 1920, 1080], 1.0, true), [-1920, 0, 1920, 1079]); // tall = 모니터 - 1px
        assert_eq!(bounds([0, 0, 600, 500], 1.0, false), [0, 0, 600, 499]); // 작은 모니터
    }
}
