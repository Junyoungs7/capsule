// 단일 watch 루프 (스레드 1개): 30Hz 커서 히트테스트·포그라운드 / 2s 실행 집합·전체화면·알림·배경화면·작업 영역.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;
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

/// 클릭 통과·전체화면 숨김 대상 오버레이 창 (라벨, HWND as isize). dock/island 는 상시, turntable 은 보일 때만.
/// 루프가 매 틱 읽는다(창 핸들 조회를 메인 스레드에 보내지 않도록 생성 시 등록).
static OVERLAYS: Mutex<Vec<(&'static str, isize)>> = Mutex::new(Vec::new());

pub fn add_overlay(label: &'static str, hwnd: isize) {
    OVERLAYS.lock().unwrap().push((label, hwnd));
}

pub fn remove_overlay(label: &str) {
    OVERLAYS.lock().unwrap().retain(|(l, _)| *l != label);
    HITS.lock().unwrap().retain(|(l, _)| l != label);
}

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

/// 보이는 최상위 앱 창(소유자 없음, 툴윈도우·클로킹 제외, 자기 프로세스 제외) → (창, 키들). 키 = exe 경로·`shell:appsfolder\<aumid>` (소문자). z-순서(위→아래).
unsafe fn app_windows(me: u32) -> Vec<(HWND, Vec<String>)> {
    unsafe extern "system" fn collect(h: HWND, l: LPARAM) -> BOOL {
        (*(l.0 as *mut Vec<HWND>)).push(h);
        true.into()
    }
    let mut all: Vec<HWND> = vec![];
    let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut _ as isize));
    let mut out = vec![];
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
        let mut keys = vec![];
        if !i.aumid.is_empty() {
            keys.push(format!(r"shell:appsfolder\{}", i.aumid).to_lowercase());
        }
        if !i.exe_path.is_empty() {
            keys.push(i.exe_path.to_lowercase());
        }
        out.push((h, keys));
    }
    out
}

/// 실행 집합: 앱 창 키들의 합집합
pub unsafe fn running(me: u32) -> Vec<String> {
    let mut keys: Vec<String> = app_windows(me).into_iter().flat_map(|(_, k)| k).collect();
    keys.sort();
    keys.dedup();
    keys
}

/// C1 플래터 클릭: 키가 맞는 가장 위의 앱 창을 전면으로 (최소화면 복원). 사용자 클릭 직후라 SetForegroundWindow 가 허용된다.
/// `launch::sta` 스레드에서 부를 것 (창 AUMID 조회 = COM).
pub fn activate(keys: &[String]) -> Result<(), String> {
    unsafe {
        let Some((h, _)) = app_windows(GetCurrentProcessId()).into_iter().find(|(_, ks)| ks.iter().any(|k| keys.contains(k))) else {
            return Err("실행 중인 창이 없어요".into());
        };
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        if SetForegroundWindow(h).as_bool() {
            return Ok(());
        }
        // 포그라운드 잠금: 현재 포그라운드 스레드의 입력 큐에 잠깐 붙어 전환 후 1회 재시도 (키 입력 주입 없음)
        use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
        let (me, fg) = (GetCurrentThreadId(), GetWindowThreadProcessId(GetForegroundWindow(), None));
        let attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true).as_bool();
        let _ = BringWindowToTop(h);
        let ok = SetForegroundWindow(h).as_bool();
        if attached {
            let _ = AttachThreadInput(me, fg, false);
        }
        if ok { Ok(()) } else { Err("창을 앞으로 가져오지 못했어요".into()) }
    }
}

/// C4 배터리: (잔량 %, 충전 중). 배터리 없는 데스크톱·알 수 없음 → None (위젯 숨김)
pub fn power() -> Option<(u8, bool)> {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut s) }.ok()?;
    (s.BatteryFlag & 128 == 0 && s.BatteryFlag != 255 && s.BatteryLifePercent <= 100).then_some((s.BatteryLifePercent, s.ACLineStatus == 1))
}

/// 커서(클라이언트 기준 물리 px)가 모양 rect 중 하나를 사방 m px 넓힌 영역 안에 있는가.
fn hit(x: f64, y: f64, rects: &[[f64; 4]], m: f64) -> bool {
    rects.iter().any(|r| x >= r[0] - m && x < r[0] + r[2] + m && y >= r[1] - m && y < r[1] + r[3] + m)
}

/// 바깥에서 끌고 들어오는 드롭은 모양(+여유)에 닿을 때만 받는다 — 투명 여유 영역 아래 앱으로 가는 드롭은 통과.
const DRAG_MARGIN: f64 = 24.0;

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

