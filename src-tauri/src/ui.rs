// 창 핸들이 필요한 작은 도우미들. Windows = Win32, 그 외(맥 빌드 준비) = 가능한 Tauri API 또는 아무것도 안 함.
use tauri::WebviewWindow;

/// 저장된 rect 가 어느 모니터와도 64px 이상 겹치는가 (모니터를 뺐으면 버린다)
pub fn visible_on(r: [i32; 4], mons: &[[i32; 4]]) -> bool {
    mons.iter().any(|m| {
        let w = (r[0] + r[2]).min(m[0] + m[2]) - r[0].max(m[0]);
        let h = (r[1] + r[3]).min(m[1] + m[3]) - r[1].max(m[1]);
        w >= 64 && h >= 64
    })
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};

    /// 상주·오버레이 웹뷰는 저메모리 모드
    pub fn low_memory(win: &WebviewWindow) -> tauri::Result<()> {
        win.with_webview(|wv| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW};
            use windows::core::Interface;
            if let Ok(w) = wv.controller().CoreWebView2().and_then(|c| c.cast::<ICoreWebView2_19>()) {
                let _ = w.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW);
            }
        })
    }

    pub fn hwnd(win: &WebviewWindow) -> isize {
        win.hwnd().map_or(0, |h| h.0 as isize)
    }

    /// 크기·위치를 한 번에 (set_size → set_position 두 번이면 한 프레임 튄다)
    pub fn set_bounds(win: &WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
        if let Ok(hwnd) = win.hwnd() {
            unsafe {
                let _ = SetWindowPos(hwnd, None, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    use tauri::{PhysicalPosition, PhysicalSize};
    // 맥 포팅 시 채울 곳: docs/mac-port.md (NSPanel 비활성 창·레벨)
    pub fn low_memory(_: &WebviewWindow) -> tauri::Result<()> {
        Ok(())
    }
    pub fn hwnd(_: &WebviewWindow) -> isize {
        0
    }
    pub fn set_bounds(win: &WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
        let _ = win.set_size(PhysicalSize::new(w.max(0) as u32, h.max(0) as u32));
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

pub use imp::*;

#[cfg(test)]
mod tests {
    #[test]
    fn saved_rect_must_touch_a_monitor() {
        let mons = [[0, 0, 1920, 1080], [1920, 0, 2560, 1440]];
        assert!(super::visible_on([100, 100, 400, 500], &mons));
        assert!(super::visible_on([1900, 100, 400, 500], &mons)); // 두 모니터 걸침
        assert!(!super::visible_on([5000, 100, 400, 500], &mons)); // 빠진 모니터 자리
        assert!(!super::visible_on([-380, 100, 400, 500], &mons)); // 20px 만 걸침
        assert!(super::visible_on([-336, 100, 400, 500], &mons));
    }
}
