// 파란 물결 (화면 경계 넘어감 · 커서 찾기 · 가장자리 끌어 놓기). 웹뷰 없이 네이티브 레이어드 창:
// (a6) Hera Link 넘어감은 물결 + 그 벽 전체가 일렁이는 띠(가장자리 32 논리 px, 그 모니터 길이) — crossing::render_wall, 0.8초 뒤 숨기고 버퍼를 놓는다.
// 처음 쓸 때 전용 스레드에서 만들고, 20ms 타이머로 30프레임(600ms) 그린 뒤 숨김 + 타이머 끔 → 평소 CPU 0.
// 그림 = 소프트웨어로 premultiplied BGRA 버퍼 → UpdateLayeredWindow(ULW_ALPHA). 클릭 통과·포커스 안 뺏음.
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};

use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteObject, GetDC, MonitorFromPoint, ReleaseDC, SelectObject, AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    BLENDFUNCTION, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::*;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    /// 들어온 화면: 진한 물결 (가장자리에서 반원으로 퍼짐)
    Enter,
    /// 떠난 화면: 옅은 물결
    Leave,
    /// 커서 찾기: 커서 둘레 원
    Locate,
}

struct Req {
    x: i32,
    y: i32,
    edge: Option<String>, // left / right / up / down = 화면의 어느 가장자리인가
    kind: Kind,
    wall: Option<crate::crossing::Wall>,
}

static HOST: AtomicIsize = AtomicIsize::new(0);
static WALL_HOST: AtomicIsize = AtomicIsize::new(0);
const WALL_FRAMES: u32 = 40; // 20ms × 40 = 0.8초
static REQ: Mutex<Option<Req>> = Mutex::new(None);
static STARTED: OnceLock<()> = OnceLock::new();
const FRAMES: u32 = 30;

/// 물결 1번 (스레드 안전, 바로 반환). x, y = 화면 물리 px (가장자리 위의 점 또는 커서)
pub fn show(x: i32, y: i32, edge: Option<&str>, kind: Kind) {
    request(Req { x, y, edge: edge.map(String::from), kind, wall: None })
}

/// Hera Link 넘어감: 물결 + 벽 일렁임
pub fn show_crossing(x: i32, y: i32, edge: &str, kind: Kind, wall: Option<crate::crossing::Wall>) {
    request(Req { x, y, edge: Some(edge.into()), kind, wall })
}

fn request(r: Req) {
    *REQ.lock().unwrap() = Some(r);
    if STARTED.set(()).is_ok() {
        std::thread::spawn(run);
    } else {
        let h = HOST.load(Ordering::Relaxed);
        if h != 0 {
            unsafe {
                let _ = PostMessageW(Some(HWND(h as _)), WM_APP, WPARAM(0), LPARAM(0));
            }
        }
    }
}

/// 한 프레임 그리기 (순수 함수 — 시험 대상). buf = w×h premultiplied BGRA, (cx, cy) = 물결 중심(창 안 좌표),
/// t = 0..1 진행, strength = 최대 불투명도, reduced = 움직임 줄이기(퍼지지 않고 부드럽게 한 번 빛남)
#[allow(clippy::too_many_arguments)]
pub fn render(buf: &mut [u32], w: usize, h: usize, cx: f32, cy: f32, t: f32, strength: f32, reduced: bool) {
    let rmax = (w.max(h) as f32) * if w == h { 0.48 } else { 0.5 };
    let fade = (1.0 - t).powf(1.4) * strength;
    let width = rmax * 0.06;
    for y in 0..h {
        for x in 0..w {
            let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
            let d = (dx * dx + dy * dy).sqrt();
            let mut a = 0.0f32;
            if reduced {
                // 중심의 부드러운 빛 하나 (크기 고정)
                let g = d / (rmax * 0.45);
                a = (1.0 - g * g).max(0.0).powi(2) * 0.8;
            } else {
                let ang = dy.atan2(dx);
                for k in 0..3 {
                    let tk = t - k as f32 * 0.13;
                    if tk <= 0.0 {
                        continue;
                    }
                    // 굽이치는 고리: 반지름이 각도·시간에 따라 살짝 물결친다
                    let base = tk.powf(0.8) * rmax;
                    let r = base + (ang * 6.0 + t * 12.0 + k as f32).sin() * (base * 0.025).min(3.0) * (1.0 - t);
                    let e = (d - r) / width;
                    // 선명한 고리 + 넓고 옅은 번짐(빛나 보이게)
                    a += ((-e * e).exp() + 0.3 * (-(e * e) / 9.0).exp()) * (1.0 - k as f32 * 0.25);
                }
                // 중심 광채 (초반만)
                a += (1.0 - d / (rmax * 0.25)).max(0.0) * (1.0 - t * 3.0).max(0.0) * 0.6;
            }
            let a = (a * fade).clamp(0.0, 1.0);
            if a < 0.004 {
                buf[y * w + x] = 0;
                continue;
            }
            // 파랑(가장자리) → 밝은 하늘색(진한 곳), premultiplied
            let hot = a.min(1.0);
            let (r, g, b) = (60.0 + 140.0 * hot * hot, 150.0 + 80.0 * hot, 255.0);
            let px = |c: f32| (c * a).min(255.0) as u32;
            buf[y * w + x] = ((a * 255.0) as u32) << 24 | px(r) << 16 | px(g) << 8 | px(b);
        }
    }
}

