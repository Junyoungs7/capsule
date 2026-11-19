// 아일랜드 창 (펫 캡슐 · 알림 알약 · 허브 · 안에서 여는 기능 화면). 창 = 680 × 680 (투명, 클릭 통과 = 히트 rect 만).
// (a13) 떠 있는 캡슐: 캡슐을 끌어 아무 데나 둔다. 자리 = store `island.pos` { mon: 모니터 이름, fx, fy: 작업 영역 안 캡슐 가운데 비율 }.
// 캡슐이 모니터의 어느 쪽 절반에 있느냐로 창이 붙는 가장자리(Anchor)가 정해지고, 허브·화면·알림은 늘 화면 안쪽으로 펼쳐진다.
// - tall: 떼어내기·흡수 유령이 움직이는 동안만 작업 영역 전체. 캡슐은 화면 같은 자리 (Anchor 가 새 창 기준으로 바뀐다).
//   창 원점이 바뀌면 이미 보고된 히트 rect(클라이언트 기준)를 같은 만큼 옮긴다 — 안 그러면 캡슐이 클릭을 못 받는다 (a3 버그 5).
// - interactive: 안의 화면에 글자를 칠 때(할 일·채팅·터미널) 키보드 포커스를 받는다. 접히면 직전 앱으로 돌려준다.
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

pub const HEIGHT: f64 = 680.0; // 논리 px (펫 추가 440×640 · 설정 380×610 · 터미널 640×300 + 여백)
pub const WIDTH: f64 = 680.0;
/// 창이 붙는 가장자리 ↔ 캡슐 가운데 (논리 px): 가장 큰 캡슐 반 폭 56 × 자석 1.16 + 머묾 여유 16 보다 넉넉히
const PAD: f64 = 96.0;
/// 처음 자리 = 작업 영역 오른쪽 아래에서 캡슐 가운데까지 (논리 px) — 예전 오른쪽 아래 모서리(보통 크기 80×60, 여백 16·8)와 같은 자리
const HOME: (f64, f64) = (56.0, 38.0);
pub static TALL: AtomicBool = AtomicBool::new(false);
pub static INTERACTIVE: AtomicBool = AtomicBool::new(false);
static PREV: AtomicIsize = AtomicIsize::new(0);
/// 끄는 중: 커서 ↔ 창 원점 (물리 px)
static GRAB: Mutex<Option<(i32, i32)>> = Mutex::new(None);
/// 지금 아일랜드가 사는 작업 영역 (l, t, r, b 물리 px) — watch 루프의 캡슐 입력 판정
pub static WA: Mutex<[i32; 4]> = Mutex::new([0, 0, 0, 0]);
static ANCHOR: Mutex<Anchor> = Mutex::new(Anchor { right: true, bottom: true, x: HOME.0, y: HOME.1 });

/// 캡슐 가운데가 창의 어느 가장자리에서 얼마나 떨어져 있나 (논리 px). right/bottom = 그쪽 가장자리 기준 (= 내용이 왼쪽·위로 펼쳐짐).
#[derive(serde::Serialize, Clone, Copy, PartialEq, Debug)]
pub struct Anchor {
    pub right: bool,
    pub bottom: bool,
    pub x: f64,
    pub y: f64,
}

/// 작업 영역 (x, y, w, h 물리 px) 의 처음 자리 (캡슐 가운데, 물리 px)
pub fn home(wa: [i32; 4], s: f64) -> (f64, f64) {
    ((wa[0] + wa[2]) as f64 - HOME.0 * s, (wa[1] + wa[3]) as f64 - HOME.1 * s)
}

