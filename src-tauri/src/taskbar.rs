// Windows 작업 표시줄과 공존 (숨기지 않는다 — Hera 가 망가져도 작업 표시줄이 대안으로 남아야 함).
// 자동 숨김 작업 표시줄이 아래에서 올라오면 독이 그 높이만큼 위로 비켜 선다 (dock_lift). 항상 보이는 작업 표시줄은 작업 영역이 이미 피한다.
use windows::core::w;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::Shell::{SHAppBarMessage, ABM_GETSTATE, ABS_AUTOHIDE, APPBARDATA};
use windows::Win32::UI::WindowsAndMessaging::*;

/// 독을 올릴 높이(물리 px): 자동 숨김 + 아래쪽 + 지금 펼쳐져 있으면(보이는 높이 > 4px) 작업 표시줄 높이 전체, 아니면 0.
/// 항상 보임이면 0 (작업 영역 기준 배치가 이미 위에 둔다), 다른 가장자리도 0.
pub fn dock_lift(mon: [i32; 4], tray: [i32; 4], autohide: bool) -> i32 {
    let [l, t, r, b] = mon;
    let horizontal = tray[2] - tray[0] >= (r - l) / 2;
    let bottom = horizontal && tray[1] > t + (b - t) / 2;
    if !autohide || !bottom {
        return 0;
    }
    let visible = b - tray[1].max(t);
    if visible > 4 { (tray[3] - tray[1]).max(0) } else { 0 }
}

/// 이전 빌드(작업 표시줄 숨기기)가 숨긴 채 남겼을 수 있는 작업 표시줄을 시작 시 1회 되살린다 (+ 작업 영역)
pub fn recover() {
    unsafe {
        let Ok(h) = FindWindowW(w!("Shell_TrayWnd"), None) else { return };
        if IsWindowVisible(h).as_bool() {
            return;
        }
        let _ = ShowWindow(h, SW_SHOWNA);
        let Some((mon, tray, autohide)) = state(h) else { return };
        let wa = restored_work_area(mon, tray, autohide);
        let r = RECT { left: wa[0], top: wa[1], right: wa[2], bottom: wa[3] };
        let _ = SystemParametersInfoW(SPI_SETWORKAREA, 0, Some(&r as *const RECT as *mut _), SPIF_SENDCHANGE);
    }
}

/// 복원할 작업 영역 = 모니터에서 작업 표시줄이 붙은 가장자리를 뺀 것 (자동 숨김이면 모니터 전체). [l, t, r, b]
fn restored_work_area(mon: [i32; 4], tray: [i32; 4], autohide: bool) -> [i32; 4] {
    let [l, t, r, b] = mon;
    let mut wa = mon;
    if autohide {
        return wa;
    }
    if tray[2] - tray[0] >= (r - l) / 2 {
        if tray[1] <= t { wa[1] = tray[3].clamp(t, b) } else { wa[3] = tray[1].clamp(t, b) }
    } else if tray[0] <= l {
        wa[0] = tray[2].clamp(l, r);
    } else {
        wa[2] = tray[0].clamp(l, r);
    }
    wa
}

/// (모니터 rect, 작업 표시줄 rect, 자동 숨김)
pub fn state(tray: HWND) -> Option<([i32; 4], [i32; 4], bool)> {
    let mut tr = RECT::default();
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe {
        GetWindowRect(tray, &mut tr).ok()?;
        GetMonitorInfoW(MonitorFromWindow(tray, MONITOR_DEFAULTTONEAREST), &mut mi).ok().ok()?;
        let mut abd = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, ..Default::default() };
        let autohide = SHAppBarMessage(ABM_GETSTATE, &mut abd) as u32 & ABS_AUTOHIDE != 0;
        let m = mi.rcMonitor;
        Some(([m.left, m.top, m.right, m.bottom], [tr.left, tr.top, tr.right, tr.bottom], autohide))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lift_rules() {
        let mon = [0, 0, 1920, 1080];
        // 자동 숨김 + 아래: 숨은 상태(2px 만 걸침) = 0, 펼침 = 높이 48
        assert_eq!(dock_lift(mon, [0, 1078, 1920, 1126], true), 0);
        assert_eq!(dock_lift(mon, [0, 1032, 1920, 1080], true), 48);
        // 미끄러져 올라오는 중(보이는 높이 > 4) = 전체 높이 → 독은 한 번에 스프링으로 올라간다
        assert_eq!(dock_lift(mon, [0, 1060, 1920, 1108], true), 48);
        // 항상 보임: 작업 영역이 이미 피함 → 0
        assert_eq!(dock_lift(mon, [0, 1032, 1920, 1080], false), 0);
        // 다른 가장자리: 그대로
        assert_eq!(dock_lift(mon, [0, 0, 1920, 48], true), 0); // 위
        assert_eq!(dock_lift(mon, [0, 0, 62, 1080], true), 0); // 왼쪽
        assert_eq!(dock_lift(mon, [1858, 0, 1920, 1080], true), 0); // 오른쪽
        // 150% 배율, 둘째 모니터 좌표
        assert_eq!(dock_lift([1920, 0, 4480, 1440], [1920, 1368, 4480, 1440], true), 72);
    }

    #[test]
    fn work_area_restore() {
        let mon = [0, 0, 1920, 1080];
        assert_eq!(restored_work_area(mon, [0, 1032, 1920, 1080], false), [0, 0, 1920, 1032]);
        assert_eq!(restored_work_area(mon, [0, 0, 1920, 48], false), [0, 48, 1920, 1080]);
        assert_eq!(restored_work_area(mon, [0, 0, 62, 1080], false), [62, 0, 1920, 1080]);
        assert_eq!(restored_work_area(mon, [0, 1032, 1920, 1080], true), mon);
    }
}
