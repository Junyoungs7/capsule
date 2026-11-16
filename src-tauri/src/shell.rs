// 셸 이벤트 스레드: 숨은 창 1개 + WinEvent 훅(포그라운드 · IME 변경).
// - 한/영 상태 → Island '한/A' 칩, 맥에 커서가 있는 동안 한/영 키 가로채기 (Hera Link)
// - list(): MCP `list_running_apps`·`activate_app` 용 요청 시 1회 열거 (상시 훅·이벤트 없음 — 독/작업 표시줄 대체는 지웠다)
use std::sync::atomic::{AtomicI32, AtomicIsize, Ordering};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{w, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::watch;

#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Win {
    hwnd: isize,
    keys: Vec<String>, // 레코드 매칭용 (shell:appsfolder\<aumid>, exe 경로 — 소문자)
    title: String,
    exe: String,
    aumid: String,
    min: bool,
}

static HOST: AtomicIsize = AtomicIsize::new(0);
static APP: OnceLock<AppHandle> = OnceLock::new();
/// v3 앱 메모: 앞 앱 창 (Hera 자기 창 제외) + 그 스레드에만 건 위치 변경 훅
const T_IME: usize = 4;
const WM_IME_HOOK: u32 = WM_APP + 1; // wParam 1 = 한/영 가로채기 켜기, 0 = 끄기
static KB_HOOK: AtomicIsize = AtomicIsize::new(0);
static IME_STATE: AtomicI32 = AtomicI32::new(-1);
type ImeCb = Box<dyn Fn() + Send + Sync>;
static ON_HANGUL: OnceLock<ImeCb> = OnceLock::new();

/// 맥에 커서가 있는 동안 한/영(VK_HANGUL)을 가로채 넘길 곳 (link.rs 가 1번 등록)
pub fn on_hangul(f: impl Fn() + Send + Sync + 'static) {
    let _ = ON_HANGUL.set(Box::new(f));
}

/// 한/영 가로채기 켜기/끄기. 커서가 맥에 있는 동안만 켠다: 그때는 Deskflow 의 저수준 훅이 키를 삼켜 앱은 한/영을 못 본다.
/// 우리 훅은 나중에 걸려 먼저 받는다 → VK_HANGUL 만 삼키고 나머지는 그대로 넘긴다. 윈도우로 돌아오면 바로 푼다.
pub fn ime_forward(on: bool) {
    let h = HOST.load(Ordering::Relaxed);
    if h != 0 {
        unsafe {
            let _ = PostMessageW(Some(HWND(h as _)), WM_IME_HOOK, WPARAM(on as usize), LPARAM(0));
        }
    }
}

unsafe extern "system" fn kbproc(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    use windows::Win32::UI::Input::KeyboardAndMouse::VK_HANGUL;
    if code == HC_ACTION as i32 {
        let k = &*(lp.0 as *const KBDLLHOOKSTRUCT);
        if k.vkCode == VK_HANGUL.0 as u32 && k.flags.0 & LLKHF_INJECTED.0 == 0 {
            if wp.0 as u32 == WM_KEYDOWN || wp.0 as u32 == WM_SYSKEYDOWN {
                std::thread::spawn(|| ON_HANGUL.get().map(|f| f())); // 훅 안에서는 오래 머물지 않는다
            }
            return LRESULT(1);
        }
    }
    CallNextHookEx(None, code, wp, lp)
}

/// 앞 창의 한/영 상태 (0 = 영, 1 = 한, -1 = 모름) — IME 기본 창에 IMC_GETCONVERSIONMODE (IME_CMODE_NATIVE)
fn ime_state() -> i32 {
    use windows::Win32::UI::Input::Ime::ImmGetDefaultIMEWnd;
    unsafe {
        let fg = GetForegroundWindow();
        let ime = ImmGetDefaultIMEWnd(fg);
        if ime.is_invalid() {
            return -1;
        }
        let mut r = 0usize;
        // WM_IME_CONTROL(0x283), IMC_GETCONVERSIONMODE(1)
        if SendMessageTimeoutW(ime, 0x283, WPARAM(1), LPARAM(0), SMTO_ABORTIFHUNG, 50, Some(&mut r)).0 == 0 {
            return -1;
        }
        (r & 1) as i32
    }
}

fn check_ime() {
    let st = ime_state();
    if st >= 0 && IME_STATE.swap(st, Ordering::Relaxed) != st {
        if let Some(app) = APP.get() {
            let _ = app.emit_to("island", "ime-state", serde_json::json!({ "source": if st == 1 { "ko" } else { "en" }, "from": "win" }));
        }
    }
}

/// 작업 표시줄에 뜨는 창인가 (Explorer 규칙): 보임 + 클로킹 아님 + (APPWINDOW 이거나, 소유자 없음 + TOOLWINDOW·NOACTIVATE 아님)
pub fn eligible(visible: bool, cloaked: bool, owned: bool, ex: isize) -> bool {
    let has = |f: WINDOW_EX_STYLE| ex & f.0 as isize != 0;
    visible && !cloaked && (has(WS_EX_APPWINDOW) || (!owned && !has(WS_EX_TOOLWINDOW) && !has(WS_EX_NOACTIVATE)))
}