/// B4 알림 1건. `at` = 발화 시각(epoch ms) = snooze ?? due(할 일) / start(일정).
#[derive(Clone, Serialize, PartialEq, Debug)]
pub struct Alarm {
    key: String, // store 키 (todo:<id> / event:<id>)
    title: String,
    at: i64,
    done: bool,
}

impl Alarm {
    /// 발화 키: 시각이 바뀌면(다시 알림·기한 수정) 새 키 → 다시 발화
    fn fire_key(&self) -> String {
        format!("{}@{}", self.key, self.at)
    }
}

/// island JS 가 'alarm' 리스너를 건 뒤 true — 그 전에는 발화하지 않는다(시작 직후 이벤트 유실 방지).
pub static ALARMS_READY: AtomicBool = AtomicBool::new(false);

/// `toISOString()` 형식(YYYY-MM-DDTHH:MM:SS[.sss]Z, UTC)만 → epoch ms. 그 외 형식은 None(알림 없음).
fn iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || !s.ends_with('Z') || b[4] != b'-' || b[10] != b'T' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let ms = if b[19] == b'.' { n(20..23)? } else { 0 };
    // days_from_civil (Howard Hinnant)
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    Some(((days * 24 + n(11..13)?) * 60 + n(14..16)?) * 60_000 + n(17..19)? * 1000 + ms)
}

/// store 항목 → 알림 후보 (todo:/event: 이고 시각이 있는 것)
fn alarm_item(key: &str, v: &Value) -> Option<Alarm> {
    let at = |f: &str| v[f].as_str().and_then(iso_ms);
    let base = if key.starts_with("todo:") { at("due") } else if key.starts_with("event:") { at("start") } else { None };
    Some(Alarm { key: key.into(), title: v["title"].as_str().unwrap_or_default().into(), at: at("snooze").or(base)?, done: v["done"].as_bool().unwrap_or(false) })
}

/// due 도달 + 미완료 + 미발화 → 발화 시각 순. 놓친 알림(절전·앱 종료 중)도 이 규칙으로 1회 나온다.
fn due_alarms<'a>(now: i64, items: &'a [Alarm], fired: &[String]) -> Vec<&'a Alarm> {
    let mut v: Vec<_> = items.iter().filter(|a| !a.done && a.at <= now && !fired.contains(&a.fire_key())).collect();
    v.sort_by_key(|a| a.at);
    v
}

