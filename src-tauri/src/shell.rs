// 작업 표시줄 대체: 실행 중인 앱 창 목록 · 깜빡임 알림 · Win 키 버튼 · DWM 썸네일 · 자동 숨김 작업 표시줄 공존(독 올리기).
// 숨은 최상위 창 1개(브로드캐스트 TaskbarCreated 를 받으려면 메시지 전용 창이면 안 됨) + 셸 훅(창 생성/파괴/활성/깜빡임)
// + WinEvent 훅(표시·숨김·제목·최소화·클로킹·포그라운드). 이벤트는 250ms 디바운스 후 1회 열거 → 바뀌었을 때만 'windows' emit.
// ponytail: 10s 안전망 재열거 — 이벤트가 빠지는 경우가 확인되면 지우거나 줄일 것.
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicI32, AtomicIsize, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{w, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DwmQueryThumbnailSourceSize, DwmRegisterThumbnail, DwmUnregisterThumbnail, DwmUpdateThumbnailProperties, DWMWA_CLOAKED,
    DWM_THUMBNAIL_PROPERTIES, DWM_TNP_RECTDESTINATION, DWM_TNP_SOURCECLIENTAREAONLY, DWM_TNP_VISIBLE,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LWIN, VK_RETURN};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::{taskbar, watch};

#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Win {
    hwnd: isize,
    key: String,       // 묶음 키: shell:appsfolder\<aumid> 또는 exe 경로 (소문자)
    keys: Vec<String>, // 레코드 매칭용 (aumid 키, exe 키)
    title: String,
    exe: String,
    aumid: String,
    min: bool,
    flash: bool,
}

pub static WINS: Mutex<Vec<Win>> = Mutex::new(Vec::new());
static FLASH: Mutex<Vec<isize>> = Mutex::new(Vec::new());
static THUMBS: Mutex<Vec<isize>> = Mutex::new(Vec::new());
static HOST: AtomicIsize = AtomicIsize::new(0);
static SHELLHOOK: AtomicU32 = AtomicU32::new(0);
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
static APP: OnceLock<AppHandle> = OnceLock::new();
/// 자동 숨김 작업 표시줄 공존: 작업 표시줄 창 · 그 스레드에만 건 위치 변경 훅 · 독을 올릴 높이(물리 px)
static TRAY: AtomicIsize = AtomicIsize::new(0);
static TRAY_HOOK: AtomicIsize = AtomicIsize::new(0);
static LIFT: AtomicI32 = AtomicI32::new(0);

const T_REFRESH: usize = 1;
const T_SAFETY: usize = 2;
const T_LIFT: usize = 3;
const HSHELL_FLASH: u32 = 0x8006; // HSHELL_REDRAW | HSHELL_HIGHBIT
const HSHELL_ACTIVATED: u32 = 4;
const HSHELL_RUDEACTIVATED: u32 = 0x8004;

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

thread_local! {
    /// hwnd → (pid, exe, aumid). 창이 사라지면 지운다 (OpenProcess·COM 조회를 창마다 1번만)
    static CACHE: RefCell<HashMap<isize, (u32, String, String)>> = RefCell::new(HashMap::new());
}

