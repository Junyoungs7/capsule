// launch(target): AllowSetForegroundWindow(ASFW_ANY) → ShellExecuteExW. NOACTIVATE 독에서 실행해도 새 앱이 전면에 뜨게.
use windows::core::{w, HSTRING, PCWSTR};
use windows::core::Interface;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, STGM_READ};
use windows::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CLASSES_ROOT, KEY_READ};
use windows::Win32::UI::Shell::{IShellItem, IShellLinkW, SHCreateItemFromParsingName, ShellExecuteExW, ShellLink, SEE_MASK_ASYNCOK, SEE_MASK_FLAG_NO_UI, SHELLEXECUTEINFOW};
use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY, SW_SHOWNORMAL};

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

pub fn launch(target: &str) -> Result<(), String> {
    let (file, dir) = resolve(target)?;
    let (file, dir) = (HSTRING::from(file), HSTRING::from(dir));
    unsafe {
        // 셸 실행은 STA 권장 (워커 스레드마다 1회, 이미 초기화돼 있으면 무시)
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
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
        ShellExecuteExW(&mut info).map_err(|e| format!("실행 실패: {target} ({})", e.message()))
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

/// .lnk → 대상 경로 (IShellLinkW). 대상이 파일이 아니면(가상 폴더 등) 오류.
pub fn lnk_target(path: &str) -> Result<String, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.message())?;
        link.cast::<IPersistFile>().and_then(|f| f.Load(&HSTRING::from(path), STGM_READ)).map_err(|e| e.message())?;
        let mut buf = [0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).map_err(|e| e.message())?;
        let p = String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(0)]);
        if p.is_empty() { Err("no target".into()) } else { Ok(p) }
    }
}

/// 시작 메뉴 앱 목록 (이름, 대상). PowerShell `Get-StartApps` 1회(~1s) → 프로세스 수명 동안 캐시.
/// `{KNOWNFOLDER-GUID}\x.exe` 형태 AppID 는 실제 exe 경로로 바꾼다(아이콘·실행 인디케이터가 exe 경로로 매칭되도록).
pub fn start_apps() -> Result<Vec<(String, String)>, String> {
    use std::os::windows::process::CommandExt;
    static APPS: std::sync::OnceLock<Vec<(String, String)>> = std::sync::OnceLock::new();
    if let Some(v) = APPS.get() {
        return Ok(v.clone());
    }
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | ConvertTo-Json -Compress"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("Get-StartApps: {e}"))?;
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
        assert!(launch("nohandler-xyz:1").is_err());
        assert!(launch(r"shell:AppsFolder\No.Such.App_0000000000000!App").is_err());
    }

    /// 수동: cargo test lnk_targets -- --ignored --nocapture (시작 메뉴 .lnk → exe)
    #[test]
    #[ignore]
    fn lnk_targets() {
        let dir = r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs";
        let mut n = 0;
        for e in std::fs::read_dir(dir).unwrap().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "lnk")) {
            let t = lnk_target(&e.path().display().to_string());
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
                launch(&t).unwrap();
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
