// 단일 watch 루프 (스레드 1개): 30Hz 커서 히트테스트·포그라운드 / 2s 실행 집합·전체화면·알림·배경화면·작업 영역.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;
use windows::core::{w, PCWSTR, PWSTR};
use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
use windows::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
use windows::Win32::System::SystemInformation::{GetLocalTime, GetTickCount};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO, VK_LBUTTON};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUERY_USER_NOTIFICATION_STATE, QUNS_BUSY, QUNS_NOT_PRESENT, QUNS_PRESENTATION_MODE,
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
    pub(crate) pid: u32,
    pub(crate) exe_path: String,
    title: String,
    pub(crate) aumid: String,
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

/// 작업 표시줄에 뜨는 앱 창(shell::eligible — Explorer 규칙, 자기 프로세스 제외) → (창, 키들). 키 = exe 경로·`shell:appsfolder\<aumid>` (소문자). z-순서(위→아래).
unsafe fn app_windows(me: u32) -> Vec<(HWND, Vec<String>)> {
    unsafe extern "system" fn collect(h: HWND, l: LPARAM) -> BOOL {
        (*(l.0 as *mut Vec<HWND>)).push(h);
        true.into()
    }
    let mut all: Vec<HWND> = vec![];
    let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut _ as isize));
    let mut out = vec![];
    for h in all {
        if !crate::shell::eligible_hwnd(h) {
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

/// C1 플래터 클릭: 키가 맞는 가장 위의 앱 창을 전면으로 (최소화면 복원). 사용자 클릭 직후라 SetForegroundWindow 가 허용된다.
/// `launch::sta` 스레드에서 부를 것 (창 AUMID 조회 = COM).
pub fn activate(keys: &[String]) -> Result<(), String> {
    let h = unsafe {
        let Some((h, _)) = app_windows(GetCurrentProcessId()).into_iter().find(|(_, ks)| ks.iter().any(|k| keys.contains(k))) else {
            return Err("실행 중인 창이 없어요".into());
        };
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        h
    };
    focus(h)
}

/// 창을 전면으로 (사용자 클릭 직후라 허용된다). 포그라운드 잠금이면 입력 큐에 잠깐 붙어 1회 재시도 (키 입력 주입 없음).
pub fn focus(h: HWND) -> Result<(), String> {
    unsafe {
        if SetForegroundWindow(h).as_bool() {
            return Ok(());
        }
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

/// 모니터 목록: (장치 이름, [x, y, w, h] 물리 px, 배율, 주 모니터) — Hera Link 배치·리플·가장자리 띠
pub fn monitors() -> Vec<(String, [f64; 4], f64, bool)> {
    use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW};
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    unsafe extern "system" fn collect(m: HMONITOR, _: HDC, _: *mut RECT, l: LPARAM) -> BOOL {
        let mut mi = MONITORINFOEXW::default();
        mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(m, &mut mi.monitorInfo).as_bool() {
            let (mut dx, mut dy) = (96u32, 96u32);
            let _ = GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
            let r = mi.monitorInfo.rcMonitor;
            let name = wstr(&mi.szDevice).trim_start_matches(r"\\.\").to_string();
            (*(l.0 as *mut Vec<(String, [f64; 4], f64, bool)>)).push((name, [r.left as f64, r.top as f64, (r.right - r.left) as f64, (r.bottom - r.top) as f64], dx as f64 / 96.0, mi.monitorInfo.dwFlags & 1 != 0));
        }
        true.into()
    }
    let mut v = vec![];
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut v as *mut _ as isize));
    }
    v
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
    // Hera Link: 알림은 커서가 있는 PC 에서만. 커서가 맥에 있으면 맥 Hera 가 울리고, 여기선 울린 것으로 표시만 (돌아와서 또 울리지 않게)
    let here = !crate::link::status().on_peer;
    for a in due_alarms(now, &items, &old) {
        if here {
            let _ = app.emit_to("island", "alarm", a);
        }
        fired.push(a.fire_key());
    }
    if fired != old {
        s.set("alarm.fired", serde_json::json!(fired));
    }
}

/// 전체화면 앱·발표 중 (2s 갱신) — 효과 창은 이때 만들지 않는다
pub static FULLSCREEN: AtomicBool = AtomicBool::new(false);

/// v2 자리 비움 화면보호기: 입력 없이 idle_min 분 지남 + 막힘(전체화면·잠금) 아님 + 아스키 창 없음. 0분 = 끔.
/// 재무장은 따로 없다 — 닫힘은 입력으로만 일어나고 입력이 idle 을 0 으로 되돌린다.
fn saver_due(idle_ms: u32, idle_min: u64, blocked: bool, open: bool) -> bool {
    idle_min > 0 && !blocked && !open && idle_ms as u64 >= idle_min * 60_000
}

/// v2 효과 시간대: 일출·일몰(현지 분)로 — 새벽 = 일출 −30분~+60분, 노을 = 일몰 −30분~+40분, 밤 = 일몰 +40분~일출 −30분
#[derive(Clone, Copy, PartialEq, Debug)]
enum Tod {
    Day,
    Dawn,
    Sunset,
    Night,
}

/// 해를 못 구할 때(극야·백야) 쓰는 일출 05:30 / 일몰 17:30
const SUN_FALLBACK: (i32, i32) = (330, 1050);

fn tod(min: i32, (rise, set): (i32, i32)) -> Tod {
    if min >= rise - 30 && min < rise + 60 {
        Tod::Dawn
    } else if min >= set - 30 && min < set + 40 {
        Tod::Sunset
    } else if min >= rise + 60 && min < set - 30 {
        Tod::Day
    } else {
        Tod::Night
    }
}

/// 1월 1일 = 1
fn day_of_year(y: i32, m: u32, d: u32) -> u32 {
    const CUM: [u32; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    CUM[(m as usize - 1).min(11)] + d + (leap && m > 2) as u32
}

/// NOAA 일출·일몰 (General Solar Position 근사식, 대기 굴절 0.833°) → 현지 시각(분). 극야/백야 = None.
fn sun_times(lat: f64, lon: f64, doy: u32, tz_min: i32) -> Option<(i32, i32)> {
    let g = std::f64::consts::TAU / 365.0 * (doy as f64 - 1.0);
    let eq = 229.18 * (0.000075 + 0.001868 * g.cos() - 0.032077 * g.sin() - 0.014615 * (2.0 * g).cos() - 0.040849 * (2.0 * g).sin());
    let decl = 0.006918 - 0.399912 * g.cos() + 0.070257 * g.sin() - 0.006758 * (2.0 * g).cos() + 0.000907 * (2.0 * g).sin() - 0.002697 * (3.0 * g).cos()
        + 0.00148 * (3.0 * g).sin();
    let la = lat.to_radians();
    let c = 90.833f64.to_radians().cos() / (la.cos() * decl.cos()) - la.tan() * decl.tan();
    if !(-1.0..=1.0).contains(&c) {
        return None;
    }
    let ha = c.acos().to_degrees();
    let at = |h: f64| (720.0 - 4.0 * (lon + h) - eq + tz_min as f64).round() as i32;
    Some((at(ha), at(-ha)))
}

/// 현지 표준시/일광 절약 시간 오프셋(분, UTC+9 = 540)
fn tz_offset() -> i32 {
    use windows::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
    let mut z = TIME_ZONE_INFORMATION::default();
    let r = unsafe { GetTimeZoneInformation(&mut z) };
    -(z.Bias + if r == 2 { z.DaylightBias } else { z.StandardBias })
}

/// 날씨 글자(JS 가 store `fx.weather` 에 씀) → 0 맑음/흐림, 1 비, 2 눈
fn wet(text: &str) -> u8 {
    match text {
        "비" => 1,
        "눈" => 2,
        _ => 0,
    }
}

/// 계절 첫날 효과 (가을 = 단풍, 겨울 = 눈). 봄·여름은 맞는 효과가 없어 없음.
fn season_fx(month: u16, day: u16) -> Option<&'static str> {
    match (month, day) {
        (9, 1) => Some("leaves"),
        (12, 1) => Some("snow"),
        _ => None,
    }
}

/// 효과 이벤트 판정: 날씨 변화(비·눈 시작) > 계절 첫날(하루 1회, 미표시면 대기) > 시간대 변화. 시작 직후(prev 없음)엔 계절만.
fn fx_trigger(prev: Option<(Tod, u8)>, cur: (Tod, u8), season: Option<&'static str>) -> Option<&'static str> {
    let Some((pt, pw)) = prev else { return season };
    if cur.1 != pw && cur.1 != 0 {
        return Some(if cur.1 == 1 { "rain" } else { "snow" });
    }
    if season.is_some() {
        return season;
    }
    if cur.0 == pt {
        return None;
    }
    match cur.0 {
        Tod::Dawn => Some("dawn"),
        Tod::Sunset => Some("sunset"),
        Tod::Night => Some("moon"),
        Tod::Day => None,
    }
}

/// 커서 찾기: 마우스를 빠르게 좌우(또는 위아래)로 흔들면 커서 둘레에 파란 물결.
/// 30Hz 커서 표본으로 판정 (전역 저수준 훅 없음): 500ms 안에 방향 전환 ≥ 4번, 각 구간 이동 ≥ min_travel px, 발동 후 1.5초 쉼.
#[derive(Default)]
pub struct Shake {
    pts: std::collections::VecDeque<(u64, i32, i32)>,
    last_fire: Option<u64>,
}

impl Shake {
    pub fn push(&mut self, t: u64, x: i32, y: i32, min_travel: i32) -> bool {
        self.pts.push_back((t, x, y));
        while self.pts.front().is_some_and(|p| p.0 > t || t - p.0 > 500) {
            self.pts.pop_front();
        }
        if self.last_fire.is_some_and(|l| t.saturating_sub(l) < 1500) {
            return false;
        }
        let rev = |axis: fn(&(u64, i32, i32)) -> i32| {
            let (mut n, mut dir, mut run) = (0, 0i32, 0i32);
            for w in self.pts.iter().collect::<Vec<_>>().windows(2) {
                let d = axis(w[1]) - axis(w[0]);
                if d == 0 {
                    continue;
                }
                if dir != 0 && d.signum() != dir {
                    if run.abs() >= min_travel {
                        n += 1;
                    }
                    run = 0;
                }
                dir = d.signum();
                run += d;
            }
            n
        };
        if rev(|p| p.1).max(rev(|p| p.2)) >= 4 {
            self.last_fire = Some(t);
            self.pts.clear();
            return true;
        }
        false
    }
}

/// 트레이 '날씨·계절 효과' 체크 항목 (패널에서 바꾸면 watch 루프가 맞춰 준다)
pub struct FxMenu(pub tauri::menu::CheckMenuItem<tauri::Wry>);

fn last_input() -> u32 {
    let mut li = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe {
        let _ = GetLastInputInfo(&mut li);
    }
    li.dwTime
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
        let mut saver: Option<u32> = None; // 화면보호기로 연 아스키 창: 열 때의 마지막 입력 시각
        let mut saver_closing: Option<Instant> = None;
        let mut sky: Option<(Tod, u8)> = None;
        let mut season_shown = (0u16, 0u16);
        let mut fx_on: Option<bool> = None;
        let mut shake = Shake::default();
        let mut locator = true;
        let t0 = Instant::now();

        loop {
            // ── 30Hz: 커서 히트테스트 → 클릭 통과 ──
            let mut pt = POINT::default();
            let _ = GetCursorPos(&mut pt);
            let lb = GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0;
            // 커서 찾기 (커서가 이 PC 에 있을 때만 — 맥에 있으면 엔진이 커서를 붙잡아 둔다)
            if locator && !hidden && !crate::link::status().on_peer && shake.push(t0.elapsed().as_millis() as u64, pt.x, pt.y, 50) {
                crate::ripple::show(pt.x, pt.y, None, crate::ripple::Kind::Locate);
            }
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
            // Hera Link: 바깥에서 끌어오는 중이면 가장자리 띠를 받기 모드로 (근처일 때만)
            crate::edge::tick(pt.x, pt.y, drag_out);

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

            // 화면보호기: 열린 뒤 입력(마우스·키)이 있으면 닫기 — 창이 포커스가 없어도 키를 잡는다. JS 가 닫힘 애니메이션 후 파괴.
            if let Some(at) = saver {
                if last_input() != at {
                    saver = None;
                    saver_closing = Some(Instant::now());
                    let _ = app.emit_to("ascii", "ascii-close", ());
                }
            }

            // ── 2s ──
            if slow.elapsed() >= Duration::from_secs(2) {
                slow = Instant::now();
                let qs = SHQueryUserNotificationState().ok();
                let full = qs.is_some_and(fullscreen);
                let away = qs == Some(QUNS_NOT_PRESENT); // 잠금·화면보호기·사용자 전환
                FULLSCREEN.store(full, Ordering::Relaxed);
                // 화면보호기 열기/정리. 잠기면 바로 파괴(메모리 0), 닫기 요청 후 3초 지나도 남아 있으면 파괴.
                if let Some(w) = app.get_webview_window("ascii") {
                    if (away && saver.is_some()) || saver_closing.is_some_and(|t| t.elapsed() > Duration::from_secs(3)) {
                        let _ = w.destroy();
                        saver = None;
                        saver_closing = None;
                    }
                } else {
                    saver_closing = None;
                    saver = None;
                    let idle_min = app.store("hera.json").ok().and_then(|s| s.get("ascii.idleMin")).and_then(|v| v.as_u64()).unwrap_or(10);
                    let li = last_input();
                    if saver_due(GetTickCount().wrapping_sub(li), idle_min, full || away, false) {
                        saver = Some(li);
                        let h = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = crate::open_ascii(&h, true, None) {
                                eprintln!("ascii saver: {e}");
                            }
                        });
                    }
                }
                // 효과 이벤트: 시간대·날씨·계절 첫날 변화 → 효과 창 (스위치 켜짐 + 전체화면·잠금 아님일 때만)
                if let Ok(s) = app.store("hera.json") {
                    locator = s.get("locator.enabled").and_then(|v| v.as_bool()).unwrap_or(true);
                    let on = s.get("fx.enabled").and_then(|v| v.as_bool()).unwrap_or(true);
                    if fx_on != Some(on) {
                        fx_on = Some(on);
                        if let Some(m) = app.try_state::<FxMenu>() {
                            let _ = m.0.set_checked(on);
                        }
                    }
                    let lt = GetLocalTime();
                    let w = s.get("fx.weather");
                    // 도시 좌표(JS 가 지오코딩해 store `fx.coords` = [위도, 경도]), 없으면 서울
                    let (lat, lon) = s.get("fx.coords").and_then(|v| serde_json::from_value::<(f64, f64)>(v).ok()).unwrap_or((37.57, 126.98));
                    let sun = sun_times(lat, lon, day_of_year(lt.wYear as i32, lt.wMonth as u32, lt.wDay as u32), tz_offset()).unwrap_or(SUN_FALLBACK);
                    let cur = (tod(lt.wHour as i32 * 60 + lt.wMinute as i32, sun), wet(w.as_ref().and_then(|w| w["text"].as_str()).unwrap_or_default()));
                    let today = (lt.wMonth, lt.wDay);
                    let season = season_fx(lt.wMonth, lt.wDay).filter(|_| season_shown != today);
                    if let Some(kind) = fx_trigger(sky, cur, season) {
                        if on && !full && !away && app.get_webview_window("fx").is_none() {
                            if season == Some(kind) {
                                season_shown = today;
                            }
                            let h = app.clone();
                            tauri::async_runtime::spawn(async move {
                                if let Err(e) = crate::open_fx(&h, kind) {
                                    eprintln!("fx: {e}");
                                }
                            });
                        }
                    }
                    sky = Some(cur);
                }
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
                // B3 실행 집합은 shell.rs 가 창 이벤트로 갱신한다 (예전 2s EnumWindows 폴링 대체)
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
            let keys: Vec<String> = app_windows(GetCurrentProcessId()).into_iter().flat_map(|(_, k)| k).collect();
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
    fn shake_detector() {
        // 30Hz 로 좌우 120px 를 약 70ms 마다 왕복 → 500ms 안에 방향 전환 4번 이상 → 발동
        let shake_at = |s: &mut Shake, start: u64, amp: i32, half_period: u64| {
            let mut fired = false;
            for i in 0..30u64 {
                let t = start + i * 33;
                let phase = (t - start) / half_period;
                let x = if phase.is_multiple_of(2) { 500 + amp } else { 500 - amp };
                fired |= s.push(t, x, 300, 50);
            }
            fired
        };
        assert!(shake_at(&mut Shake::default(), 0, 120, 70));
        // 느린 왕복(250ms마다)은 500ms 안에 전환이 모자라 안 됨
        assert!(!shake_at(&mut Shake::default(), 0, 120, 250));
        // 작은 떨림(±10px)은 이동 거리 부족
        assert!(!shake_at(&mut Shake::default(), 0, 10, 70));
        // 그냥 한 방향으로 쭉 이동은 안 됨
        let mut s = Shake::default();
        assert!(!(0..30).any(|i| s.push(i * 33, 100 + i as i32 * 40, 300, 50)));
        // 발동 후 1.5초는 쉼, 그 뒤 다시 가능
        let mut s = Shake::default();
        assert!(shake_at(&mut s, 0, 120, 70));
        assert!(!shake_at(&mut s, 400, 120, 70)); // 400~1357ms: 쉬는 중
        assert!(shake_at(&mut s, 3000, 120, 70));
    }

    #[test]
    fn saver_rules() {
        let min = 60_000;
        assert!(saver_due(10 * min, 10, false, false));
        assert!(!saver_due(10 * min - 1, 10, false, false)); // 아직
        assert!(!saver_due(99 * min, 0, false, false)); // 0분 = 끔
        assert!(!saver_due(99 * min, 10, true, false)); // 전체화면·잠금
        assert!(!saver_due(99 * min, 10, false, true)); // 이미 아스키 창
    }

    #[test]
    fn fx_rules() {
        let sun = (311, 1197); // 서울 하지
        let t = |h: i32, m: i32| tod(h * 60 + m, sun);
        assert_eq!((t(4, 40), t(4, 41), t(6, 10), t(6, 11), t(19, 26), t(19, 27), t(20, 36), t(20, 37), t(0, 0)), (
            Tod::Night, Tod::Dawn, Tod::Dawn, Tod::Day, Tod::Day, Tod::Sunset, Tod::Sunset, Tod::Night, Tod::Night
        ));
        let day = (Tod::Day, 0);
        // 시작 직후: 시간대·날씨로는 안 뜸, 계절 첫날만
        assert_eq!(fx_trigger(None, (Tod::Sunset, 1), None), None);
        assert_eq!(fx_trigger(None, day, Some("leaves")), Some("leaves"));
        assert_eq!(fx_trigger(Some(day), day, None), None);
        // 시간대 변화
        assert_eq!(fx_trigger(Some(day), (Tod::Sunset, 0), None), Some("sunset"));
        assert_eq!(fx_trigger(Some((Tod::Sunset, 0)), (Tod::Night, 0), None), Some("moon"));
        assert_eq!(fx_trigger(Some((Tod::Night, 0)), (Tod::Dawn, 0), None), Some("dawn"));
        assert_eq!(fx_trigger(Some((Tod::Dawn, 0)), day, None), None);
        // 날씨: 비·눈 '시작' 만 (그침은 없음), 날씨가 시간대보다 먼저
        assert_eq!(fx_trigger(Some(day), (Tod::Sunset, 2), None), Some("snow"));
        assert_eq!(fx_trigger(Some((Tod::Day, 2)), (Tod::Day, 1), None), Some("rain"));
        assert_eq!(fx_trigger(Some((Tod::Day, 1)), day, None), None);
        // 계절 첫날은 시간대보다 먼저 (보여 줄 때까지 계속 나온다 — 호출자가 보여 준 뒤 끔)
        assert_eq!(fx_trigger(Some(day), (Tod::Sunset, 0), Some("snow")), Some("snow"));
        assert_eq!((season_fx(9, 1), season_fx(12, 1), season_fx(3, 1), season_fx(9, 2)), (Some("leaves"), Some("snow"), None, None));
        assert_eq!((wet("비"), wet("눈"), wet("흐림"), wet("")), (1, 2, 0, 0));
    }

    #[test]
    fn sun_seoul() {
        // 서울 2026-06-21: 일출 ≈ 05:11, 일몰 ≈ 19:57 KST (±5분)
        let doy = day_of_year(2026, 6, 21);
        assert_eq!(doy, 172);
        let (rise, set) = sun_times(37.57, 126.98, doy, 540).unwrap();
        assert!((rise - 311).abs() <= 5, "rise {rise}");
        assert!((set - 1197).abs() <= 5, "set {set}");
        // 동지: 07:43 / 17:17 근처
        let (rise, set) = sun_times(37.57, 126.98, day_of_year(2026, 12, 21), 540).unwrap();
        assert!((rise - 463).abs() <= 6 && (set - 1037).abs() <= 6, "{rise} {set}");
        assert_eq!(day_of_year(2024, 3, 1), 61); // 윤년
        // 백야(북극권 하지) = None → SUN_FALLBACK
        assert!(sun_times(78.2, 15.6, 172, 60).is_none());
    }

    #[test]
    fn fullscreen_states() {
        assert!(fullscreen(QUNS_BUSY) && fullscreen(QUNS_RUNNING_D3D_FULL_SCREEN) && fullscreen(QUNS_PRESENTATION_MODE));
        assert!(!fullscreen(windows::Win32::UI::Shell::QUNS_ACCEPTS_NOTIFICATIONS));
    }
}
