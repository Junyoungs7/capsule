// launch(target) — 선반 파일 열기 · 설정 폴더 열기: AllowSetForegroundWindow(ASFW_ANY) → ShellExecuteExW. NOACTIVATE 독에서 실행해도 새 앱이 전면에 뜨게.
use std::sync::mpsc::{channel, sync_channel, Sender};
use std::sync::OnceLock;

use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
use windows::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CLASSES_ROOT, KEY_READ};
use windows::Win32::System::Threading::{CreateEventW, SetEvent, INFINITE};
use windows::Win32::UI::Shell::{IShellItem, SHCreateItemFromParsingName, ShellExecuteExW, SEE_MASK_ASYNCOK, SEE_MASK_FLAG_NO_UI, SHELLEXECUTEINFOW};
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, DispatchMessageW, MsgWaitForMultipleObjects, PeekMessageW, TranslateMessage, ASFW_ANY, MSG, PM_REMOVE, QS_ALLINPUT, SW_SHOWNORMAL,
};

type Job = Box<dyn FnOnce() + Send>;

/// 셸/COM 작업 전용 STA 스레드 1개 (launch·lnk_target·아이콘 추출·activate). 프로세스 수명 동안 살아 있고 메시지를 펌프한다
/// → 아파트 혼용(RPC_E_CHANGED_MODE) 없음, SEE_MASK_ASYNCOK 의 "호출 스레드가 살아서 메시지 루프를 돌 것" 충족.
/// 호출자는 결과가 나올 때까지 블록(spawn_blocking 안에서 부를 것). 작업 안에서 다시 `sta` 를 부르면 교착.
/// ponytail: 작업은 직렬 — 느린 셸 확장(아이콘)이 실행을 잠깐 막을 수 있음. 문제되면 아이콘용 STA 를 하나 더.
pub fn sta<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R {
    static W: OnceLock<(Sender<Job>, isize)> = OnceLock::new();
    let (tx, ev) = W.get_or_init(|| {
        let ev = unsafe { CreateEventW(None, false, false, PCWSTR::null()) }.expect("CreateEventW").0 as isize;
        let (tx, rx) = channel::<Job>();
        std::thread::spawn(move || unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
            let mut msg = MSG::default();
            loop {
                MsgWaitForMultipleObjects(Some(&[HANDLE(ev as _)]), false, INFINITE, QS_ALLINPUT);
                while let Ok(job) = rx.try_recv() {
                    job();
                }
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        });
        (tx, ev)
    });
    let (rtx, rrx) = sync_channel(1);
    tx.send(Box::new(move || {
        let _ = rtx.send(f());
    }))
    .expect("sta worker");
    let _ = unsafe { SetEvent(HANDLE(*ev as _)) };
    rrx.recv().expect("sta job")
}

#[derive(Debug, PartialEq)]
enum Kind {
    Url,
    Aumid, // shell:AppsFolder\<AUMID> (Get-StartApps 의 AppID 도 이 형태로 저장)
    Path,  // .exe / .lnk / 그 외 파일
}

fn kind(t: &str) -> Kind {
    let l = t.to_ascii_lowercase();
    if l.starts_with(r"shell:appsfolder\") {
        Kind::Aumid
    } else if l.split_once(':').is_some_and(|(s, _)| s.len() > 1 && s.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))) {
        Kind::Url // https:, mailto:, ms-settings: … (드라이브 문자 C: 는 1글자라 제외)
    } else if !l.contains('\\') && !l.contains('/') && l.contains('!') {
        Kind::Aumid // 맨 AUMID (예: Microsoft.WindowsCalculator_8wekyb3d8bbwe!App)
    } else {
        Kind::Path
    }
}

