// 단일 watch 루프 (스레드 1개): 30Hz 커서 히트테스트 · 흔들기 · 끌기 / 2s 전체화면 · 자리 비움 화면 · 효과.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows::Win32::System::SystemInformation::{GetLocalTime, GetTickCount};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO, VK_LBUTTON};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUERY_USER_NOTIFICATION_STATE, QUNS_BUSY, QUNS_NOT_PRESENT, QUNS_PRESENTATION_MODE,
    QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::*;

/// 창별 히트 rect: (라벨, [x, y, w, h] 클라이언트 기준 물리 px). JS `reportHitRects` 가 갱신.
static HITS: Mutex<Vec<(String, Vec<[f64; 4]>)>> = Mutex::new(Vec::new());

/// (a13) 설정이 바뀌었다 → 2s 블록(전체화면 숨김·화면보호기·효과·커서 찾기 설정 읽기)을 다음 틱에 바로 돈다
pub static RECHECK: AtomicBool = AtomicBool::new(false);

/// 클릭 통과 대상 오버레이 창 (라벨, HWND as isize). 있을 때만.
/// 루프가 매 틱 읽는다(창 핸들 조회를 메인 스레드에 보내지 않도록 생성 시 등록).
static OVERLAYS: Mutex<Vec<(&'static str, isize)>> = Mutex::new(Vec::new());

pub fn add_overlay(label: &'static str, hwnd: isize) {
    OVERLAYS.lock().unwrap().push((label, hwnd));
}

pub fn remove_overlay(label: &str) {
    OVERLAYS.lock().unwrap().retain(|(l, _)| *l != label);
    HITS.lock().unwrap().retain(|(l, _)| l != label);
}

/// 최근 커서 표본 8개 (x, y, ms) — Hera Link 넘어감 자리 (엔진이 커서를 옮기기 전 자리를 알기 위해)
static CURSOR: Mutex<Vec<crate::crossing::Sample>> = Mutex::new(Vec::new());
pub fn cursor_samples() -> Vec<crate::crossing::Sample> {
    CURSOR.lock().unwrap().clone()
}
pub fn now_ms() -> u64 {
    static T0: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    T0.get_or_init(Instant::now).elapsed().as_millis() as u64
}

pub fn set_rects(label: &str, rects: Vec<[f64; 4]>) {
    let mut h = HITS.lock().unwrap();
    match h.iter_mut().find(|(l, _)| l == label) {
        Some(e) => e.1 = rects,
        None => h.push((label.to_string(), rects)),
    }
}

fn wstr(buf: &[u16]) -> String {
    String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())])
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

/// 전체화면 앱·발표 중 (2s 갱신) — 효과 창은 이때 만들지 않는다
pub static FULLSCREEN: AtomicBool = AtomicBool::new(false);

/// v2 자리 비움 화면보호기: 입력 없이 idle_min 분 지남 + 막힘(전체화면·잠금) 아님 + 아스키 창 없음. 0분 = 끔.
/// 재무장은 따로 없다 — 닫힘은 입력으로만 일어나고 입력이 idle 을 0 으로 되돌린다.
/// 자리 비움 화면 대기 분: 꾸미기가 꺼져 있으면 0 (= 안 뜸), 켜져 있으면 설정값(기본 10분)
static COVER_ARMED: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
/// 손으로 연 아스키 화면도 입력이 있으면 닫히게
pub fn arm_cover() {
    *COVER_ARMED.lock().unwrap() = Some(Instant::now());
}

fn cover_wait(deco: bool, min: Option<u64>) -> u64 {
    if deco { min.unwrap_or(10) } else { 0 }
}

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

fn last_input() -> u32 {
    let mut li = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe {
        let _ = GetLastInputInfo(&mut li);
    }
    li.dwTime
}

/// 누른 채 실제로 끌었나 (Windows 끌기 문턱 4px × 배율 2배 = 8 논리 px). 제자리 클릭은 드래그가 아니다.
fn dragged(from: (i32, i32), to: (i32, i32), s: f64) -> bool {
    (((to.0 - from.0) as f64).hypot((to.1 - from.1) as f64)) >= 8.0 * s
}

type Mons = Vec<(String, [f64; 4], f64, bool)>;

