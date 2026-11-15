// 작업 표시줄 숨기기 (설정 `taskbar.hide`, 기본 끔): Shell_TrayWnd·Shell_SecondaryTrayWnd 를 숨기고 작업 영역을 모니터 전체로.
// 끄기·정상 종료·(설정이 꺼진 채) 시작 시 복원 — 비정상 종료(panic=abort) 뒤의 복구는 다음 시작이 맡는다.
// explorer 재시작(TaskbarCreated)·디스플레이 변경·explorer 가 스스로 다시 보일 때 다시 적용 (shell.rs 가 알려 줌).
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::core::{w, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::Shell::{SHAppBarMessage, ABM_GETSTATE, ABS_AUTOHIDE, APPBARDATA};
use windows::Win32::UI::WindowsAndMessaging::*;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Ev {
    Startup,
    Setting,
    /// explorer 재시작 · 디스플레이 변경 · explorer 가 작업 표시줄을 다시 보임
    Reapply,
    Exit,
}

static WANT: AtomicBool = AtomicBool::new(false);
static OURS: AtomicBool = AtomicBool::new(false); // 지금 Hera 가 숨겨 둔 상태
static PEEK: AtomicBool = AtomicBool::new(false); // 숨은 트레이 버튼이 잠깐 보이게 한 상태
static LAST: Mutex<Option<Instant>> = Mutex::new(None);

/// 무엇을 할지: Some(true) = 숨김 적용, Some(false) = 복원, None = 그대로.
/// tray_visible = 지금 작업 표시줄이 보이는가 (시작 시 '숨겨진 채 남은' 비정상 종료 흔적 판단용).
pub fn action(want: bool, ours: bool, tray_visible: bool, ev: Ev) -> Option<bool> {
    match ev {
        Ev::Startup | Ev::Setting if want => Some(true),
        // 꺼짐: 우리가 숨겼거나, 숨겨진 채 남아 있으면(이전 실행이 죽음) 복원
        Ev::Startup | Ev::Setting => (ours || !tray_visible).then_some(false),
        Ev::Reapply => want.then_some(true),
        Ev::Exit => ours.then_some(false),
    }
}

/// 복원할 작업 영역 = 모니터에서 작업 표시줄이 붙은 가장자리를 뺀 것 (자동 숨김이면 모니터 전체). [l, t, r, b]
pub fn restored_work_area(mon: [i32; 4], tray: [i32; 4], autohide: bool) -> [i32; 4] {
    let [l, t, r, b] = mon;
    let mut wa = mon;
    if autohide {
        return wa;
    }
    let horizontal = tray[2] - tray[0] >= (r - l) / 2;
    if horizontal {
        if tray[1] <= t {
            wa[1] = tray[3].clamp(t, b);
        } else {
            wa[3] = tray[1].clamp(t, b);
        }
    } else if tray[0] <= l {
        wa[0] = tray[2].clamp(l, r);
    } else {
        wa[2] = tray[0].clamp(l, r);
    }
    wa
}

fn trays() -> Vec<HWND> {
    unsafe extern "system" fn collect(h: HWND, l: LPARAM) -> BOOL {
        let mut buf = [0u16; 32];
        let n = GetClassNameW(h, &mut buf) as usize;
        if String::from_utf16_lossy(&buf[..n]) == "Shell_SecondaryTrayWnd" {
            (*(l.0 as *mut Vec<HWND>)).push(h);
        }
        true.into()
    }
    let mut v = vec![];
    unsafe {
        if let Ok(h) = FindWindowW(w!("Shell_TrayWnd"), None) {
            v.push(h);
        }
        let _ = EnumWindows(Some(collect), LPARAM(&mut v as *mut _ as isize));
    }
    v
}

pub fn is_tray(h: HWND) -> bool {
    let mut buf = [0u16; 32];
    let n = unsafe { GetClassNameW(h, &mut buf) } as usize;
    matches!(String::from_utf16_lossy(&buf[..n]).as_str(), "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
}

fn rect(r: RECT) -> [i32; 4] {
    [r.left, r.top, r.right, r.bottom]
}

fn set_work_area(wa: [i32; 4]) {
    let r = RECT { left: wa[0], top: wa[1], right: wa[2], bottom: wa[3] };
    unsafe {
        let _ = SystemParametersInfoW(SPI_SETWORKAREA, 0, Some(&r as *const RECT as *mut _), SPIF_SENDCHANGE);
    }
}

fn monitors() -> Vec<[i32; 4]> {
    unsafe extern "system" fn collect(m: HMONITOR, _: HDC, _: *mut RECT, l: LPARAM) -> BOOL {
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if GetMonitorInfoW(m, &mut mi).as_bool() {
            (*(l.0 as *mut Vec<[i32; 4]>)).push(rect(mi.rcMonitor));
        }
        true.into()
    }
    let mut v = vec![];
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut v as *mut _ as isize));
    }
    v
}