unsafe fn refresh() {
    unsafe extern "system" fn collect(h: HWND, l: LPARAM) -> BOOL {
        (*(l.0 as *mut Vec<HWND>)).push(h);
        true.into()
    }
    let mut all: Vec<HWND> = vec![];
    let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut _ as isize));
    let me = GetCurrentProcessId();
    let mut flash = FLASH.lock().unwrap().clone();
    let mut out = vec![];
    CACHE.with_borrow_mut(|cache| {
        let mut seen = vec![];
        for h in all {
            if !eligible_hwnd(h) {
                continue;
            }
            let id = h.0 as isize;
            seen.push(id);
            let (pid, exe, aumid) = cache
                .entry(id)
                .or_insert_with(|| {
                    let i = watch::info(h);
                    (i.pid, i.exe_path, i.aumid)
                })
                .clone();
            if pid == me {
                continue;
            }
            let mut keys = vec![];
            if !aumid.is_empty() {
                keys.push(format!(r"shell:appsfolder\{aumid}").to_lowercase());
            }
            if !exe.is_empty() {
                keys.push(exe.to_lowercase());
            }
            let Some(key) = keys.first().cloned() else { continue };
            let mut buf = [0u16; 256];
            let n = GetWindowTextW(h, &mut buf) as usize;
            out.push(Win { hwnd: id, key, keys, title: String::from_utf16_lossy(&buf[..n]), exe, aumid, min: IsIconic(h).as_bool(), flash: flash.contains(&id) });
        }
        cache.retain(|k, _| seen.contains(k));
        flash.retain(|k| seen.contains(k));
    });
    *FLASH.lock().unwrap() = flash;
    let changed = {
        let mut w = WINS.lock().unwrap();
        (*w != out).then(|| *w = out.clone()).is_some()
    };
    if !changed {
        return;
    }
    let Some(app) = APP.get() else { return };
    // B3 실행 집합(독 실행 점·턴테이블)도 여기서 — watch 루프의 2s 폴링 대체
    let mut keys: Vec<String> = out.iter().flat_map(|w| w.keys.clone()).collect();
    keys.sort();
    keys.dedup();
    let mut st = watch::STATE.lock().unwrap();
    if st.1 != keys {
        st.1 = keys.clone();
        let _ = app.emit("running", keys);
    }
    drop(st);
    let _ = app.emit("windows", out);
}

fn schedule() {
    unsafe {
        SetTimer(Some(HWND(HOST.load(Ordering::Relaxed) as _)), T_REFRESH, 250, None);
    }
}

fn unflash(h: isize) {
    let mut f = FLASH.lock().unwrap();
    if f.contains(&h) {
        f.retain(|&x| x != h);
        drop(f);
        schedule();
    }
}

/// 작업 표시줄이 펼쳐졌는지 다시 계산 → 바뀌면 독에 'taskbar-lift'(물리 px). 펼침/숨김마다 1번씩.
fn update_lift() {
    let tray = HWND(TRAY.load(Ordering::Relaxed) as _);
    let lift = if tray.is_invalid() { 0 } else { taskbar::state(tray).map_or(0, |(m, t, a)| taskbar::dock_lift(m, t, a)) };
    if LIFT.swap(lift, Ordering::Relaxed) != lift {
        if let Some(app) = APP.get() {
            let _ = app.emit_to("dock", "taskbar-lift", lift);
        }
    }
}

pub fn lift() -> i32 {
    LIFT.load(Ordering::Relaxed)
}

unsafe extern "system" fn on_tray(_: HWINEVENTHOOK, _: u32, h: HWND, obj: i32, _: i32, _: u32, _: u32) {
    if obj == OBJID_WINDOW.0 && h.0 as isize == TRAY.load(Ordering::Relaxed) {
        update_lift();
    }
}

/// 위치 변경 훅을 explorer 의 작업 표시줄 스레드에만 건다 (시스템 전체 LOCATIONCHANGE 는 커서 이동마다 와서 비쌈). explorer 재시작 때 다시.
unsafe fn hook_tray() {
    let old = TRAY_HOOK.swap(0, Ordering::Relaxed);
    if old != 0 {
        let _ = UnhookWinEvent(HWINEVENTHOOK(old as _));
    }
    let Ok(tray) = FindWindowW(w!("Shell_TrayWnd"), None) else {
        TRAY.store(0, Ordering::Relaxed);
        return;
    };
    TRAY.store(tray.0 as isize, Ordering::Relaxed);
    let mut pid = 0;
    let tid = GetWindowThreadProcessId(tray, Some(&mut pid));
    let h = SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, None, Some(on_tray), pid, tid, WINEVENT_OUTOFCONTEXT);
    TRAY_HOOK.store(h.0 as isize, Ordering::Relaxed);
    update_lift();
}

unsafe extern "system" fn on_event(_: HWINEVENTHOOK, ev: u32, h: HWND, obj: i32, child: i32, _: u32, _: u32) {
    if obj != OBJID_WINDOW.0 || child != CHILDID_SELF as i32 || h.is_invalid() {
        return;
    }
    match ev {
        EVENT_SYSTEM_FOREGROUND => {
            unflash(h.0 as isize);
            schedule();
        }
        _ if GetAncestor(h, GA_ROOT) != h => {}
        _ => schedule(),
    }
}

