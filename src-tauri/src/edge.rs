// 화면 가장자리로 파일 끌어 보내기 (Hera Link). 입력 엔진은 OLE 드래그를 실어 나르지 못하므로 Hera 가 받는다:
// 맥과 이어진 가장자리 구간마다 얇은 띠 창(4px, 평소엔 클릭 통과 + 거의 투명). watch 루프가 '바깥에서 누른 채 끄는 중' 이고
// 커서가 띠 근처면 통과를 풀어 OLE 드롭 대상이 되게 한다 → Drop 이면 포탈이 빨아들이고(drag.rs) 파일 채널로 맥에 보냄.
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};

use windows::core::{implement, w, Ref};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINTL, WPARAM};
use windows::Win32::Graphics::Gdi::CreateSolidBrush;
use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::{IDropTarget, IDropTarget_Impl, OleInitialize, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::*;

/// 띠 1개: 창, 화면 rect [l, t, r, b] (물리 px), 방향(윈도우 기준 left/right/up/down), 그 구간의 맥 쪽 % (pos 계산용)
#[derive(Clone)]
struct Strip {
    hwnd: isize,
    rect: [i32; 4],
    side: String,
    mac: (f64, f64),
}

static STRIPS: Mutex<Vec<Strip>> = Mutex::new(Vec::new());
type Want = Vec<(String, [i32; 4], (f64, f64))>;
static PENDING: Mutex<Option<Want>> = Mutex::new(None);
static HOST: AtomicIsize = AtomicIsize::new(0);
static ARMED: AtomicBool = AtomicBool::new(false);
static STARTED: OnceLock<()> = OnceLock::new();
type OnDrop = Box<dyn Fn(Vec<String>, String, f64, (i32, i32)) + Send + Sync>;
static ON_DROP: OnceLock<OnDrop> = OnceLock::new();
const THICK: i32 = 4;

/// 드롭 콜백 (paths, 맥 쪽 가장자리, 맥 가장자리 위 위치 0..1, 드롭 지점) — link.rs 가 1번 등록
pub fn on_drop(f: impl Fn(Vec<String>, String, f64, (i32, i32)) + Send + Sync + 'static) {
    let _ = ON_DROP.set(Box::new(f));
}

/// 띠 다시 놓기: (윈도우 방향, 가장자리 구간 [x, y, w, h] — 두께 0, 맥 % 구간). 빈 목록 = 모두 치움
pub fn set(segs: Vec<(String, [f64; 4], (f64, f64))>) {
    let v = segs
        .into_iter()
        .map(|(side, e, mac)| {
            let (x, y, w, h) = (e[0].round() as i32, e[1].round() as i32, e[2].round() as i32, e[3].round() as i32);
            // 가장자리 안쪽으로 THICK px
            let r = match side.as_str() {
                "right" => [x - THICK, y, x, y + h],
                "left" => [x, y, x + THICK, y + h],
                "down" => [x, y - THICK, x + w, y],
                _ => [x, y, x + w, y + THICK],
            };
            (side, r, mac)
        })
        .collect();
    *PENDING.lock().unwrap() = Some(v);
    if STARTED.set(()).is_ok() {
        std::thread::spawn(run);
    } else if let h @ 1.. = HOST.load(Ordering::Relaxed) {
        unsafe {
            let _ = PostMessageW(Some(HWND(h as _)), WM_APP, WPARAM(0), LPARAM(0));
        }
    }
}

/// 띠 근처인가 (가장자리 쪽으로 48px 까지) — watch 루프용 순수 판정
fn near(r: [i32; 4], side: &str, x: i32, y: i32) -> bool {
    let m = 48;
    match side {
        "right" => x >= r[0] - m && x <= r[2] && y >= r[1] && y < r[3],
        "left" => x >= r[0] && x <= r[2] + m && y >= r[1] && y < r[3],
        "down" => y >= r[1] - m && y <= r[3] && x >= r[0] && x < r[2],
        _ => y >= r[1] && y <= r[3] + m && x >= r[0] && x < r[2],
    }
}

/// watch 루프 30Hz: 바깥에서 누른 채 끄는 중(drag) + 띠 근처면 받기 모드(클릭 통과 해제), 아니면 통과
pub fn tick(x: i32, y: i32, drag: bool) {
    let want = drag && STRIPS.lock().unwrap().iter().any(|s| near(s.rect, &s.side, x, y));
    if ARMED.swap(want, Ordering::Relaxed) == want {
        return;
    }
    for s in STRIPS.lock().unwrap().iter() {
        let h = HWND(s.hwnd as _);
        unsafe {
            let cur = GetWindowLongPtrW(h, GWL_EXSTYLE);
            let t = WS_EX_TRANSPARENT.0 as isize;
            SetWindowLongPtrW(h, GWL_EXSTYLE, if want { cur & !t } else { cur | t });
        }
    }
}

/// 띠는 늘 알파 1 (안 보이지만 드롭 대상은 됨) — 보이는 것은 오버레이의 포탈 (drag.rs)
unsafe fn faint(h: HWND) {
    let _ = SetLayeredWindowAttributes(h, COLORREF(0), 1, LWA_ALPHA);
}

#[implement(IDropTarget)]
struct Target {
    hwnd: isize,
    ok: std::cell::Cell<bool>,
}

unsafe fn paths(data: &IDataObject) -> Vec<String> {
    let fmt = FORMATETC { cfFormat: CF_HDROP.0, ptd: std::ptr::null_mut(), dwAspect: DVASPECT_CONTENT.0, lindex: -1, tymed: TYMED_HGLOBAL.0 as u32 };
    let Ok(mut stg) = data.GetData(&fmt) else { return vec![] };
    let drop = HDROP(stg.u.hGlobal.0);
    let n = DragQueryFileW(drop, u32::MAX, None);
    let mut out = vec![];
    for i in 0..n {
        let len = DragQueryFileW(drop, i, None) as usize;
        let mut buf = vec![0u16; len + 1];
        DragQueryFileW(drop, i, Some(&mut buf));
        out.push(String::from_utf16_lossy(&buf[..len]));
    }
    ReleaseStgMedium(&mut stg);
    out
}

impl IDropTarget_Impl for Target_Impl {
    fn DragEnter(&self, data: Ref<IDataObject>, _: MODIFIERKEYS_FLAGS, _: &POINTL, effect: *mut DROPEFFECT) -> windows::core::Result<()> {
        let fmt = FORMATETC { cfFormat: CF_HDROP.0, ptd: std::ptr::null_mut(), dwAspect: DVASPECT_CONTENT.0, lindex: -1, tymed: TYMED_HGLOBAL.0 as u32 };
        let ok = data.as_ref().is_some_and(|d| unsafe { d.QueryGetData(&fmt) }.is_ok());
        self.ok.set(ok);
        unsafe { *effect = if ok { DROPEFFECT_COPY } else { DROPEFFECT_NONE } };
        Ok(())
    }
    fn DragOver(&self, _: MODIFIERKEYS_FLAGS, _: &POINTL, effect: *mut DROPEFFECT) -> windows::core::Result<()> {
        unsafe { *effect = if self.ok.get() { DROPEFFECT_COPY } else { DROPEFFECT_NONE } };
        Ok(())
    }
    fn DragLeave(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn Drop(&self, data: Ref<IDataObject>, _: MODIFIERKEYS_FLAGS, pt: &POINTL, effect: *mut DROPEFFECT) -> windows::core::Result<()> {
        unsafe { *effect = DROPEFFECT_COPY };
        let files = data.as_ref().map(|d| unsafe { paths(d) }).unwrap_or_default();
        let strip = STRIPS.lock().unwrap().iter().find(|s| s.hwnd == self.hwnd).cloned();
        if let (Some(s), Some(cb), false) = (strip, ON_DROP.get(), files.is_empty()) {
            // 띠 위 위치 → 맥 가장자리 위 위치(0..1)
            let along = if matches!(s.side.as_str(), "left" | "right") { (pt.y - s.rect[1]) as f64 / (s.rect[3] - s.rect[1]).max(1) as f64 } else { (pt.x - s.rect[0]) as f64 / (s.rect[2] - s.rect[0]).max(1) as f64 };
            let pos = (s.mac.0 + along.clamp(0.0, 1.0) * (s.mac.1 - s.mac.0)) / 100.0;
            let mac_side = match s.side.as_str() {
                "right" => "left",
                "left" => "right",
                "up" => "down",
                _ => "up",
            };
            cb(files, mac_side.into(), pos, (pt.x, pt.y));
        }
        Ok(())
    }
}

unsafe fn rebuild(host: HWND) {
    let Some(want) = PENDING.lock().unwrap().take() else { return };
    let mut strips = STRIPS.lock().unwrap();
    for s in strips.drain(..) {
        let h = HWND(s.hwnd as _);
        let _ = RevokeDragDrop(h);
        let _ = DestroyWindow(h);
    }
    let inst = GetModuleHandleW(None).unwrap_or_default();
    for (side, r, mac) in want {
        let ex = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        let Ok(h) = CreateWindowExW(ex, w!("HeraEdge"), w!(""), WS_POPUP, r[0], r[1], r[2] - r[0], r[3] - r[1], None, None, Some(inst.into()), None) else { continue };
        faint(h);
        let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
        let target: IDropTarget = Target { hwnd: h.0 as isize, ok: false.into() }.into();
        let _ = RegisterDragDrop(h, &target);
        strips.push(Strip { hwnd: h.0 as isize, rect: r, side, mac });
    }
    let _ = host;
}

unsafe extern "system" fn wndproc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if m == WM_APP {
        rebuild(h);
        return LRESULT(0);
    }
    DefWindowProcW(h, m, wp, lp)
}

fn run() {
    unsafe {
        let _ = OleInitialize(None); // RegisterDragDrop = STA + OLE
        let inst = GetModuleHandleW(None).unwrap_or_default();
        let brush = CreateSolidBrush(COLORREF(0x00FF_9A3C)); // BGR → 파랑 (#3C9AFF)
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: inst.into(), lpszClassName: w!("HeraEdge"), hbrBackground: brush, ..Default::default() };
        RegisterClassW(&wc);
        let host_wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: inst.into(), lpszClassName: w!("HeraEdgeHost"), ..Default::default() };
        RegisterClassW(&host_wc);
        let Ok(host) = CreateWindowExW(WINDOW_EX_STYLE(0), w!("HeraEdgeHost"), w!(""), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(inst.into()), None) else { return };
        HOST.store(host.0 as isize, Ordering::Relaxed);
        rebuild(host);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn near_strip() {
        let r = [1916, 540, 1920, 1080]; // 오른쪽 가장자리 아래 절반
        assert!(near(r, "right", 1919, 800));
        assert!(near(r, "right", 1875, 800)); // 48px 안
        assert!(!near(r, "right", 1860, 800)); // 너무 멀다
        assert!(!near(r, "right", 1919, 300)); // 연결 안 된 위 절반
        let top = [0, 0, 960, 4];
        assert!(near(top, "up", 500, 30) && !near(top, "up", 1200, 2));
    }
}
