// 단일 watch 루프 (스레드 1개): 30Hz 커서 히트테스트·포그라운드 / 2s 실행 집합·전체화면·배경화면·작업 영역.
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{w, PCWSTR, PWSTR};
use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
use windows::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUERY_USER_NOTIFICATION_STATE, QUNS_BUSY, QUNS_PRESENTATION_MODE,
    QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::*;

/// 창별 히트 rect: (라벨, [x, y, w, h] 클라이언트 기준 물리 px). JS `reportHitRects` 가 갱신.
static HITS: Mutex<Vec<(String, Vec<[f64; 4]>)>> = Mutex::new(Vec::new());

pub fn set_rects(label: &str, rects: Vec<[f64; 4]>) {
    let mut h = HITS.lock().unwrap();
    match h.iter_mut().find(|(l, _)| l == label) {
        Some(e) => e.1 = rects,
        None => h.push((label.to_string(), rects)),
    }
}

/// B3: 포그라운드 앱 (= Now Playing 곡). aumid 는 UWP/패키지 앱만.
#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fg {
    hwnd: isize,
    pid: u32,
    exe_path: String,
    title: String,
    aumid: String,
}

/// 마지막 포그라운드 + 실행 집합 — 늦게 뜬 창(패널 등)이 `watch_state` 로 즉시 가져간다.
pub static STATE: Mutex<(Option<Fg>, Vec<String>)> = Mutex::new((None, Vec::new()));

unsafe fn wstr(buf: &[u16]) -> String {
    String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())])
}

/// (exe 경로, 패키지 AUMID) — 패키지 앱(Win11 메모장 등)은 프로세스에서 AUMID 를 얻는다.
unsafe fn proc_info(pid: u32) -> (String, String) {
    let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return Default::default() };
    let mut buf = [0u16; 1024];
    let mut n = buf.len() as u32;
    let exe = if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut n).is_ok() { wstr(&buf[..n as usize]) } else { String::new() };
    let mut n = buf.len() as u32;
    let aumid = if GetApplicationUserModelId(h, &mut n, Some(PWSTR(buf.as_mut_ptr()))).is_ok() { wstr(&buf) } else { String::new() };
    let _ = CloseHandle(h);
    (exe, aumid)
}

/// 창의 AUMID (PKEY_AppUserModel_ID) — UWP 의 ApplicationFrameHost 창은 여기에 앱 AUMID 가 있다.
unsafe fn window_aumid(hwnd: HWND) -> String {
    SHGetPropertyStoreForWindow::<IPropertyStore>(hwnd)
        .and_then(|s| s.GetValue(&PKEY_AppUserModel_ID))
        .map(|v| v.to_string())
        .unwrap_or_default()
}

pub unsafe fn info(hwnd: HWND) -> Fg {
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let (exe_path, pkg) = proc_info(pid);
    let mut buf = [0u16; 512];
    let n = GetWindowTextW(hwnd, &mut buf) as usize;
    let aumid = Some(window_aumid(hwnd)).filter(|a| !a.is_empty()).unwrap_or(pkg);
    Fg { hwnd: hwnd.0 as isize, pid, exe_path, title: wstr(&buf[..n]), aumid }
}

/// 실행 집합: 보이는 최상위 앱 창(소유자 없음, 툴윈도우·클로킹 제외)의 exe 경로·`shell:appsfolder\<aumid>` (소문자)
pub unsafe fn running(me: u32) -> Vec<String> {
    unsafe extern "system" fn collect(h: HWND, l: LPARAM) -> BOOL {
        (*(l.0 as *mut Vec<HWND>)).push(h);
        true.into()
    }
    let mut all: Vec<HWND> = vec![];
    let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut _ as isize));
    let mut keys = vec![];
    for h in all {
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), 4);
        if !IsWindowVisible(h).as_bool()
            || cloaked != 0
            || GetWindow(h, GW_OWNER).is_ok_and(|o| !o.is_invalid())
            || GetWindowLongPtrW(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW.0 as isize != 0
            || GetWindowTextLengthW(h) == 0
        {
            continue;
        }
        let i = info(h);
        if i.pid == me {
            continue;
        }
        if !i.aumid.is_empty() {
            keys.push(format!(r"shell:appsfolder\{}", i.aumid).to_lowercase());
        }
        if !i.exe_path.is_empty() {
            keys.push(i.exe_path.to_lowercase());
        }
    }
    keys.sort();
    keys.dedup();
    keys
}

/// 커서(클라이언트 기준 물리 px)가 모양 rect 중 하나 안에 있는가.
fn hit(x: f64, y: f64, rects: &[[f64; 4]]) -> bool {
    rects.iter().any(|r| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3])
}

