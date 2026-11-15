// v2 클립보드 기록: 메시지 전용 창 + AddClipboardFormatListener (폴링 없음).
// 최근 텍스트 20개를 메모리에만 둔다 (디스크에 쓰지 않음 — 재시작하면 사라짐). 변화는 팔레트 창에 'clips' 로.
use std::collections::VecDeque;
use std::sync::atomic::{AtomicIsize, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::w;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
    SetClipboardData,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLIPBOARDUPDATE, WNDCLASSW,
};

const MAX_ITEMS: usize = 20;
/// 이보다 긴 텍스트(UTF-16 단위)는 기록하지 않는다 — 20개 × 64K ≈ 최대 2.5MB
const MAX_LEN: usize = 64 * 1024;

#[derive(Clone, Serialize, PartialEq, Debug)]
pub struct Clip {
    id: String,
    text: String,
    at: i64,
}

static RING: Mutex<VecDeque<Clip>> = Mutex::new(VecDeque::new());
static OWNER: AtomicIsize = AtomicIsize::new(0);
static NEXT: AtomicU64 = AtomicU64::new(1);
static APP: OnceLock<AppHandle> = OnceLock::new();

/// 맨 앞에 넣기 (같은 텍스트는 앞으로 옮김). 공백뿐이거나 이미 맨 앞이면 false.
fn push(ring: &mut VecDeque<Clip>, text: String, at: i64, id: u64) -> bool {
    if text.trim().is_empty() || ring.front().is_some_and(|c| c.text == text) {
        return false;
    }
    ring.retain(|c| c.text != text);
    ring.push_front(Clip { id: format!("c{id}"), text, at });
    ring.truncate(MAX_ITEMS);
    true
}

pub fn list() -> Vec<Clip> {
    RING.lock().unwrap().iter().cloned().collect()
}

unsafe fn open() -> bool {
    // 다른 프로세스가 잠깐 열고 있을 수 있다 → 몇 번 재시도
    for _ in 0..6 {
        if OpenClipboard(Some(HWND(OWNER.load(Ordering::Relaxed) as _))).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    false
}

/// 비밀번호 관리자 등이 '기록하지 말 것' 으로 표시한 내용인가 (클립보드가 열린 상태에서 부를 것)
unsafe fn private() -> bool {
    let has = |f: u32| IsClipboardFormatAvailable(f).is_ok();
    if has(RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing"))) || has(RegisterClipboardFormatW(w!("Clipboard Viewer Ignore"))) {
        return true;
    }
    let hist = RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory"));
    if has(hist) {
        // DWORD 0 = 기록 금지. 읽지 못하면 안전하게 금지로 본다.
        let Ok(h) = GetClipboardData(hist) else { return true };
        let p = GlobalLock(HGLOBAL(h.0)) as *const u32;
        if p.is_null() {
            return true;
        }
        let v = *p;
        let _ = GlobalUnlock(HGLOBAL(h.0));
        return v == 0;
    }
    false
}

unsafe fn read_text() -> Option<String> {
    if private() || IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32).is_err() {
        return None;
    }
    let h = GetClipboardData(CF_UNICODETEXT.0 as u32).ok()?;
    let g = HGLOBAL(h.0);
    let p = GlobalLock(g) as *const u16;
    if p.is_null() {
        return None;
    }
    let s = std::slice::from_raw_parts(p, GlobalSize(g) / 2);
    let n = s.iter().position(|&c| c == 0).unwrap_or(s.len());
    let t = (n <= MAX_LEN).then(|| String::from_utf16_lossy(&s[..n]));
    let _ = GlobalUnlock(g);
    t
}

fn on_update() {
    let text = unsafe {
        if !open() {
            return;
        }
        let t = read_text();
        let _ = CloseClipboard();
        t
    };
    let Some(text) = text else { return };
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let snapshot = {
        let mut r = RING.lock().unwrap();
        if !push(&mut r, text, at, NEXT.fetch_add(1, Ordering::Relaxed)) {
            return;
        }
        r.iter().cloned().collect::<Vec<_>>()
    };
    if let Some(app) = APP.get() {
        let _ = app.emit_to("palette", "clips", snapshot);
    }
}

/// 팔레트에서 고른 기록을 다시 클립보드에 (소유 창 = 메시지 전용 창 — NULL 소유자면 SetClipboardData 가 실패한다)
pub fn set(text: &str) -> Result<(), String> {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        if !open() {
            return Err("클립보드를 열 수 없어요".into());
        }
        let r = (|| {
            EmptyClipboard().map_err(|e| e.to_string())?;
            let g = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).map_err(|e| e.to_string())?;
            let p = GlobalLock(g) as *mut u16;
            if p.is_null() {
                let _ = GlobalFree(Some(g));
                return Err("GlobalLock".to_string());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), p, wide.len());
            let _ = GlobalUnlock(g);
            // 성공하면 메모리 소유권은 시스템으로 넘어간다
            SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(g.0))).map(|_| ()).map_err(|e| {
                let _ = GlobalFree(Some(g));
                e.to_string()
            })
        })();
        let _ = CloseClipboard();
        r
    }
}

unsafe extern "system" fn wndproc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if m == WM_CLIPBOARDUPDATE {
        on_update();
        return LRESULT(0);
    }
    DefWindowProcW(h, m, wp, lp)
}

pub fn start(app: AppHandle) {
    let _ = APP.set(app);
    std::thread::spawn(|| unsafe {
        let inst = GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: inst.into(), lpszClassName: w!("HeraClipboard"), ..Default::default() };
        RegisterClassW(&wc);
        let Ok(h) = CreateWindowExW(WINDOW_EX_STYLE(0), w!("HeraClipboard"), w!(""), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(inst.into()), None) else {
            eprintln!("clipboard: CreateWindowExW failed");
            return;
        };
        OWNER.store(h.0 as isize, Ordering::Relaxed);
        if let Err(e) = AddClipboardFormatListener(h) {
            eprintln!("clipboard: {e}");
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            DispatchMessageW(&msg);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_rules() {
        let mut r = VecDeque::new();
        assert!(push(&mut r, "a".into(), 1, 1));
        assert!(push(&mut r, "b".into(), 2, 2));
        assert!(!push(&mut r, "b".into(), 3, 3)); // 이미 맨 앞
        assert!(!push(&mut r, "  \n".into(), 4, 4)); // 공백뿐
        assert!(push(&mut r, "a".into(), 5, 5)); // 다시 복사 → 맨 앞으로, 중복 없음
        assert_eq!(r.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(r[0].at, 5);
        for i in 0..30 {
            push(&mut r, format!("t{i}"), 10 + i, 10 + i as u64);
        }
        assert_eq!(r.len(), MAX_ITEMS);
        assert_eq!(r[0].text, "t29");
    }

    /// 수동: cargo test clipboard_roundtrip -- --ignored (사용자 클립보드를 덮어쓴다)
    #[test]
    #[ignore]
    fn clipboard_roundtrip() {
        set("hera-test").unwrap();
        let t = unsafe {
            assert!(open());
            let t = read_text();
            let _ = CloseClipboard();
            t
        };
        assert_eq!(t.as_deref(), Some("hera-test"));
    }
}