/// 작업 영역 · 배율 · 캡슐 가운데(물리 px) → 아일랜드 창 (x, y, w, h) + Anchor. 창은 늘 작업 영역 안.
pub fn layout(wa: [i32; 4], s: f64, c: (f64, f64), tall: bool) -> ([i32; 4], Anchor) {
    let m = 24.0 * s;
    let cx = c.0.clamp(wa[0] as f64 + m, (wa[0] + wa[2]) as f64 - m);
    let cy = c.1.clamp(wa[1] as f64 + m, (wa[1] + wa[3]) as f64 - m);
    let right = cx >= wa[0] as f64 + wa[2] as f64 / 2.0;
    let bottom = cy >= wa[1] as f64 + wa[3] as f64 / 2.0;
    let r = if tall {
        [wa[0], wa[1] + 1, wa[2], wa[3] - 1] // -1px: 작업 표시줄 자동 숨김이면 작업 영역 = 모니터 → '전체화면 앱' 판정 회피
    } else {
        let w = ((WIDTH * s).round() as i32).min(wa[2]);
        let h = ((HEIGHT * s).round() as i32).min(wa[3] - 1);
        let p = PAD * s;
        let x = if right { (cx + p).round() as i32 - w } else { (cx - p).round() as i32 };
        let y = if bottom { (cy + p).round() as i32 - h } else { (cy - p).round() as i32 };
        [x.clamp(wa[0], wa[0] + wa[2] - w), y.clamp(wa[1] + 1, wa[1] + wa[3] - h), w, h]
    };
    let ax = if right { (r[0] + r[2]) as f64 - cx } else { cx - r[0] as f64 };
    let ay = if bottom { (r[1] + r[3]) as f64 - cy } else { cy - r[1] as f64 };
    (r, Anchor { right, bottom, x: ax / s, y: ay / s })
}

/// 모니터 = (이름, 작업 영역 x y w h, 배율)
pub type Mon = (String, [i32; 4], f64);

/// 저장된 자리 → (모니터 번호, 캡슐 가운데). 그 모니터가 없으면 None (→ 주 모니터 처음 자리)
pub fn saved_spot(mons: &[Mon], pos: &serde_json::Value) -> Option<(usize, (f64, f64))> {
    let name = pos["mon"].as_str()?;
    let (fx, fy) = (pos["fx"].as_f64()?.clamp(0.0, 1.0), pos["fy"].as_f64()?.clamp(0.0, 1.0));
    let i = mons.iter().position(|m| m.0 == name)?;
    let wa = mons[i].1;
    Some((i, (wa[0] as f64 + fx * wa[2] as f64, wa[1] as f64 + fy * wa[3] as f64)))
}

/// 화면 점(캡슐 가운데) → 저장할 자리 (가장 가까운 모니터의 작업 영역 비율)
pub fn spot_of(mons: &[Mon], c: (f64, f64)) -> Option<serde_json::Value> {
    let d = |wa: [i32; 4]| crate::watch::rect_dist(c.0, c.1, [wa[0] as f64, wa[1] as f64, wa[2] as f64, wa[3] as f64]);
    let m = mons.iter().min_by(|a, b| d(a.1).total_cmp(&d(b.1)))?;
    let wa = m.1;
    let f = |v: f64, o: i32, n: i32| ((v - o as f64) / n.max(1) as f64).clamp(0.0, 1.0);
    Some(serde_json::json!({ "mon": m.0, "fx": f(c.0, wa[0], wa[2]), "fy": f(c.1, wa[1], wa[3]) }))
}

fn monitors(app: &AppHandle) -> (Vec<Mon>, usize) {
    let prim = app.primary_monitor().ok().flatten().map(|m| *m.position());
    let ms = app.available_monitors().unwrap_or_default();
    let v: Vec<Mon> = ms
        .iter()
        .map(|m| {
            let wa = m.work_area();
            (m.name().cloned().unwrap_or_default(), [wa.position.x, wa.position.y, wa.size.width as i32, wa.size.height as i32], m.scale_factor())
        })
        .collect();
    let p = ms.iter().position(|m| Some(*m.position()) == prim).unwrap_or(0);
    (v, p)
}

pub fn dragging() -> bool {
    GRAB.lock().unwrap().is_some()
}

/// 배치: 저장된 자리(없거나 그 모니터가 사라졌으면 주 모니터 오른쪽 아래)로 창을 놓고 Anchor 를 JS 에 알린다.
/// 시작 · 끌어 놓은 뒤 · '처음 자리로' · DPI/작업 영역/모니터 변경 때.
pub fn place(app: &AppHandle) {
    if dragging() {
        return; // 끄는 동안 다른 모니터로 넘어가 배율이 바뀌어도 놓을 때 한 번만
    }
    let Some(win) = app.get_webview_window("island") else { return };
    let (mons, prim) = monitors(app);
    let Some(pm) = mons.get(prim) else { return };
    let pos = app.store("hera.json").ok().and_then(|s| s.get("island.pos"));
    let (i, c) = pos.as_ref().and_then(|p| saved_spot(&mons, p)).unwrap_or((prim, home(pm.1, pm.2)));
    let (_, wa, s) = &mons[i];
    let (r, a) = layout(*wa, *s, c, TALL.load(Ordering::Relaxed));
    if let Ok(o) = win.outer_position() {
        crate::watch::shift_rects("island", (o.x - r[0]) as f64, (o.y - r[1]) as f64);
    }
    *WA.lock().unwrap() = [wa[0], wa[1], wa[0] + wa[2], wa[1] + wa[3]];
    crate::ui::set_bounds(&win, r[0], r[1], r[2], r[3]);
    *ANCHOR.lock().unwrap() = a;
    let _ = app.emit_to("island", "island-anchor", a);
}