pub unsafe fn eligible_hwnd(h: HWND) -> bool {
    let mut cloaked = 0u32;
    let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), 4);
    let owned = GetWindow(h, GW_OWNER).is_ok_and(|o| !o.is_invalid());
    eligible(IsWindowVisible(h).as_bool(), cloaked != 0, owned, GetWindowLongPtrW(h, GWL_EXSTYLE)) && GetWindowTextLengthW(h) > 0
}

/// 지금 작업 표시줄에 뜬 앱 창 (Hera 자기 창 제외), z-순서. MCP 가 부를 때만 1회 열거.
pub fn list() -> Vec<Win> {
    unsafe extern "system" fn collect(h: HWND, l: LPARAM) -> BOOL {
        (*(l.0 as *mut Vec<HWND>)).push(h);
        true.into()
    }
    let mut all: Vec<HWND> = vec![];
    let me = unsafe { GetCurrentProcessId() };
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut _ as isize));
    }
    all.into_iter()
        .filter(|&h| unsafe { eligible_hwnd(h) })
        .filter_map(|h| unsafe {
            let i = watch::info(h);
            if i.pid == me {
                return None;
            }
            let mut keys = vec![];
            if !i.aumid.is_empty() {
                keys.push(format!(r"shell:appsfolder\{}", i.aumid).to_lowercase());
            }
            if !i.exe_path.is_empty() {
                keys.push(i.exe_path.to_lowercase());
            }
            let mut buf = [0u16; 256];
            let n = GetWindowTextW(h, &mut buf) as usize;
            Some(Win { hwnd: h.0 as isize, keys, title: String::from_utf16_lossy(&buf[..n]), exe: i.exe_path, aumid: i.aumid, min: IsIconic(h).as_bool() })
        })
        .collect()
}

unsafe extern "system" fn on_event(_: HWINEVENTHOOK, ev: u32, h: HWND, obj: i32, child: i32, _: u32, _: u32) {
    if ev == 0x8029 {
        // EVENT_OBJECT_IME_CHANGE: 오는 객체가 제각각 → 60ms 뒤 앞 창 상태를 한 번 읽는다
        SetTimer(Some(HWND(HOST.load(Ordering::Relaxed) as _)), T_IME, 60, None);
        return;
    }
    if ev == EVENT_SYSTEM_FOREGROUND && obj == OBJID_WINDOW.0 && child == CHILDID_SELF as i32 && !h.is_invalid() {
        IME_STATE.store(-1, Ordering::Relaxed); // 새 앞 창: 칩은 다음 변화 때만 (a4: 앱 메모 창 따라가기 훅은 메모 보드로 바뀌며 지움)
    }
}

unsafe extern "system" fn wndproc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match m {
        WM_TIMER => {
            let _ = KillTimer(Some(h), wp.0);
            if wp.0 == T_IME {
                check_ime();
            }
            LRESULT(0)
        }
        WM_IME_HOOK => {
            let cur = KB_HOOK.load(Ordering::Relaxed);
            if wp.0 == 1 && cur == 0 {
                let inst = GetModuleHandleW(None).unwrap_or_default();
                if let Ok(hk) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kbproc), Some(inst.into()), 0) {
                    KB_HOOK.store(hk.0 as isize, Ordering::Relaxed);
                }
            } else if wp.0 == 0 && cur != 0 {
                let _ = UnhookWindowsHookEx(HHOOK(cur as _));
                KB_HOOK.store(0, Ordering::Relaxed);
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(h, m, wp, lp),
    }
}

pub fn start(app: AppHandle) {
    let _ = APP.set(app);
    std::thread::spawn(|| unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let inst = GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: inst.into(), lpszClassName: w!("HeraShell"), ..Default::default() };
        RegisterClassW(&wc);
        // 메시지 전용 창 (한 번도 보이지 않음)
        let Ok(h) = CreateWindowExW(WINDOW_EX_STYLE(0), w!("HeraShell"), w!(""), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(inst.into()), None) else {
            eprintln!("shell: CreateWindowExW failed");
            return;
        };
        HOST.store(h.0 as isize, Ordering::Relaxed);
        let flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
        SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(on_event), 0, 0, flags);
        SetWinEventHook(0x8029, 0x8029, None, Some(on_event), 0, 0, flags); // EVENT_OBJECT_IME_CHANGE
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
    fn taskbar_rules() {
        let (app, tool, noact) = (WS_EX_APPWINDOW.0 as isize, WS_EX_TOOLWINDOW.0 as isize, WS_EX_NOACTIVATE.0 as isize);
        assert!(eligible(true, false, false, 0)); // 평범한 최상위 창
        assert!(!eligible(false, false, false, 0)); // 숨김
        assert!(!eligible(true, true, false, 0)); // 클로킹 (다른 가상 데스크톱·일시 중단된 UWP)
        assert!(!eligible(true, false, true, 0)); // 소유 창 (대화상자)
        assert!(eligible(true, false, true, app)); // 소유 창이라도 APPWINDOW 면 뜬다
        assert!(!eligible(true, false, false, tool)); // 툴윈도우 (Hera 창 등)
        assert!(eligible(true, false, false, tool | app));
        assert!(!eligible(true, false, false, noact));
    }
}