/// 2s: 스토어 스캔 → 발화. 발화 집합은 store `alarm.fired` 에 저장(재시작 시 재발화 없음), 사라진 항목의 키는 정리.
fn check_alarms(app: &AppHandle) {
    let Ok(s) = app.store("hera.json") else { return };
    let items: Vec<Alarm> = s.entries().iter().filter_map(|(k, v)| alarm_item(k, v)).collect();
    let old: Vec<String> = s.get("alarm.fired").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let mut fired: Vec<String> = old.iter().filter(|k| items.iter().any(|a| &a.fire_key() == *k)).cloned().collect();
    for a in due_alarms(now, &items, &old) {
        let _ = app.emit_to("island", "alarm", a);
        fired.push(a.fire_key());
    }
    if fired != old {
        s.set("alarm.fired", serde_json::json!(fired));
    }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED); // SHGetPropertyStoreForWindow — 이 루프 전용 스레드라 아파트 혼용 없음
        let me = GetCurrentProcessId();
        let mut prev_lb = false;
        let mut drag_out = false; // 창 밖에서 누른 채 들어오는 드래그(탐색기 파일 등)
        let mut last_fg = HWND::default();
        let mut prev_fg = HWND::default(); // 마지막 외부(비 Hera) 포그라운드
        let mut hidden = false;
        let mut wall = (wallpaper_path(), wallpaper_style());
        let mut wa = work_area();
        let mut slow = Instant::now();
        let mut pow = power();

        loop {
            // ── 30Hz: 커서 히트테스트 → 클릭 통과 ──
            let mut pt = POINT::default();
            let _ = GetCursorPos(&mut pt);
            let lb = GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0;
            let overlays = OVERLAYS.lock().unwrap().clone();
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
                let (x, y) = ((pt.x - r.left) as f64, (pt.y - r.top) as f64);
                let p = !(hit(x, y, shape, 0.0) || (drag_out && hit(x, y, shape, DRAG_MARGIN)));
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
                // B4: 전체화면 중에는 검사하지 않는다 = 큐 보관. 종료 후 첫 검사에서 밀린 알림이 시각 순으로 나온다.
                if !hidden && ALARMS_READY.load(Ordering::Relaxed) {
                    check_alarms(&app);
                }
                // B3: 실행 인디케이터. ponytail: 2s 폴링 — 지연이 거슬리면 주기 단축
                let r = running(me);
                let mut st = STATE.lock().unwrap();
                if r != st.1 {
                    st.1 = r.clone();
                    let _ = app.emit("running", r);
                }
                drop(st);
                // C4: 전원 상태는 바뀔 때만 emit (JS 폴링 없음)
                let p = power();
                if p != pow {
                    pow = p;
                    let _ = app.emit("power", p);
                }
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

            // 전체화면으로 숨긴 동안은 2Hz (2s 블록은 그대로)
            std::thread::sleep(Duration::from_millis(if hidden { 500 } else { 33 }));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hit_test() {
        let dot = [[396.0, 150.0, 168.0, 30.0]];
        assert!(hit(480.0, 160.0, &dot, 0.0));
        assert!(!hit(100.0, 160.0, &dot, 0.0)); // 투명 여유 영역
        assert!(!hit(564.0, 160.0, &dot, 0.0)); // 오른쪽 경계는 제외
        assert!(!hit(480.0, 160.0, &[], 0.0));
        // 드래그 진입: 모양 +24px 까지만 받고, 그 밖의 투명 영역(아래 앱으로 갈 드롭)은 통과
        assert!(hit(380.0, 130.0, &dot, DRAG_MARGIN)); // 왼쪽 위 16/20px
        assert!(hit(587.0, 160.0, &dot, DRAG_MARGIN));
        assert!(!hit(588.0, 160.0, &dot, DRAG_MARGIN));
        assert!(!hit(100.0, 160.0, &dot, DRAG_MARGIN));
        assert!(!hit(480.0, 125.0, &dot, DRAG_MARGIN));
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
        crate::launch::sta(|| crate::launch::launch(r"shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App")).unwrap();
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

    fn al(key: &str, at: i64, done: bool) -> Alarm {
        Alarm { key: key.into(), title: String::new(), at, done }
    }

    #[test]
    fn iso_parse() {
        assert_eq!(iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(iso_ms("2026-11-13T09:30:00.250Z"), Some(1_794_562_200_250));
        assert_eq!(iso_ms("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
        assert_eq!(iso_ms("2026-11-13T09:30"), None); // 로컬 시각(Z 없음)은 무시
    }

    #[test]
    fn alarm_items() {
        let t = serde_json::json!({"title": "a", "due": "1970-01-01T00:00:01.000Z", "done": false});
        assert_eq!(alarm_item("todo:1", &t).unwrap().at, 1000);
        let snoozed = serde_json::json!({"title": "a", "due": "1970-01-01T00:00:01.000Z", "snooze": "1970-01-01T00:00:02.000Z"});
        assert_eq!(alarm_item("todo:1", &snoozed).unwrap().at, 2000); // 다시 알림이 기한보다 우선
        let ev = serde_json::json!({"title": "e", "start": "1970-01-01T00:00:03.000Z", "end": "1970-01-01T01:00:00.000Z"});
        assert_eq!(alarm_item("event:1", &ev).unwrap().at, 3000);
        assert!(alarm_item("todo:2", &serde_json::json!({"title": "기한 없음"})).is_none());
        assert!(alarm_item("record:x", &t).is_none());
    }

    #[test]
    fn due_rules() {
        let now = 10_000;
        let items = [al("todo:future", 20_000, false), al("todo:due", 9_000, false), al("event:missed", 1_000, false), al("todo:done", 5_000, true), al("todo:fired", 8_000, false)];
        let fired = vec!["todo:fired@8000".to_string()];
        let keys: Vec<_> = due_alarms(now, &items, &fired).iter().map(|a| a.key.as_str()).collect();
        // 놓친 알림(오래전) 포함, 시각 순 / 미래·완료·이미 발화 제외
        assert_eq!(keys, ["event:missed", "todo:due"]);
        // 다시 알림: 시각이 +10분 바뀌면 새 발화 키 → 그 시각 전엔 조용, 도달하면 다시 발화
        let snoozed = [al("todo:fired", 8_000 + 600_000, false)];
        assert!(due_alarms(now, &snoozed, &fired).is_empty());
        assert_eq!(due_alarms(8_000 + 600_000, &snoozed, &fired).len(), 1);
        // 정각 경계 포함
        assert_eq!(due_alarms(20_000, &items[..1], &[]).len(), 1);
    }

    #[test]
    fn fullscreen_states() {
        assert!(fullscreen(QUNS_BUSY) && fullscreen(QUNS_RUNNING_D3D_FULL_SCREEN) && fullscreen(QUNS_PRESENTATION_MODE));
        assert!(!fullscreen(windows::Win32::UI::Shell::QUNS_ACCEPTS_NOTIFICATIONS));
    }
}