/// 창 크기·위치와 중심: 가장자리면 반원(가장자리에 중심), 커서 찾기면 원
fn geometry(r: &Req, s: i32) -> (i32, i32, usize, usize, f32, f32) {
    let (x, y) = (r.x, r.y);
    match (r.kind, r.edge.as_deref()) {
        (Kind::Locate, _) | (_, None) => {
            let d = s * 3 / 2;
            (x - d / 2, y - d / 2, d as usize, d as usize, d as f32 / 2.0, d as f32 / 2.0)
        }
        (_, Some("left")) => (x, y - s, s as usize, 2 * s as usize, 0.0, s as f32),
        (_, Some("right")) => (x - s, y - s, s as usize, 2 * s as usize, s as f32, s as f32),
        (_, Some("up")) => (x - s, y, 2 * s as usize, s as usize, s as f32, 0.0),
        (_, _) => (x - s, y - s, 2 * s as usize, s as usize, s as f32, s as f32),
    }
}

fn reduced_motion() -> bool {
    let mut on = windows::core::BOOL(1);
    unsafe {
        let _ = SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, Some(&mut on as *mut _ as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0));
    }
    !on.as_bool()
}

struct Anim {
    frame: u32,
    pos: (i32, i32),
    w: usize,
    h: usize,
    c: (f32, f32),
    strength: f32,
    reduced: bool,
    dc: HDC,
    bmp: HBITMAP,
    bits: *mut u32,
    old: HGDIOBJ,
}

struct WallAnim {
    frame: u32,
    wall: crate::crossing::Wall,
    reduced: bool,
    dc: HDC,
    bmp: HBITMAP,
    bits: *mut u32,
    old: HGDIOBJ,
}

thread_local! {
    static ANIM: std::cell::RefCell<Option<Anim>> = const { std::cell::RefCell::new(None) };
    static WALL: std::cell::RefCell<Option<WallAnim>> = const { std::cell::RefCell::new(None) };
}

/// 32비트 DIB (그릴 버퍼) 하나
unsafe fn dib(w: usize, h: usize) -> Option<(HDC, HBITMAP, *mut u32, HGDIOBJ)> {
    let bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w as i32, biHeight: -(h as i32), biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() },
        ..Default::default()
    };
    let dc = CreateCompatibleDC(None);
    let mut bits = std::ptr::null_mut();
    let bmp = CreateDIBSection(Some(dc), &bi, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
    let old = SelectObject(dc, bmp.into());
    Some((dc, bmp, bits as *mut u32, old))
}

unsafe fn free_dib(dc: HDC, bmp: HBITMAP, old: HGDIOBJ) {
    SelectObject(dc, old);
    let _ = DeleteObject(bmp.into());
    let _ = windows::Win32::Graphics::Gdi::DeleteDC(dc);
}

unsafe fn blit(h: HWND, dc: HDC, x: i32, y: i32, w: i32, hh: i32) {
    let screen = GetDC(None);
    let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA as u8 };
    let (pos, size, src) = (POINT { x, y }, SIZE { cx: w, cy: hh }, POINT::default());
    let _ = UpdateLayeredWindow(h, Some(screen), Some(&pos), Some(&size), Some(dc), Some(&src), COLORREF(0), Some(&blend), ULW_ALPHA);
    ReleaseDC(None, screen);
}

