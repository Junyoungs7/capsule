// Windows 가 아닌 빌드(맥 포팅 준비)용 빈 구현. lib.rs 가 쓰는 API 모양만 Windows 모듈과 같다.
// 맥에서 실제로 채울 목록·방법: docs/mac-port.md. 여기 함수는 "아무것도 안 함 / 빈 값 / 미지원 오류" 를 돌려준다.
#![allow(dead_code)]

const NA: &str = "이 플랫폼에서는 아직 지원하지 않아요 (docs/mac-port.md)";

pub mod watch {
    use serde::Serialize;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;
    use tauri::AppHandle;

    #[derive(Clone, Serialize, PartialEq, Debug)]
    #[serde(rename_all = "camelCase")]
    pub struct Fg {
        hwnd: isize,
        pid: u32,
        exe_path: String,
        title: String,
        aumid: String,
    }
    pub static STATE: Mutex<(Option<Fg>, Vec<String>)> = Mutex::new((None, Vec::new()));
    pub static ALARMS_READY: AtomicBool = AtomicBool::new(false);
    pub static FULLSCREEN: AtomicBool = AtomicBool::new(false);
    pub struct FxMenu(pub tauri::menu::CheckMenuItem<tauri::Wry>);

    pub fn add_overlay(_: &'static str, _: isize) {}
    pub fn remove_overlay(_: &str) {}
    pub fn set_rects(_: &str, _: Vec<[f64; 4]>) {}
    pub fn activate(_: &[String]) -> Result<(), String> {
        Err(super::NA.into())
    }
    pub fn power() -> Option<(u8, bool)> {
        None
    }
    pub fn wallpaper_path() -> String {
        String::new()
    }
    pub fn wallpaper_style() -> (String, String) {
        Default::default()
    }
    pub fn start(_: AppHandle) {}
    /// (이름, [x, y, w, h], 배율, 주 모니터) — 맥: NSScreen.screens
    pub fn monitors() -> Vec<(String, [f64; 4], f64, bool)> {
        vec![("main".into(), [0.0, 0.0, 1920.0, 1080.0], 1.0, true)]
    }
}

pub mod launch {
    pub fn sta<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R {
        f()
    }
    pub fn pick_files(_: bool) -> Result<Vec<String>, String> {
        Err(super::NA.into())
    }
    pub fn launch(_: &str) -> Result<(), String> {
        Err(super::NA.into())
    }
    pub fn lnk_target(_: &str) -> Result<String, String> {
        Err(super::NA.into())
    }
    pub fn start_apps() -> Result<Vec<(String, String)>, String> {
        Ok(vec![])
    }
}

pub mod icons {
    use std::path::{Path, PathBuf};
    pub fn icon(_: &Path, _: &str) -> Result<PathBuf, String> {
        Err(super::NA.into())
    }
}

pub mod clip {
    use serde::Serialize;
    use tauri::AppHandle;

    #[derive(Clone, Serialize, PartialEq, Debug)]
    pub struct Clip {
        id: String,
        text: String,
        at: i64,
    }
    pub fn start(_: AppHandle) {}
    pub fn list() -> Vec<Clip> {
        vec![]
    }
    pub fn set(_: &str) -> Result<(), String> {
        Err(super::NA.into())
    }
    pub fn add_remote(_: &str) {}
    pub fn set_files(_: &[String]) -> Result<(), String> {
        Err(super::NA.into())
    }
    pub fn paste(_: &str, _: impl FnOnce()) -> Result<(), String> {
        Err(super::NA.into())
    }
}

pub mod shell {
    use serde::Serialize;
    use tauri::AppHandle;

    #[derive(Clone, Serialize, PartialEq, Debug)]
    pub struct Win {
        hwnd: isize,
    }
    pub fn start(_: AppHandle) {}
    pub fn list() -> Vec<Win> {
        vec![]
    }
}

pub mod ocr {
    // 맥: Vision 프레임워크 VNRecognizeTextRequest (docs/mac-port.md)
    pub fn capture_at_cursor() -> Result<[i32; 4], String> {
        Err(super::NA.into())
    }
    pub fn region(_: [i32; 4]) -> Result<(String, String), String> {
        Err(super::NA.into())
    }
    pub fn clear() {}
}

/// 맥: 메뉴막대가 이미 위쪽을 차지한다 → '상단 공간 확보'는 없음 (docs/mac-port.md)
pub mod appbar {
    use tauri::AppHandle;
    pub fn cleanup_stale(_: &AppHandle) {}
    pub fn set(_: &AppHandle, _: bool) {}
    pub fn refresh(_: &AppHandle) {}
    pub fn release(_: &AppHandle) {}
}