/// 원하는 확장 스타일. tao 는 자기 플래그로 GWL_EXSTYLE 을 통째로 다시 쓰므로(show/hide 등)
/// TOOLWINDOW 를 지우고 APPWINDOW 를 되살린다 → 매 틱 비교해 다를 때만 쓴다.
/// 클릭 통과 = TRANSPARENT|LAYERED (tao 의 set_ignore_cursor_events 와 같은 비트).
fn ex_style(cur: isize, pass: bool) -> isize {
    let through = (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize;
    let base = (cur | (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) as isize) & !(WS_EX_APPWINDOW.0 as isize);
    if pass { base | through } else { base & !through }
}

fn fullscreen(s: QUERY_USER_NOTIFICATION_STATE) -> bool {
    s == QUNS_BUSY || s == QUNS_RUNNING_D3D_FULL_SCREEN || s == QUNS_PRESENTATION_MODE
}

pub fn wallpaper_path() -> String {
    let mut buf = [0u16; 260];
    unsafe {
        let _ = SystemParametersInfoW(SPI_GETDESKWALLPAPER, buf.len() as u32, Some(buf.as_mut_ptr().cast()), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0));
    }
    String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(0)])
}

fn reg_sz(key: PCWSTR, value: PCWSTR) -> String {
    let mut buf = [0u16; 64];
    let mut len = (buf.len() * 2) as u32;
    let ok = unsafe { RegGetValueW(HKEY_CURRENT_USER, key, value, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut len)) };
    if ok.is_err() {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(0)])
}

/// 배경화면 배치 ("10"=채우기, "6"=맞춤, "2"=늘이기, …)와 여백 색("r g b")
pub fn wallpaper_style() -> (String, String) {
    (reg_sz(w!(r"Control Panel\Desktop"), w!("WallpaperStyle")), reg_sz(w!(r"Control Panel\Colors"), w!("Background")))
}

fn work_area() -> [i32; 4] {
    let mut r = RECT::default();
    unsafe {
        let _ = SystemParametersInfoW(SPI_GETWORKAREA, 0, Some((&mut r as *mut RECT).cast()), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0));
    }
    [r.left, r.top, r.right, r.bottom]
}