unsafe extern "system" fn wndproc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match m {
        WM_TIMER => {
            match wp.0 {
                T_REFRESH => {
                    let _ = KillTimer(Some(h), T_REFRESH);
                    refresh();
                }
                T_SAFETY => refresh(),
                T_LIFT => {
                    let _ = KillTimer(Some(h), T_LIFT);
                    update_lift();
                }
                _ => {}
            }
            LRESULT(0)
        }
        // 디스플레이 변경: explorer 가 작업 표시줄을 다시 놓은 뒤 다시 계산
        WM_DISPLAYCHANGE => {
            SetTimer(Some(h), T_LIFT, 1500, None);
            DefWindowProcW(h, m, wp, lp)
        }
        _ if m != 0 && m == SHELLHOOK.load(Ordering::Relaxed) => {
            let target = lp.0;
            match wp.0 as u32 {
                HSHELL_FLASH => {
                    let mut f = FLASH.lock().unwrap();
                    if !f.contains(&target) && GetForegroundWindow().0 as isize != target {
                        f.push(target);
                    }
                }
                HSHELL_ACTIVATED | HSHELL_RUDEACTIVATED => FLASH.lock().unwrap().retain(|&x| x != target),
                _ => {}
            }
            schedule();
            LRESULT(0)
        }
        // explorer 재시작: 셸 훅·작업 표시줄 훅 다시 등록
        _ if m != 0 && m == TASKBAR_CREATED.load(Ordering::Relaxed) => {
            let _ = DeregisterShellHookWindow(h);
            let _ = RegisterShellHookWindow(h);
            hook_tray();
            schedule();
            LRESULT(0)
        }
        _ => DefWindowProcW(h, m, wp, lp),
    }
}

pub fn start(app: AppHandle) {
    let _ = APP.set(app);
    std::thread::spawn(|| unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED); // watch::info 의 창 AUMID 조회 (COM)
        let inst = GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: inst.into(), lpszClassName: w!("HeraShell"), ..Default::default() };
        RegisterClassW(&wc);
        // 보이지 않는 최상위 팝업 (한 번도 Show 하지 않음). 툴윈도우라 Alt+Tab·작업 표시줄에도 없음.
        let Ok(h) = CreateWindowExW(WS_EX_TOOLWINDOW, w!("HeraShell"), w!(""), WS_POPUP, 0, 0, 0, 0, None, None, Some(inst.into()), None) else {
            eprintln!("shell: CreateWindowExW failed");
            return;
        };
        HOST.store(h.0 as isize, Ordering::Relaxed);
        SHELLHOOK.store(RegisterWindowMessageW(w!("SHELLHOOK")), Ordering::Relaxed);
        TASKBAR_CREATED.store(RegisterWindowMessageW(w!("TaskbarCreated")), Ordering::Relaxed);
        if !RegisterShellHookWindow(h).as_bool() {
            eprintln!("shell: RegisterShellHookWindow failed (깜빡임 알림 없음)");
        }
        let flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
        for (a, b) in [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
            (EVENT_OBJECT_SHOW, EVENT_OBJECT_HIDE),
            (EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE),
            (EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED),
        ] {
            SetWinEventHook(a, b, None, Some(on_event), 0, 0, flags);
        }
        hook_tray();
        refresh();
        SetTimer(Some(h), T_SAFETY, 10_000, None);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            DispatchMessageW(&msg);
        }
    });
}

pub fn list() -> Vec<Win> {
    WINS.lock().unwrap().clone()
}

/// 독에서 실행 중 앱 클릭: 최소화면 복원, 이미 맨 앞이면 최소화, 아니면 앞으로.
pub fn click(h: isize) -> Result<(), String> {
    let h = HWND(h as _);
    unsafe {
        if !IsWindow(Some(h)).as_bool() {
            return Err("창이 닫혔어요".into());
        }
        if IsIconic(h).as_bool() {
            let _ = ShowWindowAsync(h, SW_RESTORE);
            return watch::focus(h);
        }
        if GetForegroundWindow() == h {
            let _ = ShowWindowAsync(h, SW_MINIMIZE);
            return Ok(());
        }
    }
    watch::focus(h)
}

pub fn close(h: isize) -> Result<(), String> {
    unsafe { PostMessageW(Some(HWND(h as _)), WM_CLOSE, WPARAM(0), LPARAM(0)) }.map_err(|e| e.to_string())
}

