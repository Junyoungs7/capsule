// '상단 공간 확보' (기본 끔): 주 모니터 맨 위 28px 를 AppBar 로 예약 → 최대화한 창이 그 아래에서 시작해 Island 가 앱을 가리지 않는다.
// 전용 스레드의 숨은 창 1개로 SHAppBarMessage(ABM_NEW → QUERYPOS/SETPOS). 끄기·종료 = ABM_REMOVE + 창 파괴.
// 크래시 대비: 등록한 창 핸들을 store `appbar.hwnd` 에 적어 두고, 다음 시작 때 그 핸들로 ABM_REMOVE (Explorer 는 핸들 값으로 찾는다).
use std::sync::atomic::{AtomicIsize, Ordering};

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{SHAppBarMessage, ABE_TOP, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, ABN_POSCHANGED, APPBARDATA};
use windows::Win32::UI::WindowsAndMessaging::*;

pub const HEIGHT: f64 = 28.0; // 논리 px
const WM_ABAR: u32 = WM_APP + 7;
const WM_QUIT_BAR: u32 = WM_APP + 8;
static BAR: AtomicIsize = AtomicIsize::new(0);
/// 예약할 띠 (물리 px): 주 모니터 [x, y, w, h] · 배율 → 위쪽 띠
static MON: std::sync::Mutex<([i32; 4], f64)> = std::sync::Mutex::new(([0, 0, 0, 0], 1.0));

/// 주 모니터 맨 위 띠 rect (물리 px)
pub fn band(mon: [i32; 4], scale: f64) -> RECT {
    RECT { left: mon[0], top: mon[1], right: mon[0] + mon[2], bottom: mon[1] + (HEIGHT * scale).round() as i32 }
}

fn data(h: HWND) -> APPBARDATA {
    APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: h, uCallbackMessage: WM_ABAR, uEdge: ABE_TOP, ..Default::default() }
}

unsafe fn set_pos(h: HWND) {
    let (mon, s) = *MON.lock().unwrap();
    let mut d = data(h);
    d.rc = band(mon, s);
    SHAppBarMessage(ABM_QUERYPOS, &mut d);
    // 위쪽에 다른 앱바가 있으면 Explorer 가 top 을 내려 준다 → 높이 유지
    d.rc.bottom = d.rc.top + (HEIGHT * s).round() as i32;
    SHAppBarMessage(ABM_SETPOS, &mut d);
}

unsafe extern "system" fn wndproc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match m {
        WM_ABAR if wp.0 as u32 == ABN_POSCHANGED => {
            set_pos(h);
            LRESULT(0)
        }
        WM_QUIT_BAR => {
            let mut d = data(h);
            SHAppBarMessage(ABM_REMOVE, &mut d);
            let _ = DestroyWindow(h);
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(h, m, wp, lp),
    }
}

/// 이전 실행이 해제하지 못한 예약(크래시) 정리 — 시작할 때 1번
pub fn cleanup_stale(app: &AppHandle) {
    let Ok(s) = app.store("hera.json") else { return };
    if let Some(old) = s.get("appbar.hwnd").and_then(|v| v.as_i64()).filter(|&v| v != 0) {
        unsafe {
            let mut d = data(HWND(old as _));
            SHAppBarMessage(ABM_REMOVE, &mut d);
        }
        s.delete("appbar.hwnd");
    }
}

/// 켜기/끄기. 켜져 있으면 다시 켜도 위치만 새로 맞춘다 (모니터·배율 변경 때).
pub fn set(app: &AppHandle, on: bool) {
    if let Ok(Some(m)) = app.primary_monitor() {
        let (p, z) = (m.position(), m.size());
        *MON.lock().unwrap() = ([p.x, p.y, z.width as i32, z.height as i32], m.scale_factor());
    }
    let cur = BAR.load(Ordering::Relaxed);
    if !on {
        if cur != 0 {
            BAR.store(0, Ordering::Relaxed);
            unsafe {
                let _ = PostMessageW(Some(HWND(cur as _)), WM_QUIT_BAR, WPARAM(0), LPARAM(0));
            }
        }
        if let Ok(s) = app.store("hera.json") {
            s.delete("appbar.hwnd");
        }
        return;
    }
    if cur != 0 {
        unsafe {
            let _ = PostMessageW(Some(HWND(cur as _)), WM_ABAR, WPARAM(ABN_POSCHANGED as usize), LPARAM(0));
        }
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || unsafe {
        let inst = GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: inst.into(), lpszClassName: w!("HeraAppBar"), ..Default::default() };
        RegisterClassW(&wc);
        // 보이지 않는 툴윈도우 (AppBar 콜백을 받으려면 메시지 전용 창이면 안 된다)
        let Ok(h) = CreateWindowExW(WS_EX_TOOLWINDOW, w!("HeraAppBar"), w!(""), WS_POPUP, 0, 0, 0, 0, None, None, Some(inst.into()), None) else {
            let _ = tx.send(0);
            return;
        };
        let mut d = data(h);
        if SHAppBarMessage(ABM_NEW, &mut d) == 0 {
            let _ = DestroyWindow(h);
            let _ = tx.send(0);
            return;
        }
        set_pos(h);
        let _ = tx.send(h.0 as isize);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            DispatchMessageW(&msg);
        }
    });
    let h = rx.recv().unwrap_or(0);
    BAR.store(h, Ordering::Relaxed);
    if h != 0 {
        if let Ok(s) = app.store("hera.json") {
            s.set("appbar.hwnd", h as i64);
            let _ = s.save(); // 크래시 대비: 바로 디스크에
        }
    }
}

/// 모니터·배율이 바뀌면 켜져 있을 때만 위치 다시 맞춤
pub fn refresh(app: &AppHandle) {
    if BAR.load(Ordering::Relaxed) != 0 {
        set(app, true);
    }
}

/// 종료 경로 (트레이 종료 · RunEvent::Exit): 예약을 꼭 돌려준다. 같은 스레드에서 바로 REMOVE (메시지 루프를 기다리지 않음).
pub fn release(app: &AppHandle) {
    let cur = BAR.swap(0, Ordering::Relaxed);
    if cur != 0 {
        unsafe {
            let mut d = data(HWND(cur as _));
            SHAppBarMessage(ABM_REMOVE, &mut d);
            let _ = PostMessageW(Some(HWND(cur as _)), WM_QUIT_BAR, WPARAM(0), LPARAM(0));
        }
        if let Ok(s) = app.store("hera.json") {
            s.delete("appbar.hwnd");
            let _ = s.save();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn band_is_top_strip() {
        let r = band([0, 0, 2560, 1440], 1.5);
        assert_eq!((r.left, r.top, r.right, r.bottom), (0, 0, 2560, 42));
        let r = band([-1920, 120, 1920, 1080], 1.0); // 왼쪽·아래로 어긋난 주 모니터
        assert_eq!((r.left, r.top, r.right, r.bottom), (-1920, 120, 0, 148));
    }
}
