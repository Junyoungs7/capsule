// 파일 끌기: 흔들면 받침(선반 · 맥으로), 맥 쪽 가장자리로 가면 포탈. 창 = `drag` 오버레이 하나 (숨겨 두고, 끌 때만 그 모니터를 덮는다).
// OS 에 '파일을 끄는 중' 신호는 없다 → 시험(probe): Hera 밖에서 누른 채 끌기 시작하면 오버레이를 보이고 커서 둘레 작은 칸만 입력을 받게 한다.
//   OLE 파일 드래그면 그 칸 위에서 DragEnter(경로 있음)가 오고 JS 가 drag_file 로 알려 준다 → 파일 끌기 확정, 칸은 바로 치운다.
//   0.4초 안에 안 오면(글자 고르기 · 창 옮기기 등) 오버레이를 숨기고 그 끌기는 잊는다. 창 옮기기(GUI_INMOVESIZE)는 시험도 안 한다.
// 확정 뒤: 좌우 흔들기(0.7초 안에 방향 3번, 한 번에 25 논리 px 넘게) → 'pad-show', 맥과 이어진 가장자리 구간 근처 → 'portal' (가까울수록 커짐).
// 놓기: 받침 = 오버레이 웹뷰의 네이티브 드롭, 가장자리 = edge.rs 띠 → 'portal-drop' (JS 가 빨려 들어가는 애니메이션 뒤 보냄).
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::*;

/// 포탈이 열리기 시작하는 거리 · 다 열리는 거리 (논리 px, 가장자리에서)
pub const PORTAL_FAR: f64 = 220.0;
pub const PORTAL_NEAR: f64 = 50.0;
const PROBE: f64 = 48.0; // 시험 칸 (논리 px)
const PROBE_MS: u64 = 400;

static HWND_DRAG: AtomicIsize = AtomicIsize::new(0);
/// JS 가 DragEnter(경로 있음)를 봤다
static FILE_OK: AtomicBool = AtomicBool::new(false);
/// 맥과 이어진 가장자리 구간 (윈도우 방향, [x, y, w, h] 두께 0, 물리 px) — link::update_edges 가 갱신
static SEGS: Mutex<Vec<(String, [f64; 4])>> = Mutex::new(Vec::new());

pub fn set_hwnd(h: isize) {
    HWND_DRAG.store(h, Ordering::Relaxed);
}

pub fn set_segs(segs: Vec<(String, [f64; 4])>) {
    *SEGS.lock().unwrap() = segs;
}

/// 끌면서 좌우로 흔들기: 0.7초 안에 방향 바뀜 ≥ 3번, 한 구간 이동 > min_travel
#[derive(Default)]
pub struct DragShake {
    xs: std::collections::VecDeque<(u64, i32)>,
}

impl DragShake {
    pub fn push(&mut self, t: u64, x: i32, min_travel: i32) -> bool {
        self.xs.push_back((t, x));
        while self.xs.front().is_some_and(|p| t.saturating_sub(p.0) > 700) {
            self.xs.pop_front();
        }
        let (mut flips, mut dir, mut anchor) = (0, 0, self.xs.front().map_or(x, |p| p.1));
        for &(_, px) in &self.xs {
            let d = px - anchor;
            if d.abs() > min_travel {
                if dir != 0 && d.signum() != dir {
                    flips += 1;
                }
                dir = d.signum();
                anchor = px;
            }
        }
        flips >= 3
    }
}

/// 가장자리 구간까지 (안쪽으로의 거리, 가장자리 위의 가장 가까운 점). 구간 옆(±40px 밖)이면 None
pub fn seg_dist(side: &str, e: [f64; 4], x: f64, y: f64) -> Option<(f64, (f64, f64))> {
    let m = 40.0;
    match side {
        "right" | "left" => {
            if y < e[1] - m || y > e[1] + e[3] + m {
                return None;
            }
            let d = if side == "right" { e[0] - x } else { x - e[0] };
            Some((d.max(0.0), (e[0], y.clamp(e[1], e[1] + e[3]))))
        }
        _ => {
            if x < e[0] - m || x > e[0] + e[2] + m {
                return None;
            }
            let d = if side == "down" { e[1] - y } else { y - e[1] };
            Some((d.max(0.0), (x.clamp(e[0], e[0] + e[2]), e[1])))
        }
    }
}

/// 포탈 크기 0..1: PORTAL_FAR 에서 열리기 시작해 PORTAL_NEAR 안이면 다 열림 (배율 s)
pub fn portal_k(d: f64, s: f64) -> f64 {
    ((PORTAL_FAR * s - d) / ((PORTAL_FAR - PORTAL_NEAR) * s)).clamp(0.0, 1.0)
}

/// 가장 가까운 포탈 (방향, k, 가장자리 점)
fn nearest_portal(x: f64, y: f64, s: f64) -> Option<(String, f64, (f64, f64))> {
    SEGS.lock().unwrap().iter().filter_map(|(side, e)| seg_dist(side, *e, x, y).map(|(d, p)| (side.clone(), portal_k(d, s), p))).max_by(|a, b| a.1.total_cmp(&b.1))
}