/// JS 처음 읽기 (시작할 때 보낸 'island-anchor' 는 리스너보다 먼저 갔을 수 있다)
#[tauri::command]
pub fn island_anchor() -> Anchor {
    *ANCHOR.lock().unwrap()
}

/// 캡슐 끌기: start(6px 넘게 움직였을 때) → move(포인터가 움직일 때마다, 창을 커서에 붙여 옮김) → end(놓음 = 자리 저장 → 배치)
#[tauri::command]
pub fn island_drag(app: AppHandle, phase: String) {
    let Some(win) = app.get_webview_window("island") else { return };
    let cur = crate::ui::cursor();
    match phase.as_str() {
        "start" => {
            if let Ok(p) = win.outer_position() {
                *GRAB.lock().unwrap() = Some((cur.0 - p.x, cur.1 - p.y));
            }
        }
        "move" => {
            if let Some(g) = *GRAB.lock().unwrap() {
                crate::ui::move_client(&win, cur.0 - g.0, cur.1 - g.1);
            }
        }
        _ => {
            if GRAB.lock().unwrap().take().is_none() {
                return;
            }
            let (Ok(p), Ok(z), Ok(s)) = (win.outer_position(), win.outer_size(), win.scale_factor()) else { return };
            let a = *ANCHOR.lock().unwrap();
            let cx = if a.right { (p.x + z.width as i32) as f64 - a.x * s } else { p.x as f64 + a.x * s };
            let cy = if a.bottom { (p.y + z.height as i32) as f64 - a.y * s } else { p.y as f64 + a.y * s };
            let (mons, _) = monitors(&app);
            match (spot_of(&mons, (cx, cy)), app.store("hera.json")) {
                (Some(v), Ok(st)) => st.set("island.pos", v), // → store 리스너가 place
                _ => place(&app),
            }
        }
    }
}

#[tauri::command]
pub fn island_tall(app: AppHandle, on: bool) {
    if TALL.swap(on, Ordering::Relaxed) != on {
        place(&app);
        // 화면 높이 표면을 접었으면 GPU·렌더러가 들고 있던 큰 텍스처를 바로 놓게 (저메모리 수준 다시 걸기)
        if !on {
            if let Some(w) = app.get_webview_window("island") {
                let _ = crate::ui::trim(&w);
            }
        }
    }
}