unsafe fn start(h: HWND) {
    let Some(r) = REQ.lock().unwrap().take() else { return };
    // 벽 띠: 지난 것을 거두고 새로 (그 모니터 가장자리 · 띠 크기 버퍼만)
    WALL.with_borrow_mut(|a| {
        if let Some(old) = a.take() {
            free_dib(old.dc, old.bmp, old.old);
        }
        let wh = HWND(WALL_HOST.load(Ordering::Relaxed) as _);
        let Some(wall) = r.wall else { return };
        let [x, y, w, hh] = wall.rect;
        let Some((dc, bmp, bits, old)) = dib(w as usize, hh as usize) else { return };
        *a = Some(WallAnim { frame: 0, wall, reduced: reduced_motion(), dc, bmp, bits, old });
        let _ = SetWindowPos(wh, Some(HWND_TOPMOST), x, y, w, hh, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    });
    let (mut dx, mut dy) = (96u32, 96u32);
    let _ = GetDpiForMonitor(MonitorFromPoint(POINT { x: r.x, y: r.y }, MONITOR_DEFAULTTONEAREST), MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
    let s = (256 * dx / 96) as i32;
    let (x, y, w, hh, cx, cy) = geometry(&r, s);
    ANIM.with_borrow_mut(|a| {
        if let Some(old) = a.take() {
            free(old);
        }
        let bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w as i32, biHeight: -(hh as i32), biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() },
            ..Default::default()
        };
        let dc = CreateCompatibleDC(None);
        let mut bits = std::ptr::null_mut();
        let Ok(bmp) = CreateDIBSection(Some(dc), &bi, DIB_RGB_COLORS, &mut bits, None, 0) else { return };
        let old = SelectObject(dc, bmp.into());
        let strength = match r.kind {
            Kind::Leave => 0.35,
            _ => 0.95,
        };
        *a = Some(Anim { frame: 0, pos: (x, y), w, h: hh, c: (cx, cy), strength, reduced: reduced_motion(), dc, bmp, bits: bits as *mut u32, old });
    });
    let _ = SetWindowPos(h, Some(HWND_TOPMOST), x, y, w as i32, hh as i32, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    let _ = SetTimer(Some(h), 1, 20, None);
    frame(h);
}

unsafe fn free(a: Anim) {
    SelectObject(a.dc, a.old);
    let _ = DeleteObject(a.bmp.into());
    let _ = windows::Win32::Graphics::Gdi::DeleteDC(a.dc);
}

unsafe fn frame(h: HWND) {
    let wall_done = WALL.with_borrow_mut(|a| {
        let Some(an) = a.as_mut() else { return true };
        let total = if an.reduced { 12 } else { WALL_FRAMES };
        let [x, y, w, hh] = an.wall.rect;
        let (len, depth) = if an.wall.side.horizontal() { (w as usize, hh as usize) } else { (hh as usize, w as usize) };
        let t = (an.frame as f32 / total as f32).min(1.0);
        let buf = std::slice::from_raw_parts_mut(an.bits, len * depth);
        crate::crossing::render_wall(buf, len, depth, an.wall.u0, t, an.reduced, an.wall.side);
        blit(HWND(WALL_HOST.load(Ordering::Relaxed) as _), an.dc, x, y, w, hh);
        an.frame += 1;
        if an.frame > total {
            // 거두기: 숨기고 버퍼를 놓는다 (평소 메모리·CPU 0)
            let _ = ShowWindow(HWND(WALL_HOST.load(Ordering::Relaxed) as _), SW_HIDE);
            if let Some(x) = a.take() {
                free_dib(x.dc, x.bmp, x.old);
            }
            return true;
        }
        false
    });
    let done = ANIM.with_borrow_mut(|a| {
        let Some(an) = a.as_mut() else { return true };
        let total = if an.reduced { 8 } else { FRAMES };
        if an.frame >= total {
            return true;
        }
        let t = an.frame as f32 / total as f32;
        let buf = std::slice::from_raw_parts_mut(an.bits, an.w * an.h);
        render(buf, an.w, an.h, an.c.0, an.c.1, t, an.strength, an.reduced);
        let screen = GetDC(None);
        let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA as u8 };
        let (pos, size, src) = (POINT { x: an.pos.0, y: an.pos.1 }, SIZE { cx: an.w as i32, cy: an.h as i32 }, POINT::default());
        let _ = UpdateLayeredWindow(h, Some(screen), Some(&pos), Some(&size), Some(an.dc), Some(&src), COLORREF(0), Some(&blend), ULW_ALPHA);
        ReleaseDC(None, screen);
        an.frame += 1;
        false
    });
    if done {
        let _ = ShowWindow(h, SW_HIDE);
        ANIM.with_borrow_mut(|a| a.take().map(|x| free(x)));
    }
    if done && wall_done {
        let _ = KillTimer(Some(h), 1);
    }
}

unsafe extern "system" fn wndproc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match m {
        WM_APP => start(h),
        WM_TIMER => frame(h),
        _ => return DefWindowProcW(h, m, wp, lp),
    }
    LRESULT(0)
}