enum St {
    Idle,
    /// 시험 중 (시작 시각)
    Probe(Instant),
    /// 파일 끌기 확정 (받침 보였나)
    File(bool),
    /// 파일 끌기 아님 — 단추를 뗄 때까지 무시
    Not,
}

pub struct Drag {
    st: St,
    mon: [f64; 4],
    s: f64,
    shake: DragShake,
    last: (i64, i64, i64),
    probe: Option<[f64; 4]>,
}

impl Default for Drag {
    fn default() -> Self {
        Drag { st: St::Idle, mon: [0.0; 4], s: 1.0, shake: DragShake::default(), last: (i64::MIN, 0, 0), probe: None }
    }
}

/// 앞 창이 창 옮기기·크기 바꾸기 중인가 (그 끌기는 파일이 아니다)
fn moving_window() -> bool {
    unsafe {
        let mut gi = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        let tid = GetWindowThreadProcessId(GetForegroundWindow(), None);
        GetGUIThreadInfo(tid, &mut gi).is_ok() && gi.flags.0 & GUI_INMOVESIZE.0 != 0
    }
}

fn show(mon: [f64; 4]) {
    let h = HWND(HWND_DRAG.load(Ordering::Relaxed) as _);
    unsafe {
        // 높이 -1px: 모니터를 꽉 채운 최상위 창은 셸이 '전체화면 앱'으로 본다
        let _ = SetWindowPos(h, Some(HWND_TOPMOST), mon[0] as i32, mon[1] as i32, mon[2] as i32, mon[3] as i32 - 1, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}

pub fn hide() {
    let h = HWND(HWND_DRAG.load(Ordering::Relaxed) as _);
    unsafe {
        let _ = ShowWindow(h, SW_HIDE);
    }
}

/// JS: 시험 칸에서 DragEnter(경로 있음)
#[tauri::command]
pub fn drag_file() {
    FILE_OK.store(true, Ordering::Relaxed);
}

/// JS: 끝 애니메이션까지 다 했다 → 숨김
#[tauri::command]
pub fn drag_hide() {
    hide();
}

impl Drag {
    /// 시험 칸 (오버레이 클라이언트 기준 물리 px) — watch 루프 히트테스트가 `drag` 모양에 더한다
    pub fn probe(&self) -> Option<[f64; 4]> {
        self.probe
    }

    /// watch 루프 30Hz. file_drag = Hera 밖에서 누른 채 8 논리 px 넘게 끔, lb = 왼쪽 단추, t = ms
    pub fn tick(&mut self, app: &AppHandle, pt: (i32, i32), lb: bool, file_drag: bool, t: u64, mon: Option<([f64; 4], f64)>) {
        if HWND_DRAG.load(Ordering::Relaxed) == 0 {
            return;
        }
        if !lb {
            if matches!(self.st, St::Probe(_)) {
                hide();
            }
            if matches!(self.st, St::File(_)) {
                let _ = app.emit_to("drag", "drag-end", ());
                // 안전망: JS 가 숨기지 못했으면 3초 뒤 (그 사이 새 끌기가 시작되지 않았으면)
                let h = HWND_DRAG.load(Ordering::Relaxed);
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(3));
                    if !crate::watch::left_down() && h != 0 {
                        hide();
                    }
                });
            }
            self.st = St::Idle;
            self.probe = None;
            return;
        }
        let (x, y) = (pt.0 as f64, pt.1 as f64);
        let s = self.s;
        let around = |m: [f64; 4]| [x - m[0] - PROBE * s / 2.0, y - m[1] - PROBE * s / 2.0, PROBE * s, PROBE * s];
        match self.st {
            St::Idle if file_drag => {
                let Some((m, sc)) = mon else { return };
                if moving_window() {
                    self.st = St::Not;
                    return;
                }
                FILE_OK.store(false, Ordering::Relaxed);
                (self.mon, self.s, self.shake, self.last) = (m, sc, DragShake::default(), (i64::MIN, 0, 0));
                self.probe = Some(around(m));
                show(m);
                let _ = app.emit_to("drag", "drag-start", json!({ "scale": sc }));
                self.st = St::Probe(Instant::now());
            }
            St::Probe(since) => {
                if FILE_OK.load(Ordering::Relaxed) {
                    self.probe = None;
                    self.st = St::File(false);
                } else if since.elapsed() > Duration::from_millis(PROBE_MS) {
                    self.probe = None;
                    hide();
                    self.st = St::Not;
                } else {
                    self.probe = Some(around(self.mon));
                }
            }
            St::File(pad) => {
                let local = |p: (f64, f64)| ((p.0 - self.mon[0]) / s, (p.1 - self.mon[1]) / s);
                let portal = nearest_portal(x, y, s);
                if !pad && self.shake.push(t, pt.0, (25.0 * s) as i32) {
                    self.st = St::File(true);
                    let (lx, ly) = local((x, y));
                    let _ = app.emit_to("drag", "pad-show", json!({ "x": lx, "y": ly, "mac": crate::link::files_connected().is_some(), "to": portal.as_ref().map(|p| local(p.2)) }));
                }
                // 포탈: 바뀔 때만 (k 는 2% 단위)
                let k = portal.as_ref().map_or(0.0, |p| p.1);
                let key = ((k * 50.0).round() as i64, y as i64 / 4, x as i64 / 4);
                if key != self.last && (k > 0.0 || self.last.0 > 0) {
                    self.last = key;
                    let at = portal.as_ref().map(|p| local(p.2)).unwrap_or((0.0, 0.0));
                    let _ = app.emit_to("drag", "portal", json!({ "k": k, "side": portal.as_ref().map_or("right", |p| p.0.as_str()), "x": at.0, "y": at.1 }));
                }
            }
            _ => {}
        }
    }
}

