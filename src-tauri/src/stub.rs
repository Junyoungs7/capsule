// Windows 가 아닌 빌드(맥 포팅 준비)용 빈 구현. lib.rs 가 쓰는 API 모양만 Windows 모듈과 같다.
// 맥에서 실제로 채울 목록·방법: docs/mac-port.md. 여기 함수는 "아무것도 안 함 / 빈 값 / 미지원 오류" 를 돌려준다.
#![allow(dead_code)]

const NA: &str = "이 플랫폼에서는 아직 지원하지 않아요 (docs/mac-port.md)";

pub mod watch {
    use std::sync::atomic::AtomicBool;
    use tauri::AppHandle;

    pub static FULLSCREEN: AtomicBool = AtomicBool::new(false);
    pub static RECHECK: AtomicBool = AtomicBool::new(false);
    pub fn add_overlay(_: &'static str, _: isize) {}
    pub fn remove_overlay(_: &str) {}
    pub fn set_rects(_: &str, _: Vec<[f64; 4]>) {}
    pub fn start(_: AppHandle) {}
    pub fn now_ms() -> u64 {
        0
    }
    pub fn cursor_samples() -> Vec<crate::crossing::Sample> {
        vec![]
    }
    /// (이름, [x, y, w, h], 배율, 주 모니터) — 맥: NSScreen.screens
    pub fn monitors() -> Vec<(String, [f64; 4], f64, bool)> {
        vec![("main".into(), [0.0, 0.0, 1920.0, 1080.0], 1.0, true)]
    }
}

pub mod launch {
    pub fn sta<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R {
        f()
    }
    pub fn launch(_: &str) -> Result<(), String> {
        Err(super::NA.into())
    }
}

pub mod shell {
    use tauri::AppHandle;
    pub fn start(_: AppHandle) {}
}