fn send(vks: &[VIRTUAL_KEY]) -> Result<(), String> {
    let ev = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() }, ..Default::default() } },
    };
    let inputs: Vec<INPUT> = vks.iter().map(|&v| ev(v, false)).chain(vks.iter().rev().map(|&v| ev(v, true))).collect();
    let n = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if n as usize == inputs.len() { Ok(()) } else { Err("키 입력을 보내지 못했어요".into()) }
}

/// 독 왼쪽 버튼: 시작(Win) · 숨은 트레이(Win+B → Enter) · 빠른 설정(Win+A) · 알림 센터(Win+N).
/// 독은 NOACTIVATE 라 포커스가 그대로 앱에 있다 → 키는 셸이 받는다.
pub fn key(kind: &str) -> Result<(), String> {
    let k = |c: u8| VIRTUAL_KEY(c as u16);
    match kind {
        "start" => send(&[VK_LWIN]),
        "quick" => send(&[VK_LWIN, k(b'A')]),
        "notify" => send(&[VK_LWIN, k(b'N')]),
        "tray" => {
            send(&[VK_LWIN, k(b'B')])?;
            std::thread::sleep(std::time::Duration::from_millis(200));
            send(&[VK_RETURN]) // Win+B 는 트레이 첫 항목(숨은 아이콘 ^)에 포커스 → Enter 로 펼침
        }
        _ => Err(format!("unknown key {kind}")),
    }
}

/// 썸네일 rect: 원본 비율 유지, 칸 [x, y, w, h] 가운데
fn fit(sw: i32, sh: i32, r: [f64; 4]) -> RECT {
    let k = if sw > 0 && sh > 0 { (r[2] / sw as f64).min(r[3] / sh as f64) } else { 1.0 };
    let (w, h) = if sw > 0 && sh > 0 { (sw as f64 * k, sh as f64 * k) } else { (r[2], r[3]) };
    let (x, y) = (r[0] + (r[2] - w) / 2.0, r[1] + (r[3] - h) / 2.0);
    RECT { left: x.round() as i32, top: y.round() as i32, right: (x + w).round() as i32, bottom: (y + h).round() as i32 }
}

/// 창 목록 팝오버의 DWM 썸네일: 이전 것은 모두 해제하고 (src, 칸 rect — 독 창 기준 물리 px) 마다 등록. 빈 목록 = 해제만. 등록 수 반환.
pub fn thumbs(dest: HWND, list: Vec<(isize, [f64; 4])>) -> usize {
    let mut t = THUMBS.lock().unwrap();
    unsafe {
        for &id in t.iter() {
            let _ = DwmUnregisterThumbnail(id);
        }
        t.clear();
        for (src, r) in list {
            let Ok(id) = DwmRegisterThumbnail(dest, HWND(src as _)) else { continue };
            let sz: SIZE = DwmQueryThumbnailSourceSize(id).unwrap_or_default();
            let p = DWM_THUMBNAIL_PROPERTIES {
                dwFlags: DWM_TNP_RECTDESTINATION | DWM_TNP_VISIBLE | DWM_TNP_SOURCECLIENTAREAONLY,
                rcDestination: fit(sz.cx, sz.cy, r),
                fVisible: true.into(),
                fSourceClientAreaOnly: false.into(),
                ..Default::default()
            };
            if DwmUpdateThumbnailProperties(id, &p).is_ok() {
                t.push(id);
            } else {
                let _ = DwmUnregisterThumbnail(id);
            }
        }
    }
    t.len()
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
        assert!(!eligible(true, false, false, tool)); // 툴윈도우 (Hera 독 등)
        assert!(eligible(true, false, false, tool | app));
        assert!(!eligible(true, false, false, noact));
    }

    #[test]
    fn thumb_fit() {
        let r = fit(1600, 900, [10.0, 20.0, 160.0, 100.0]); // 16:9 → 160×90, 위아래 5px
        assert_eq!((r.left, r.top, r.right, r.bottom), (10, 25, 170, 115));
        let r = fit(400, 800, [0.0, 0.0, 160.0, 100.0]); // 세로 창 → 50×100 가운데
        assert_eq!((r.left, r.top, r.right, r.bottom), (55, 0, 105, 100));
        let r = fit(0, 0, [0.0, 0.0, 160.0, 100.0]);
        assert_eq!((r.right, r.bottom), (160, 100));
    }
}
