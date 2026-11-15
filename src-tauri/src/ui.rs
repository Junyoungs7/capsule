// 창 핸들이 필요한 작은 도우미들 (lib.rs 에서 분리). Windows = Win32, 그 외(맥 빌드 준비) = 가능한 Tauri API 또는 아무것도 안 함.
use tauri::WebviewWindow;

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowLongPtrW, IsWindow, SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    /// B0-5: 상주 웹뷰(독/아일랜드/턴테이블/숨긴 팔레트)는 상시 저메모리 모드
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

    /// 크기·위치를 한 번에 (set_size → set_position 두 번이면 독이 한 프레임 아래로 튄다)
    pub fn set_bounds(win: &WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
        if let Ok(hwnd) = win.hwnd() {
            unsafe {
                let _ = SetWindowPos(hwnd, None, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
            }
        }
    }

    /// 최상위 무리의 맨 위로 (효과 창 위로 독·아일랜드를 다시 올릴 때)
    pub fn raise(win: &WebviewWindow) {
        if let Ok(h) = win.hwnd() {
            unsafe {
                let _ = SetWindowPos(h, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }
    }

    pub fn foreground() -> isize {
        unsafe { GetForegroundWindow() }.0 as isize
    }

    /// 팔레트를 닫을 때 직전 앱으로 포커스 반환
    pub fn restore_foreground(prev: isize) {
        let prev = HWND(prev as _);
        if unsafe { IsWindow(Some(prev)) }.as_bool() {
            let _ = unsafe { SetForegroundWindow(prev) };
        }
    }

    /// Alt+Tab 제외 = TOOLWINDOW, APPWINDOW 없음 (포커스는 받음). tao 가 show 때 GWL_EXSTYLE 을 통째로 다시 쓰므로 show 뒤에 부를 것.
    pub fn toolwindow(win: &WebviewWindow) {
        if let Ok(h) = win.hwnd() {
            unsafe { SetWindowLongPtrW(h, GWL_EXSTYLE, (GetWindowLongPtrW(h, GWL_EXSTYLE) | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize)) };
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    use tauri::{PhysicalPosition, PhysicalSize};
    // 맥 포팅 시 채울 곳: docs/mac-port.md (NSPanel 비활성 창·레벨·포커스 반환)
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
    pub fn raise(win: &WebviewWindow) {
        let _ = win.set_always_on_top(true);
    }
    pub fn foreground() -> isize {
        0
    }
    pub fn restore_foreground(_: isize) {}
    pub fn toolwindow(_: &WebviewWindow) {}
}

pub use imp::*;

