// 작업 표시줄 펫 (꾸미기 켜짐일 때만 — 꺼지면 창을 파괴해 메모리 0).
// 주 작업 표시줄의 안쪽 가장자리, 알림 영역(트레이) 옆에 앉는다 (아래 · 위 · 왼쪽 · 오른쪽 작업 표시줄, 모든 배율).
// 창은 투명 · 클릭 통과, 펫 모양(히트 rect)만 누를 수 있다 → 누르면 패널. 전체화면 앱 중 · 자동 숨김 작업 표시줄이 숨었을 때는 숨김.
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use windows::core::w;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::Shell::{SHAppBarMessage, ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_GETSTATE, ABM_GETTASKBARPOS, ABS_AUTOHIDE, APPBARDATA};
use windows::Win32::UI::WindowsAndMessaging::*;

/// 펫 창 (논리 px) — 펫 44×40 + 여유
pub const SIZE: (f64, f64) = (48.0, 42.0);
static HWND_PET: AtomicIsize = AtomicIsize::new(0);
static SHOWN: AtomicBool = AtomicBool::new(true);
/// 마지막으로 놓은 자리의 근거 (작업 표시줄 rect, 배율 %, 트레이 rect) — 같으면 옮기지 않는다
type Spot = ([i32; 4], u32, [i32; 4]);
static LAST: Mutex<Option<Spot>> = Mutex::new(None);

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Edge {
    Bottom,
    Top,
    Left,
    Right,
}

/// 작업 표시줄 rect · 방향 · 트레이 rect · 배율 → 펫 창 [x, y, w, h] (물리 px). 작업 표시줄 안, 트레이 바로 앞 빈자리 (두께 가운데).
pub fn pet_rect(bar: [i32; 4], edge: Edge, tray: [i32; 4], s: f64) -> [i32; 4] {
    let (w, h) = ((SIZE.0 * s).round() as i32, (SIZE.1 * s).round() as i32);
    let gap = (8.0 * s).round() as i32;
    let (cy, cx) = ((bar[1] + bar[3] - h) / 2, (bar[0] + bar[2] - w) / 2);
    match edge {
        Edge::Bottom | Edge::Top => [tray[0] - gap - w, cy, w, h],
        Edge::Left | Edge::Right => [cx, tray[1] - gap - h, w, h],
    }
}

/// 자동 숨김 작업 표시줄이 지금 숨었나 (화면 안에 남은 두께가 8px 미만)
pub fn bar_hidden(bar: [i32; 4], mon: [i32; 4], edge: Edge) -> bool {
    let vis = match edge {
        Edge::Bottom => mon[3].min(bar[3]) - mon[1].max(bar[1]),
        Edge::Top => bar[3].min(mon[3]) - bar[1].max(mon[1]),
        Edge::Left => bar[2].min(mon[2]) - bar[0].max(mon[0]),
        Edge::Right => mon[2].min(bar[2]) - mon[0].max(bar[0]),
    };
    vis < 8
}

fn r4(r: RECT) -> [i32; 4] {
    [r.left, r.top, r.right, r.bottom]
}

/// (작업 표시줄 rect, 방향, 트레이 rect, 자동 숨김) — 주 작업 표시줄
fn taskbar() -> Option<([i32; 4], Edge, [i32; 4], bool)> {
    unsafe {
        let mut d = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, ..Default::default() };
        if SHAppBarMessage(ABM_GETTASKBARPOS, &mut d) == 0 {
            return None;
        }
        let edge = match d.uEdge {
            ABE_TOP => Edge::Top,
            ABE_LEFT => Edge::Left,
            ABE_RIGHT => Edge::Right,
            _ => Edge::Bottom,
        };
        let auto = SHAppBarMessage(ABM_GETSTATE, &mut d) as u32 & ABS_AUTOHIDE != 0;
        // 지금 자리 (자동 숨김이면 미끄러져 나간 자리) = 작업 표시줄 창 rect
        let tw = FindWindowW(w!("Shell_TrayWnd"), None).ok()?;
        let mut r = RECT::default();
        GetWindowRect(tw, &mut r).ok()?;
        let bar = r4(r);
        let tray = FindWindowExW(Some(tw), None, w!("TrayNotifyWnd"), None).ok().and_then(|t| {
            let mut tr = RECT::default();
            GetWindowRect(t, &mut tr).ok().map(|_| r4(tr))
        });
        // 트레이를 못 찾으면 작업 표시줄 끝 (가로 = 오른쪽 끝, 세로 = 아래 끝)
        let tray = tray.unwrap_or(match edge {
            Edge::Bottom | Edge::Top => [bar[2], bar[1], bar[2], bar[3]],
            _ => [bar[0], bar[3], bar[2], bar[3]],
        });
        Some((bar, edge, tray, auto))
    }
}

fn monitor_of(r: [i32; 4]) -> ([i32; 4], f64) {
    let c = ((r[0] + r[2]) / 2, (r[1] + r[3]) / 2);
    crate::watch::monitors()
        .into_iter()
        .map(|(_, m, s, _)| ([m[0] as i32, m[1] as i32, (m[0] + m[2]) as i32, (m[1] + m[3]) as i32], s))
        .min_by_key(|(m, _)| (c.0 - c.0.clamp(m[0], m[2])).abs() + (c.1 - c.1.clamp(m[1], m[3])).abs())
        .unwrap_or(([0, 0, 1920, 1080], 1.0))
}