/// 키보드 포커스 받기/돌려주기
#[tauri::command]
pub fn island_focus(app: AppHandle, on: bool) {
    let Some(win) = app.get_webview_window("island") else { return };
    if on {
        if !INTERACTIVE.swap(true, Ordering::Relaxed) {
            PREV.store(crate::ui::foreground(), Ordering::Relaxed);
        }
        #[cfg(windows)]
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE};
            let h = windows::Win32::Foundation::HWND(crate::ui::hwnd(&win) as _);
            SetWindowLongPtrW(h, GWL_EXSTYLE, GetWindowLongPtrW(h, GWL_EXSTYLE) & !(WS_EX_NOACTIVATE.0 as isize));
        }
        let _ = win.set_focus();
    } else if INTERACTIVE.swap(false, Ordering::Relaxed) {
        // NOACTIVATE 는 watch 루프가 다음 틱에 다시 붙인다
        let prev = PREV.swap(0, Ordering::Relaxed);
        if crate::ui::foreground() == crate::ui::hwnd(&win) || prev != 0 {
            crate::ui::restore_foreground(prev);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WA: [i32; 4] = [0, 0, 1920, 1032]; // 작업 표시줄 48px

    #[test]
    fn home_is_old_bottom_right_corner() {
        let (r, a) = layout(WA, 1.0, home(WA, 1.0), false);
        assert_eq!(r, [1240, 352, 680, 680]); // 예전 오른쪽 아래 창 그대로
        assert_eq!(a, Anchor { right: true, bottom: true, x: 56.0, y: 38.0 }); // 보통 캡슐 80×60 → 오른쪽 16 · 아래 8
        let w = [0, 0, 2560, 1392];
        assert_eq!(layout(w, 1.5, home(w, 1.5), false).0, [1540, 372, 1020, 1020]);
        assert_eq!(layout([0, 0, 600, 500], 1.0, home([0, 0, 600, 500], 1.0), false).0, [0, 1, 600, 499]); // 작은 모니터
    }

    /// 펼치는 쪽 = 캡슐이 있는 절반의 반대 (화면 안쪽) · 창은 늘 작업 영역 안 · 캡슐 가운데는 화면 같은 자리
    #[test]
    fn expands_toward_the_inside() {
        for (c, right, bottom) in [((1800.0, 900.0), true, true), ((100.0, 900.0), false, true), ((100.0, 80.0), false, false), ((1800.0, 80.0), true, false), ((960.0, 516.0), true, true), ((700.0, 300.0), false, false)] {
            for s in [1.0, 1.25, 1.5] {
                let (r, a) = layout(WA, s, c, false);
                assert_eq!((a.right, a.bottom), (right, bottom), "{c:?}");
                assert!(r[0] >= WA[0] && r[1] >= WA[1] && r[0] + r[2] <= WA[2] && r[1] + r[3] <= WA[3], "창은 작업 영역 안 {c:?} {r:?}");
                let cx = if a.right { (r[0] + r[2]) as f64 - a.x * s } else { r[0] as f64 + a.x * s };
                let cy = if a.bottom { (r[1] + r[3]) as f64 - a.y * s } else { r[1] as f64 + a.y * s };
                assert!((cx - c.0).abs() < 1.0 && (cy - c.1).abs() < 1.0, "캡슐 자리 {c:?} → {cx},{cy}");
            }
        }
        // 화면 밖 자리 → 작업 영역 안으로 당겨 온다
        let (r, a) = layout(WA, 1.0, (5000.0, -300.0), false);
        assert!(a.right && !a.bottom && r[0] + r[2] == 1920 && r[1] == 1);
        assert_eq!((a.x, a.y), (24.0, 23.0));
    }

    #[test]
    fn saved_spot_round_trip_and_missing_monitor() {
        let mons: Vec<Mon> = vec![(r"\.\DISPLAY1".into(), WA, 1.0), (r"\.\DISPLAY2".into(), [-1920, 200, 1920, 1080], 1.25)];
        let v = spot_of(&mons, (-1000.0, 470.0)).unwrap();
        assert_eq!(v["mon"], r"\.\DISPLAY2");
        let (i, c) = saved_spot(&mons, &v).unwrap();
        assert_eq!(i, 1);
        assert!((c.0 + 1000.0).abs() < 0.01 && (c.1 - 470.0).abs() < 0.01);
        // 저장한 모니터가 빠지면 None → 주 모니터 처음 자리
        assert!(saved_spot(&mons[..1], &v).is_none());
        assert!(saved_spot(&mons, &serde_json::json!("br")).is_none());
        // 모니터 밖(틈)에 놓으면 가장 가까운 모니터로
        assert_eq!(spot_of(&mons, (1500.0, 1500.0)).unwrap()["mon"], r"\.\DISPLAY1");
    }

    /// 버그 5 회귀: 떼어내기·흡수 동안 창이 커졌다 돌아와도 캡슐 히트 rect 는 화면 같은 자리
    #[test]
    fn tall_round_trip_keeps_capsule_hit() {
        let c = (1300.0, 300.0); // 위쪽에 둔 캡슐
        let (small, a) = layout(WA, 1.0, c, false);
        let (tall, b) = layout(WA, 1.0, c, true);
        assert_eq!((a.right, a.bottom), (b.right, b.bottom));
        let cap = [a.x - 40.0, a.y - 30.0, 80.0, 60.0];
        let screen = |o: [i32; 4], r: [f64; 4]| (o[0] as f64 + r[0], o[1] as f64 + r[1]);
        let mut r = vec![cap];
        crate::watch::shift(&mut r, (small[0] - tall[0]) as f64, (small[1] - tall[1]) as f64);
        assert_eq!(screen(tall, r[0]), screen(small, cap));
        crate::watch::shift(&mut r, (tall[0] - small[0]) as f64, (tall[1] - small[1]) as f64);
        assert_eq!(r[0], cap);
    }
}