/// 그 점의 모니터 (rect, 배율)
fn mon_at(mons: &Mons, x: i32, y: i32) -> Option<([f64; 4], f64)> {
    mons.iter().find(|(_, r, _, _)| (x as f64) >= r[0] && (x as f64) < r[0] + r[2] && (y as f64) >= r[1] && (y as f64) < r[1] + r[3]).map(|m| (m.1, m.2))
}

/// 그 점의 모니터 배율 (없으면 1)
pub fn scale_at(x: i32, y: i32) -> f64 {
    mon_at(&monitors(), x, y).map_or(1.0, |m| m.1)
}

/// 왼쪽 단추가 눌려 있나
pub fn left_down() -> bool {
    unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || unsafe {
        let mut prev_lb = false;
        let mut drag_out = false; // Hera 창 밖에서 누른 채 끄는 중 (탐색기 파일 등)
        let mut press_at = (0, 0); // 누른 자리 — 실제로 끌어야 드래그
        let mut slow = Instant::now();
        let mut saver: Option<u32> = None; // 자리 비움 화면을 열 때의 마지막 입력 시각
        let mut saver_closing: Option<Instant> = None;
        let mut sky: Option<(Tod, u8)> = None;
        let mut season_shown = (0u16, 0u16);
        let mut shake = Shake::default();
        let mut locator = true;
        let mut full = false;
        let mut mons = monitors(); // 2초마다 (모니터·배율 변경)
        let mut drag = crate::drag::Drag::default();
        let mut n = 0u32;
        let t0 = Instant::now();

        loop {
            // ── 30Hz: 커서 → 흔들기 · 끌기 · 클릭 통과 ──
            let mut pt = POINT::default();
            let _ = GetCursorPos(&mut pt);
            {
                let mut c = CURSOR.lock().unwrap();
                if c.len() >= 8 {
                    c.remove(0);
                }
                c.push((pt.x, pt.y, now_ms()));
            }
            let lb = GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0;
            // 커서 찾기: 단추를 누르지 않고 흔들 때만 (커서가 맥에 있으면 엔진이 붙잡아 둔다)
            if locator && !lb && !full && !crate::link::status().on_peer && shake.push(t0.elapsed().as_millis() as u64, pt.x, pt.y, (50.0 * mon_at(&mons, pt.x, pt.y).map_or(1.0, |m| m.1)) as i32) {
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
            let hits = HITS.lock().unwrap().clone();
            let probe = drag.probe();
            let on_shape = |i: usize, m: f64| {
                let r = &rects[i];
                let shape = hits.iter().find(|(l, _)| l == overlays[i].0).map(|(_, v)| v.as_slice()).unwrap_or(&[]);
                let (x, y) = ((pt.x - r.left) as f64, (pt.y - r.top) as f64);
                // 끌기 오버레이: 파일 끌기인지 시험하는 동안은 커서 둘레 칸도 받는다
                hit(x, y, shape, m) || (overlays[i].0 == "drag" && probe.is_some_and(|p| hit(x, y, &[p], 0.0)))
            };
            if lb && !prev_lb {
                press_at = (pt.x, pt.y);
                drag_out = !(0..overlays.len()).any(|i| on_shape(i, 0.0));
            } else if !lb {
                drag_out = false;
            }
            prev_lb = lb;
            let here = mon_at(&mons, pt.x, pt.y);
            let file_drag = drag_out && dragged(press_at, (pt.x, pt.y), here.map_or(1.0, |m| m.1));
            // 흔들면 받침 · 가장자리 포탈 (drag.rs)
            drag.tick(&app, (pt.x, pt.y), lb, file_drag, t0.elapsed().as_millis() as u64, here);
            // Hera Link: 바깥에서 끌어오는 중이면 가장자리 띠를 받기 모드로 (근처일 때만)
            crate::edge::tick(pt.x, pt.y, file_drag);
            for (i, &(_, h)) in overlays.iter().enumerate() {
                // 모양(히트 rect) 위만 입력을 받는다 · 끌어오는 중이면 모양 +24px 까지 (드롭 대상)
                let p = !(on_shape(i, 0.0) || (drag_out && on_shape(i, DRAG_MARGIN)));
                let hwnd = HWND(h as _);
                let cur = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                let want = ex_style(cur, p);
                if want != cur {
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
                }
            }

            // 펫: 0.3초마다 자리 · 숨김 (전체화면)
            n = n.wrapping_add(1);
            if n.is_multiple_of(10) {
                crate::pet::tick(full);
            }

            // 펫 메뉴로 연 화면: 1.5초 뒤부터 입력을 보면 닫는다 (누른 손이 바로 닫지 않게)
            if saver.is_none() && COVER_ARMED.lock().unwrap().is_some_and(|t| t.elapsed() > Duration::from_millis(1500)) {
                *COVER_ARMED.lock().unwrap() = None;
                saver = Some(last_input());
            }
            // 자리 비움 화면: 열린 뒤 입력(마우스·키)이 있으면 닫기 — 창이 포커스가 없어도 키를 잡는다. JS 가 닫힘 애니메이션 후 파괴.
            if let Some(at) = saver {
                if last_input() != at {
                    saver = None;
                    saver_closing = Some(Instant::now());
                    crate::ascii_close_all(&app); // 어느 모니터의 입력이든 모든 덮개를 닫는다
                }
            }

            // ── 2s (설정을 바꾸면 다음 틱에 바로 — RECHECK) ──
            if slow.elapsed() >= Duration::from_secs(2) || RECHECK.swap(false, Ordering::Relaxed) {
                slow = Instant::now();
                mons = monitors();
                let qs = SHQueryUserNotificationState().ok();
                full = qs.is_some_and(fullscreen);
                let away = qs == Some(QUNS_NOT_PRESENT); // 잠금·화면보호기·사용자 전환
                FULLSCREEN.store(full, Ordering::Relaxed);
                let st = app.store("hera.json").ok();
                let get = |k: &str| st.as_ref().and_then(|s| s.get(k));
                locator = get("locator.enabled").and_then(|v| v.as_bool()).unwrap_or(true);
                let deco = get("deco.enabled").and_then(|v| v.as_bool()).unwrap_or(false);
                // 자리 비움 화면 열기/정리. 잠기면 바로 파괴(메모리 0), 닫기 요청 후 3초 지나도 남아 있으면 파괴.
                let covers = crate::ascii_windows(&app);
                if !covers.is_empty() {
                    if (away && saver.is_some()) || saver_closing.is_some_and(|t| t.elapsed() > Duration::from_secs(3)) {
                        covers.iter().for_each(|w| drop(w.destroy()));
                        saver = None;
                        saver_closing = None;
                    }
                } else {
                    saver_closing = None;
                    saver = None;
                    let idle_min = cover_wait(deco, get("ascii.idleMin").and_then(|v| v.as_u64()));
                    let li = last_input();
                    if saver_due(GetTickCount().wrapping_sub(li), idle_min, full || away, false) {
                        saver = Some(li);
                        let h = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = crate::open_cover(&h, None) {
                                eprintln!("cover: {e}");
                            }
                        });
                    }
                }
                // 효과 이벤트: 시간대·날씨·계절 첫날 변화 → 효과 창 (꾸미기 켜짐 + 전체화면·잠금 아님일 때만)
                let lt = GetLocalTime();
                let w = get("fx.weather");
                // 도시 좌표(JS 가 지오코딩해 store `fx.coords` = [위도, 경도]), 없으면 서울
                let (lat, lon) = get("fx.coords").and_then(|v| serde_json::from_value::<(f64, f64)>(v).ok()).unwrap_or((37.57, 126.98));
                let sun = sun_times(lat, lon, day_of_year(lt.wYear as i32, lt.wMonth as u32, lt.wDay as u32), tz_offset()).unwrap_or(SUN_FALLBACK);
                let cur = (tod(lt.wHour as i32 * 60 + lt.wMinute as i32, sun), wet(w.as_ref().and_then(|w| w["text"].as_str()).unwrap_or_default()));
                let today = (lt.wMonth, lt.wDay);
                let season = season_fx(lt.wMonth, lt.wDay).filter(|_| season_shown != today);
                if let Some(kind) = fx_trigger(sky, cur, season) {
                    if deco && !full && !away && crate::fx_windows(&app).is_empty() {
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

    /// 꾸미기 꺼짐(기본) = 자리 비움 화면 없음 · 켜짐 = 설정한 분(기본 10)
    #[test]
    fn cover_needs_deco() {
        assert_eq!(cover_wait(false, Some(10)), 0);
        assert!(!saver_due(u32::MAX, cover_wait(false, None), false, false));
        assert_eq!(cover_wait(true, None), 10);
        assert_eq!(cover_wait(true, Some(3)), 3);
        assert!(saver_due(3 * 60_000, cover_wait(true, Some(3)), false, false));
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