/// edge.rs 띠에 놓음 → 오버레이가 빨려 들어가는 애니메이션 뒤 보낸다 (오버레이가 안 보이면 false → 바로 보내기)
pub fn portal_drop(app: &AppHandle, paths: &[String], mac_side: &str, pos: f64, pt: (i32, i32)) -> bool {
    let h = HWND(HWND_DRAG.load(Ordering::Relaxed) as _);
    if h.0.is_null() || !unsafe { IsWindowVisible(h) }.as_bool() {
        return false;
    }
    let mut r = windows::Win32::Foundation::RECT::default();
    let _ = unsafe { GetWindowRect(h, &mut r) };
    let s = crate::watch::scale_at(pt.0, pt.1);
    app.emit_to("drag", "portal-drop", json!({ "paths": paths, "edge": mac_side, "pos": pos, "x": (pt.0 - r.left) as f64 / s, "y": (pt.1 - r.top) as f64 / s })).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drag_shake_needs_three_quick_flips() {
        // 70ms 마다 좌우 80px → 0.7초 안에 3번 넘게 바뀜
        let mut s = DragShake::default();
        let fired = (0..12u64).any(|i| s.push(i * 70, if i % 2 == 0 { 500 } else { 580 }, 25));
        assert!(fired);
        // 한 방향으로 쭉 (파일을 옮기는 보통 끌기)
        let mut s = DragShake::default();
        assert!(!(0..30u64).any(|i| s.push(i * 33, 100 + i as i32 * 30, 25)));
        // 작은 떨림 (±10px)
        let mut s = DragShake::default();
        assert!(!(0..30u64).any(|i| s.push(i * 33, if i % 2 == 0 { 500 } else { 520 }, 25)));
        // 느린 왕복 (0.5초마다) — 0.7초 안에 3번이 안 된다
        let mut s = DragShake::default();
        assert!(!(0..20u64).any(|i| s.push(i * 500, if i % 2 == 0 { 500 } else { 600 }, 25)));
        // 배율 2 = 50px 문턱: 40px 흔들기는 안 됨
        let mut s = DragShake::default();
        assert!(!(0..12u64).any(|i| s.push(i * 70, if i % 2 == 0 { 500 } else { 540 }, 50)));
    }

    #[test]
    fn portal_grows_with_proximity() {
        assert_eq!(portal_k(300.0, 1.0), 0.0);
        assert_eq!(portal_k(220.0, 1.0), 0.0);
        assert!((portal_k(135.0, 1.0) - 0.5).abs() < 1e-9);
        assert_eq!(portal_k(50.0, 1.0), 1.0);
        assert_eq!(portal_k(0.0, 1.0), 1.0);
        // 배율 1.5 = 물리 px 도 1.5배
        assert_eq!(portal_k(75.0, 1.5), 1.0);
        assert_eq!(portal_k(330.0, 1.5), 0.0);
    }

    #[test]
    fn distance_to_linked_edge_segments() {
        // 오른쪽 가장자리 아래 절반만 맥과 이어짐 (1920×1080)
        let e = [1920.0, 540.0, 0.0, 540.0];
        assert_eq!(seg_dist("right", e, 1900.0, 800.0), Some((20.0, (1920.0, 800.0))));
        assert_eq!(seg_dist("right", e, 1900.0, 520.0).map(|r| r.1), Some((1920.0, 540.0))); // 구간 바로 위 (40px 안) → 끝점
        assert_eq!(seg_dist("right", e, 1900.0, 300.0), None); // 이어지지 않은 위 절반
        // 왼쪽 · 위 · 아래
        assert_eq!(seg_dist("left", [-1920.0, 0.0, 0.0, 1080.0], -1800.0, 10.0).unwrap().0, 120.0);
        assert_eq!(seg_dist("up", [0.0, 0.0, 1920.0, 0.0], 960.0, 30.0).unwrap(), (30.0, (960.0, 0.0)));
        assert_eq!(seg_dist("down", [0.0, 1080.0, 1920.0, 0.0], 100.0, 1000.0).unwrap(), (80.0, (100.0, 1080.0)));
        // 안쪽 50px → 포탈 다 열림
        assert_eq!(portal_k(seg_dist("right", e, 1871.0, 900.0).unwrap().0, 1.0), 1.0);
    }
}