fn apply(hide: bool) {
    *LAST.lock().unwrap() = Some(Instant::now());
    OURS.store(hide, Ordering::Relaxed);
    PEEK.store(false, Ordering::Relaxed);
    let ts = trays();
    unsafe {
        for &h in &ts {
            let _ = ShowWindow(h, if hide { SW_HIDE } else { SW_SHOWNA });
        }
    }
    if hide {
        for m in monitors() {
            set_work_area(m);
        }
        return;
    }
    let mut abd = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, ..Default::default() };
    let autohide = unsafe { SHAppBarMessage(ABM_GETSTATE, &mut abd) } as u32 & ABS_AUTOHIDE != 0;
    for h in ts {
        let mut tr = RECT::default();
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        unsafe {
            if GetWindowRect(h, &mut tr).is_ok() && GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mut mi).as_bool() {
                set_work_area(restored_work_area(rect(mi.rcMonitor), rect(tr), autohide));
            }
        }
    }
}

pub fn handle(ev: Ev) {
    let visible = trays().first().is_some_and(|&h| unsafe { IsWindowVisible(h) }.as_bool());
    if let Some(hide) = action(WANT.load(Ordering::Relaxed), OURS.load(Ordering::Relaxed), visible, ev) {
        apply(hide);
    }
}

/// 설정 반영 (시작 = Ev::Startup, 이후 변경 = Ev::Setting)
pub fn set(want: bool, ev: Ev) {
    WANT.store(want, Ordering::Relaxed);
    handle(ev);
}

/// explorer 가 숨긴 작업 표시줄을 스스로 다시 보였을 때 (Start 메뉴 등) — 잠깐 보기 중이 아니면 다시 숨김. 0.5초에 1번까지.
pub fn on_tray_shown() {
    if !OURS.load(Ordering::Relaxed) || PEEK.load(Ordering::Relaxed) {
        return;
    }
    if LAST.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(500)) {
        return;
    }
    apply(true);
}

/// 숨은 트레이 버튼: 숨겨 둔 상태면 작업 표시줄을 잠깐 보인다 (Win+B 가 갈 곳). 끝은 end_peek.
pub fn peek() -> bool {
    if !OURS.load(Ordering::Relaxed) {
        return false;
    }
    PEEK.store(true, Ordering::Relaxed);
    for h in trays() {
        unsafe {
            let _ = ShowWindow(h, SW_SHOWNA);
        }
    }
    true
}

/// 포그라운드가 explorer 밖으로 가면(트레이 펼침을 닫음) 다시 숨김
pub fn end_peek() {
    if PEEK.swap(false, Ordering::Relaxed) && OURS.load(Ordering::Relaxed) {
        apply(true);
    }
}

pub fn peeking() -> bool {
    PEEK.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions() {
        use Ev::*;
        // 켬: 시작·설정·재적용 모두 숨김
        assert_eq!(action(true, false, true, Startup), Some(true));
        assert_eq!(action(true, true, false, Setting), Some(true));
        assert_eq!(action(true, true, true, Reapply), Some(true));
        // 끔 + 정상 상태(보임, 우리가 안 숨김): 아무것도 안 함 — 시스템 설정을 건드리지 않는다
        assert_eq!(action(false, false, true, Startup), None);
        assert_eq!(action(false, false, true, Setting), None);
        // 끔 + 이전 실행이 숨긴 채 죽음 → 시작 시 복원 (복구)
        assert_eq!(action(false, false, false, Startup), Some(false));
        // 끔으로 전환 → 복원
        assert_eq!(action(false, true, false, Setting), Some(false));
        // 끔이면 재적용 없음
        assert_eq!(action(false, false, true, Reapply), None);
        // 종료: 우리가 숨겼을 때만 복원
        assert_eq!(action(true, true, false, Exit), Some(false));
        assert_eq!(action(false, false, true, Exit), None);
    }

    #[test]
    fn work_area_restore() {
        let mon = [0, 0, 1920, 1080];
        assert_eq!(restored_work_area(mon, [0, 1032, 1920, 1080], false), [0, 0, 1920, 1032]); // 아래
        assert_eq!(restored_work_area(mon, [0, 0, 1920, 48], false), [0, 48, 1920, 1080]); // 위
        assert_eq!(restored_work_area(mon, [0, 0, 62, 1080], false), [62, 0, 1920, 1080]); // 왼쪽
        assert_eq!(restored_work_area(mon, [1858, 0, 1920, 1080], false), [0, 0, 1858, 1080]); // 오른쪽
        assert_eq!(restored_work_area(mon, [0, 1032, 1920, 1080], true), mon); // 자동 숨김
        // 둘째 모니터 (오른쪽, 음수 아님)
        assert_eq!(restored_work_area([1920, 0, 4480, 1440], [1920, 1392, 4480, 1440], false), [1920, 0, 4480, 1392]);
    }
}
