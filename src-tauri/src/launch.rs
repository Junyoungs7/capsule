// launch(target): AllowSetForegroundWindow(ASFW_ANY) → ShellExecuteExW. NOACTIVATE 독에서 실행해도 새 앱이 전면에 뜨게.
use std::sync::mpsc::{channel, sync_channel, Sender};
use std::sync::OnceLock;

use windows::core::{w, HSTRING, PCWSTR};
use windows::core::Interface;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, STGM_READ};
use windows::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CLASSES_ROOT, KEY_READ};
use windows::Win32::System::Threading::{CreateEventW, SetEvent, INFINITE};
use windows::Win32::UI::Shell::{IShellItem, IShellLinkW, SHCreateItemFromParsingName, ShellExecuteExW, ShellLink, SEE_MASK_ASYNCOK, SEE_MASK_FLAG_NO_UI, SHELLEXECUTEINFOW};
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

/// .lnk → 대상 경로 (IShellLinkW). 대상이 파일이 아니면(가상 폴더 등) 오류. `sta` 스레드에서 부를 것.
pub fn lnk_target(path: &str) -> Result<String, String> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.message())?;
        link.cast::<IPersistFile>().and_then(|f| f.Load(&HSTRING::from(path), STGM_READ)).map_err(|e| e.message())?;
        let mut buf = [0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).map_err(|e| e.message())?;
        let p = String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(0)]);
        if p.is_empty() { Err("no target".into()) } else { Ok(p) }
    }
}

/// 시작 메뉴 앱 목록 (이름, 대상). PowerShell `Get-StartApps` 1회(~1s) → 프로세스 수명 동안 캐시. 10s 넘으면 죽이고 오류(다음 호출에 재시도).
/// `{KNOWNFOLDER-GUID}\x.exe` 형태 AppID 는 실제 exe 경로로 바꾼다(아이콘·실행 인디케이터가 exe 경로로 매칭되도록).
pub fn start_apps() -> Result<Vec<(String, String)>, String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    static APPS: std::sync::OnceLock<Vec<(String, String)>> = std::sync::OnceLock::new();
    if let Some(v) = APPS.get() {
        return Ok(v.clone());
    }
    let mut child = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | ConvertTo-Json -Compress"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    // stdout 은 별도 스레드가 끝까지 읽는다(파이프가 차서 막히지 않게) → 10s 안에 안 끝나면 kill
    let mut so = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let mut b = vec![];
        let _ = so.read_to_end(&mut b);
        let _ = tx.send(b);
    });
    let out = rx.recv_timeout(std::time::Duration::from_secs(10));
    if out.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let out = out.map_err(|_| "시작 메뉴 앱 목록을 10초 안에 읽지 못했어요".to_string())?;
    let json: serde_json::Value = serde_json::from_slice(&out).map_err(|e| format!("Get-StartApps: {e}"))?;
    let v: Vec<(String, String)> = json
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| {
            let (name, id) = (a["Name"].as_str()?, a["AppID"].as_str()?);
            Some((name.to_string(), known_folder_path(id).unwrap_or_else(|| format!(r"shell:AppsFolder\{id}"))))
        })
        .collect();
    let _ = APPS.set(v.clone());
    Ok(v)
}

fn known_folder_path(id: &str) -> Option<String> {
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    let (guid, rest) = id.strip_prefix('{')?.split_once("}\\")?;
    let guid = windows::core::GUID::try_from(guid).ok()?;
    let base = unsafe { SHGetKnownFolderPath(&guid, KF_FLAG_DEFAULT, None) }.ok()?;
    let s = unsafe { base.to_string() }.ok();
    unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(base.0 as _)) };
    let p = format!(r"{}\{rest}", s?);
    std::path::Path::new(&p).exists().then_some(p)
}

/// (a9) 파일 고르기 (Windows 파일 열기 대화상자) — 선반 '파일 고르기'. 대화상자는 모달이라 자기 STA 스레드에서 (sta() 큐를 막지 않게).
/// 취소 = 빈 목록. JS 가 대화상자가 떠 있는 동안 'island-outside' 를 무시한다 (대화상자 안 클릭 = 히트 rect 밖이라 허브가 접혔다, a4 날짜 고르기와 같은 원인).
pub fn pick_files(multi: bool) -> Result<Vec<String>, String> {
    use windows::Win32::System::Com::{CoTaskMemFree, CoUninitialize};
    use windows::Win32::UI::Shell::{FileOpenDialog, IFileOpenDialog, FOS_ALLOWMULTISELECT, FOS_FORCEFILESYSTEM, SIGDN_FILESYSPATH};
    std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        let r = (|| -> Result<Vec<String>, String> {
            let d: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(|e| e.message())?;
            let mut o = d.GetOptions().map_err(|e| e.message())? | FOS_FORCEFILESYSTEM;
            if multi {
                o |= FOS_ALLOWMULTISELECT;
            }
            d.SetOptions(o).map_err(|e| e.message())?;
            if d.Show(None).is_err() {
                return Ok(Vec::new()); // 취소
            }
            let items = d.GetResults().map_err(|e| e.message())?;
            let mut out = Vec::new();
            for i in 0..items.GetCount().map_err(|e| e.message())? {
                let p = items.GetItemAt(i).and_then(|it| it.GetDisplayName(SIGDN_FILESYSPATH)).map_err(|e| e.message())?;
                out.push(p.to_string().unwrap_or_default());
                CoTaskMemFree(Some(p.0 as _));
            }
            Ok(out)
        })();
        CoUninitialize();
        r
    })
    .join()
    .map_err(|_| "파일 고르기 창이 멈췄어요".to_string())?
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

    /// 수동: cargo test lnk_targets -- --ignored --nocapture (시작 메뉴 .lnk → exe)
    #[test]
    #[ignore]
    fn lnk_targets() {
        let dir = r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs";
        let mut n = 0;
        for e in std::fs::read_dir(dir).unwrap().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "lnk")) {
            let p = e.path().display().to_string();
            let t = sta(move || lnk_target(&p));
            println!("{} -> {t:?}", e.path().display());
            n += t.is_ok_and(|p| p.to_lowercase().ends_with(".exe")) as i32;
        }
        assert!(n > 0);
    }

    /// 실행 지연 측정 (수동): cargo test --release launch_latency -- --ignored --nocapture
    /// 대상별 20회 실행 → 매번 해당 이미지 taskkill (사용자가 이미 띄운 앱은 대상에서 뺄 것).
    /// URL 은 브라우저 탭을 남기지 않도록 ms-calculator: 프로토콜(같은 ShellExecute URL 경로)로 잰다.
    #[test]
    #[ignore]
    fn launch_latency() {
        let calc = "CalculatorApp.exe";
        for (t, image) in [
            (r"shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", calc),
            (r"C:\Windows\System32\charmap.exe", "charmap.exe"),
            ("ms-calculator:", calc),
        ] {
            let n = 20;
            let mut ms = vec![];
            for _ in 0..n {
                let s = std::time::Instant::now();
                sta(move || launch(t)).unwrap();
                ms.push(s.elapsed().as_secs_f64() * 1000.0);
                std::thread::sleep(std::time::Duration::from_millis(1500));
                let _ = std::process::Command::new("taskkill").args(["/IM", image, "/F"]).output();
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let p = |q: f64| ms[((ms.len() as f64 * q).ceil() as usize).clamp(1, ms.len()) - 1];
            println!("LAUNCH {t} n={n} p50={:.1}ms p95={:.1}ms max={:.1}ms", p(0.5), p(0.95), ms[ms.len() - 1]);
        }
    }
}
