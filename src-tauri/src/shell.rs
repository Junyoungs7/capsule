// 셸 스레드: 메시지 전용 창 1개 + (맥에 커서가 있는 동안만) 저수준 키보드 훅 — 한/영 키를 맥으로 넘긴다 (Hera Link).
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::OnceLock;

use tauri::AppHandle;
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

static HOST: AtomicIsize = AtomicIsize::new(0);
const WM_IME_HOOK: u32 = WM_APP + 1; // wParam 1 = 한/영 가로채기 켜기, 0 = 끄기
static KB_HOOK: AtomicIsize = AtomicIsize::new(0);
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

unsafe extern "system" fn wndproc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match m {
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

pub fn start(_: AppHandle) {
    std::thread::spawn(|| unsafe {
        let inst = GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: inst.into(), lpszClassName: w!("HeraShell"), ..Default::default() };
        RegisterClassW(&wc);
        // 메시지 전용 창 (한 번도 보이지 않음)
        let Ok(h) = CreateWindowExW(WINDOW_EX_STYLE(0), w!("HeraShell"), w!(""), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(inst.into()), None) else {
            eprintln!("shell: CreateWindowExW failed");
            return;
        };
        HOST.store(h.0 as isize, Ordering::Relaxed);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            DispatchMessageW(&msg);
        }
    });
}