/// 꾸미기 켜짐/꺼짐에 맞춰 펫 창을 만들거나 파괴 (store 리스너 스레드에서)
pub fn sync(app: &AppHandle) {
    let on = crate::flag(app, "deco.enabled", false);
    let have = app.get_webview_window("pet");
    match (on, have) {
        (true, None) => {
            let Ok(win) = crate::overlay(app, "pet", "", SIZE) else { return };
            HWND_PET.store(crate::ui::hwnd(&win), Ordering::Relaxed);
            *LAST.lock().unwrap() = None;
            SHOWN.store(false, Ordering::Relaxed);
        }
        (false, Some(w)) => {
            HWND_PET.store(0, Ordering::Relaxed);
            crate::watch::remove_overlay("pet");
            let _ = w.destroy();
        }
        _ => {}
    }
}

/// watch 루프 (약 0.3초마다, 펫이 있을 때만): 자리 · 보이기 (바뀐 때만 옮기고 숨긴다). full = 전체화면 앱 중
pub fn tick(full: bool) {
    let h = HWND_PET.load(Ordering::Relaxed);
    if h == 0 {
        return;
    }
    let Some((bar, edge, tray, auto)) = taskbar() else { return };
    let (mon, s) = monitor_of(bar);
    let hidden = full || (auto && bar_hidden(bar, mon, edge));
    let key = (bar, (s * 100.0) as u32, tray);
    let hwnd = HWND(h as _);
    unsafe {
        if !hidden && *LAST.lock().unwrap() != Some(key) {
            *LAST.lock().unwrap() = Some(key);
            let r = pet_rect(bar, edge, tray, s);
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), r[0], r[1], r[2], r[3], SWP_NOACTIVATE);
        }
        if SHOWN.swap(!hidden, Ordering::Relaxed) == hidden {
            let _ = ShowWindow(hwnd, if hidden { SW_HIDE } else { SW_SHOWNOACTIVATE });
        }
        // 작업 표시줄을 누르면 그 위로 올라온다 → 가끔 다시 맨 위로 (SWP_NOMOVE, 바뀐 것 없으면 싸다)
        if !hidden {
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

/// 펫 누름 → 패널의 효과 메뉴 (펫 자리 쪽 모서리)
#[tauri::command]
pub fn pet_click(app: AppHandle) {
    let mut r = RECT::default();
    let h = HWND(HWND_PET.load(Ordering::Relaxed) as _);
    let at = unsafe { GetWindowRect(h, &mut r) }.ok().map(|_| (((r.left + r.right) / 2) as f64, ((r.top + r.bottom) / 2) as f64));
    crate::tray::toggle(&app, at, "fx");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pet_sits_inside_the_taskbar_next_to_the_tray() {
        // 아래 작업 표시줄 1920×1080 (높이 48), 트레이 1700..1880 → 트레이 왼쪽 8px, 두께 가운데 (위아래 3px)
        let r = pet_rect([0, 1032, 1920, 1080], Edge::Bottom, [1700, 1032, 1880, 1080], 1.0);
        assert_eq!(r, [1700 - 8 - 48, 1035, 48, 42]);
        assert!(r[1] >= 1032 && r[1] + r[3] <= 1080, "작업 표시줄 밖으로 나가지 않는다");
        // 위
        let r = pet_rect([0, 0, 1920, 48], Edge::Top, [1700, 0, 1880, 48], 1.0);
        assert_eq!((r[1], r[0] + r[2]), (3, 1692));
        // 왼쪽 세로 (폭 62), 트레이 = 아래
        let r = pet_rect([0, 0, 62, 1080], Edge::Left, [0, 900, 62, 1080], 1.0);
        assert_eq!((r[0], r[1] + r[3]), (7, 892));
        // 오른쪽 세로
        let r = pet_rect([1858, 0, 1920, 1080], Edge::Right, [1858, 900, 1920, 1080], 1.0);
        assert_eq!(r[0], 1865);
        // 150%: 크기·간격도 1.5배
        let r = pet_rect([0, 2088, 3840, 2160], Edge::Bottom, [3500, 2088, 3800, 2160], 1.5);
        assert_eq!(r, [3500 - 12 - 72, 2092, 72, 63]);
    }

    #[test]
    fn autohide_taskbar_hidden_when_slid_off() {
        let mon = [0, 0, 1920, 1080];
        assert!(!bar_hidden([0, 1032, 1920, 1080], mon, Edge::Bottom)); // 보임
        assert!(bar_hidden([0, 1078, 1920, 1126], mon, Edge::Bottom)); // 2px 만 남음
        assert!(bar_hidden([0, -46, 1920, 2], mon, Edge::Top));
        assert!(!bar_hidden([0, 0, 1920, 48], mon, Edge::Top));
        assert!(bar_hidden([-60, 0, 2, 1080], mon, Edge::Left));
        assert!(bar_hidden([1918, 0, 1980, 1080], mon, Edge::Right));
        assert!(!bar_hidden([1858, 0, 1920, 1080], mon, Edge::Right));
    }
}