/// ShellExecute 에 넘길 (file, 작업 폴더)
fn resolve(t: &str) -> Result<(String, String), String> {
    let t = t.trim();
    match kind(t) {
        Kind::Aumid if !t.to_ascii_lowercase().starts_with("shell:") => Ok((format!(r"shell:AppsFolder\{t}"), String::new())),
        Kind::Url | Kind::Aumid => Ok((t.to_string(), String::new())),
        Kind::Path => {
            let p = std::path::Path::new(t);
            if !p.exists() {
                return Err(format!("파일이 없어요: {t}"));
            }
            Ok((t.to_string(), p.parent().map(|d| d.display().to_string()).unwrap_or_default()))
        }
    }
}

/// `sta` 스레드에서 부를 것 (ASYNCOK 는 호출 스레드가 살아서 메시지를 펌프해야 한다)
pub fn launch(target: &str) -> Result<(), String> {
    let (file, dir) = resolve(target)?;
    let (file, dir) = (HSTRING::from(file), HSTRING::from(dir));
    unsafe {
        // B5: ASYNCOK 라 활성화 완료를 기다리지 않으므로 동기 오류는 미리 확인한다(경로 존재는 resolve 에서).
        match kind(target.trim()) {
            Kind::Aumid if SHCreateItemFromParsingName::<_, _, IShellItem>(&file, None).is_err() => return Err(format!("앱을 찾을 수 없어요: {target}")),
            Kind::Url if !scheme_registered(target.trim()) => return Err(format!("이 주소를 열 앱이 없어요: {target}")),
            _ => {}
        }
        let _ = AllowSetForegroundWindow(ASFW_ANY);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
            // NO_UI: 오버레이에서 모달 오류 대화상자 금지(오류는 Island 로).
            // ASYNCOK: 활성화를 셸 백그라운드에 맡기고 넘기자마자 반환 (URL 프로토콜 p95 376ms = 패키지 앱 활성화 대기였음)
            fMask: SEE_MASK_FLAG_NO_UI | SEE_MASK_ASYNCOK,
            lpVerb: w!("open"),
            lpFile: PCWSTR(file.as_ptr()),
            lpDirectory: if dir.is_empty() { PCWSTR::null() } else { PCWSTR(dir.as_ptr()) },
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        ShellExecuteExW(&mut info).map_err(|e| format!("실행하지 못했어요: {target} ({})", e.message()))
    }
}

/// URL scheme 이 HKCR 에 등록돼 있는가 (패키지 앱 프로토콜 포함)
fn scheme_registered(url: &str) -> bool {
    let Some((scheme, _)) = url.split_once(':') else { return false };
    let mut k = HKEY::default();
    unsafe {
        let ok = RegOpenKeyExW(HKEY_CLASSES_ROOT, &HSTRING::from(scheme), None, KEY_READ, &mut k).is_ok();
        if ok {
            let _ = RegCloseKey(k);
        }
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_targets() {
        assert_eq!(kind(r"shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"), Kind::Aumid);
        assert_eq!(kind("Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"), Kind::Aumid);
        assert_eq!(kind("https://github.com"), Kind::Url);
        assert_eq!(kind("mailto:a@b.c"), Kind::Url);
        assert_eq!(kind("ms-calculator:"), Kind::Url);
        assert_eq!(kind(r"C:\Windows\explorer.exe"), Kind::Path);
        assert_eq!(kind(r"C:\Users\x\Desktop\Tool!.lnk"), Kind::Path); // 경로 안의 ! 는 AUMID 아님
        assert_eq!(resolve("Microsoft.WindowsNotepad_8wekyb3d8bbwe!App").unwrap().0, r"shell:AppsFolder\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App");
        assert!(resolve(r"C:\nope\missing.exe").is_err());
        assert_eq!(resolve(r"C:\Windows\explorer.exe").unwrap().1, r"C:\Windows");
        assert!(scheme_registered("https://x") && !scheme_registered("nohandler-xyz:1"));
        // ASYNCOK 라도 동기 오류는 미리 잡는다 (창은 뜨지 않음)
        assert!(sta(|| launch("nohandler-xyz:1")).is_err());
        assert!(sta(|| launch(r"shell:AppsFolder\No.Such.App_0000000000000!App")).is_err());
    }

}