/// overlays: (라벨, HWND as isize) — dock, island. HWND 는 Send 가 아니라 isize 로 넘긴다.
pub fn start(app: AppHandle, overlays: Vec<(&'static str, isize)>) {
    std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED); // SHGetPropertyStoreForWindow
        let me = GetCurrentProcessId();
        let mut prev_lb = false;
        let mut drag_out = false; // 창 밖에서 누른 채 들어오는 드래그(탐색기 파일 등)
        let mut last_fg = HWND::default();
        let mut prev_fg = HWND::default(); // 마지막 외부(비 Hera) 포그라운드
        let mut hidden = false;
        let mut wall = (wallpaper_path(), wallpaper_style());
        let mut wa = work_area();
        let mut slow = Instant::now();

        loop {
            // ── 30Hz: 커서 히트테스트 → 클릭 통과 ──
            let mut pt = POINT::default();
            let _ = GetCursorPos(&mut pt);
            let lb = GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0;
            let rects: Vec<RECT> = overlays
                .iter()
                .map(|&(_, h)| {
                    let mut r = RECT::default();
                    let _ = GetWindowRect(HWND(h as _), &mut r);
                    r
                })
                .collect();
            let inside = |r: &RECT| pt.x >= r.left && pt.x < r.right && pt.y >= r.top && pt.y < r.bottom;
            if lb && !prev_lb {
                drag_out = !rects.iter().any(inside);
            } else if !lb {
                drag_out = false;
            }
            prev_lb = lb;

            let hits = HITS.lock().unwrap().clone();
            for (i, &(label, h)) in overlays.iter().enumerate() {
                let r = &rects[i];
                let shape = hits.iter().find(|(l, _)| l == label).map(|(_, v)| v.as_slice()).unwrap_or(&[]);
                let over = hit((pt.x - r.left) as f64, (pt.y - r.top) as f64, shape);
                let p = !(over || (drag_out && inside(r)));
                let hwnd = HWND(h as _);
                let cur = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                let want = ex_style(cur, p);
                if want != cur {
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
                }
            }

            // ── 포그라운드: 자기 창 무시, dock/island(WebView2 자식 포함)가 가져가면 직전 창으로 복원 ──
            let fg = GetForegroundWindow();
            if fg != last_fg {
                last_fg = fg;
                let mut pid = 0;
                GetWindowThreadProcessId(fg, Some(&mut pid));
                if pid == me {
                    let root = GetAncestor(fg, GA_ROOT);
                    if overlays.iter().any(|&(_, h)| HWND(h as _) == root) && !prev_fg.is_invalid() && IsWindow(Some(prev_fg)).as_bool() {
                        let _ = SetForegroundWindow(prev_fg);
                    }
                } else if !fg.is_invalid() {
                    prev_fg = fg;
                    // B3: Now Playing. 제목 없는 창(작업표시줄 등 일시 포커스)은 곡으로 치지 않는다.
                    let i = info(fg);
                    if !i.title.is_empty() {
                        STATE.lock().unwrap().0 = Some(i.clone());
                        let _ = app.emit("foreground", i);
                    }
                }
            }

            // ── 2s ──
            if slow.elapsed() >= Duration::from_secs(2) {
                slow = Instant::now();
                let full = SHQueryUserNotificationState().map(fullscreen).unwrap_or(false);
                if full != hidden {
                    hidden = full;
                    for &(_, h) in &overlays {
                        let _ = ShowWindowAsync(HWND(h as _), if full { SW_HIDE } else { SW_SHOWNOACTIVATE });
                    }
                }
                // B3: 실행 인디케이터. ponytail: 2s 폴링 — 지연이 거슬리면 주기 단축
                let r = running(me);
                let mut st = STATE.lock().unwrap();
                if r != st.1 {
                    st.1 = r.clone();
                    let _ = app.emit("running", r);
                }
                drop(st);
                let w = (wallpaper_path(), wallpaper_style());
                if w != wall {
                    wall = w;
                    let _ = app.emit("wallpaper", ());
                }
                let a = work_area();
                if a != wa {
                    wa = a;
                    crate::place(&app);
                }
            }

            std::thread::sleep(Duration::from_millis(33));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hit_test() {
        let dot = [[396.0, 150.0, 168.0, 30.0]];
        assert!(hit(480.0, 160.0, &dot));
        assert!(!hit(100.0, 160.0, &dot)); // 투명 여유 영역
        assert!(!hit(564.0, 160.0, &dot)); // 오른쪽 경계는 제외
        assert!(!hit(480.0, 160.0, &[]));
    }

    #[test]
    fn ex_style_toggles_only_passthrough() {
        let app = WS_EX_APPWINDOW.0 as isize;
        let on = ex_style(app, true);
        assert_eq!(on & app, 0);
        assert_ne!(on & WS_EX_TOOLWINDOW.0 as isize, 0);
        assert_ne!(on & WS_EX_TRANSPARENT.0 as isize, 0);
        let off = ex_style(on, false);
        assert_eq!(off & (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize, 0);
        assert_ne!(off & WS_EX_NOACTIVATE.0 as isize, 0);
        assert_eq!(ex_style(off, false), off); // 변화 없으면 같은 값 → SetWindowLongPtr 생략
    }

    /// 수동(계산기를 띄웠다 닫음): cargo test running_and_aumid -- --ignored --nocapture
    #[test]
    #[ignore]
    fn running_and_aumid() {
        std::thread::spawn(|| crate::launch::launch(r"shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App")).join().unwrap().unwrap();
        std::thread::sleep(Duration::from_secs(3));
        let calc = r"shell:appsfolder\microsoft.windowscalculator_8wekyb3d8bbwe!app";
        let (keys, frame) = unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let keys = running(GetCurrentProcessId());
            // 포그라운드 이벤트가 쓰는 info(): 계산기의 ApplicationFrameHost 창에서 AUMID 가 풀리는가
            unsafe extern "system" fn collect(h: HWND, l: LPARAM) -> BOOL {
                (*(l.0 as *mut Vec<HWND>)).push(h);
                true.into()
            }
            let mut all: Vec<HWND> = vec![];
            let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut _ as isize));
            let frame = all.into_iter().map(|h| info(h)).find(|i| i.exe_path.to_lowercase().ends_with("applicationframehost.exe") && i.aumid.contains("Calculator"));
            (keys, frame)
        };
        let _ = std::process::Command::new("taskkill").args(["/IM", "CalculatorApp.exe", "/F"]).output();
        println!("RUNNING {keys:#?}\nFRAME {frame:?}");
        assert!(keys.iter().any(|k| k == calc), "calc not in running set");
        assert!(frame.is_some(), "calc frame AUMID not resolved");
    }

    #[test]
    fn fullscreen_states() {
        assert!(fullscreen(QUNS_BUSY) && fullscreen(QUNS_RUNNING_D3D_FULL_SCREEN) && fullscreen(QUNS_PRESENTATION_MODE));
        assert!(!fullscreen(windows::Win32::UI::Shell::QUNS_ACCEPTS_NOTIFICATIONS));
    }
}