fn run() {
    unsafe {
        let inst = GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: inst.into(), lpszClassName: w!("HeraRipple"), ..Default::default() };
        RegisterClassW(&wc);
        let ex = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        let Ok(h) = CreateWindowExW(ex, w!("HeraRipple"), w!(""), WS_POPUP, 0, 0, 1, 1, None, None, Some(inst.into()), None) else { return };
        if let Ok(wh) = CreateWindowExW(ex, w!("HeraRipple"), w!(""), WS_POPUP, 0, 0, 1, 1, None, None, Some(inst.into()), None) {
            WALL_HOST.store(wh.0 as isize, Ordering::Relaxed);
        }
        HOST.store(h.0 as isize, Ordering::Relaxed);
        start(h);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ripple_frames() {
        let (w, h) = (128usize, 256usize);
        let mut buf = vec![0u32; w * h];
        let alpha = |b: &[u32], x: usize, y: usize| b[y * w + x] >> 24;
        // 초반: 가장자리 중심(왼쪽 가장자리 0, 128) 근처가 밝고 먼 모서리는 투명
        render(&mut buf, w, h, 0.0, 128.0, 0.1, 0.95, false);
        assert!(alpha(&buf, 2, 128) > 40);
        assert_eq!(alpha(&buf, 127, 0), 0);
        // premultiplied: 색 성분 ≤ 알파
        assert!(buf.iter().all(|&p| ((p >> 16) & 255) <= p >> 24 && (p & 255) <= p >> 24));
        // 퍼진다: 중간에는 고리가 바깥쪽에 있다
        render(&mut buf, w, h, 0.0, 128.0, 0.5, 0.95, false);
        let ring = (0..w).max_by_key(|&x| alpha(&buf, x, 128)).unwrap();
        assert!(ring > 30, "ring at {ring}");
        // 끝: 거의 사라짐
        render(&mut buf, w, h, 0.0, 128.0, 0.999, 0.95, false);
        assert!(buf.iter().all(|&p| p >> 24 < 8));
        // 옅은 물결(떠난 쪽)은 더 흐리다
        let mut weak = vec![0u32; w * h];
        render(&mut buf, w, h, 0.0, 128.0, 0.2, 0.95, false);
        render(&mut weak, w, h, 0.0, 128.0, 0.2, 0.35, false);
        assert!(weak.iter().map(|p| p >> 24).max() < buf.iter().map(|p| p >> 24).max());
        // 움직임 줄이기: 중심만 빛나고 바깥 고리 없음
        render(&mut buf, w, h, 64.0, 128.0, 0.5, 0.95, true);
        assert!(alpha(&buf, 64, 128) > alpha(&buf, 64, 20));
    }

    /// 눈으로 보기: HERA_RIPPLE_PNG=<경로> cargo test --lib ripple_png -- --ignored (프레임 5장을 어두운 배경에 가로로)
    #[test]
    #[ignore]
    fn ripple_png() {
        let (w, h, n) = (256usize, 512usize, 5usize);
        let mut out = vec![0u8; w * n * h * 3];
        let mut buf = vec![0u32; w * h];
        for f in 0..n {
            render(&mut buf, w, h, 0.0, 256.0, f as f32 * 0.18 + 0.02, 0.95, false);
            for y in 0..h {
                for x in 0..w {
                    let p = buf[y * w + x];
                    let a = (p >> 24) as f32 / 255.0;
                    let bg = [30.0, 34.0, 44.0];
                    let o = (y * w * n + f * w + x) * 3;
                    for (i, sh) in [16u32, 8, 0].iter().enumerate() {
                        out[o + i] = (((p >> sh) & 255) as f32 + bg[i] * (1.0 - a)) as u8;
                    }
                }
            }
        }
        let f = std::fs::File::create(std::env::var("HERA_RIPPLE_PNG").unwrap()).unwrap();
        let mut e = png::Encoder::new(f, (w * n) as u32, h as u32);
        e.set_color(png::ColorType::Rgb);
        e.write_header().unwrap().write_image_data(&out).unwrap();
    }

    #[test]
    fn ripple_geometry() {
        let req = |edge: Option<&str>, kind| Req { x: 1920, y: 500, edge: edge.map(String::from), kind, wall: None };
        assert_eq!(geometry(&req(Some("right"), Kind::Leave), 256), (1664, 244, 256, 512, 256.0, 256.0));
        assert_eq!(geometry(&req(Some("left"), Kind::Enter), 256), (1920, 244, 256, 512, 0.0, 256.0));
        assert_eq!(geometry(&req(None, Kind::Locate), 256), (1728, 308, 384, 384, 192.0, 192.0));
    }
}
