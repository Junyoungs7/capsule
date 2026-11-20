// 자동 업데이트 (아라처럼): 시작 1분 뒤 · 3시간마다 다운로드 사이트의 latest.json 을 보고, 새 판이면 받아서(서명 확인) 조용히 설치 → Hera 다시 켜짐.
// 주소는 빌드할 때만 넣는다 (HERA_UPDATE_URL — 사내 주소가 저장소에 남지 않게). 없으면 이 기능은 꺼져 있다.
// 서명 공개키 = tauri.conf.json plugins.updater.pubkey, 비밀키는 빌드 PC 의 ~/.tauri/hera-updater.key (저장소 밖).
// 끄는 중(왼쪽 단추 눌림)이거나 전체화면 앱 중이면 설치를 미룬다 (1분 뒤 다시).
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

pub const URL: Option<&str> = option_env!("HERA_UPDATE_URL");
const EVERY: Duration = Duration::from_secs(3 * 3600);

/// 지금 설치해도 되나 (사용자가 끄는 중 · 전체화면 앱이면 아님)
fn quiet() -> bool {
    #[cfg(windows)]
    {
        !crate::watch::left_down() && !crate::watch::FULLSCREEN.load(std::sync::atomic::Ordering::Relaxed)
    }
    #[cfg(not(windows))]
    true
}

/// 확인하고, 새 판이면 받아서 설치 (설치되면 Hera 가 다시 켜진다) → 새 판 번호 또는 None(최신)
async fn run(app: &AppHandle) -> Result<Option<String>, String> {
    let url = URL.ok_or("이 판에는 업데이트 주소가 없어요")?;
    let up = app
        .updater_builder()
        .endpoints(vec![tauri::Url::parse(url).map_err(|e| e.to_string())?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let Some(u) = up.check().await.map_err(|e| format!("업데이트를 확인하지 못했어요: {e}"))? else { return Ok(None) };
    let v = u.version.clone();
    let bytes = u.download(|_, _| {}, || {}).await.map_err(|e| format!("새 판을 받지 못했어요: {e}"))?;
    while !quiet() {
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
    crate::tray::toast(app, "sent", &format!("Hera {v}로 업데이트해요"), "잠깐 꺼졌다가 다시 켜져요");
    tokio::time::sleep(Duration::from_secs(2)).await;
    u.install(bytes).map_err(|e| format!("설치하지 못했어요: {e}"))?;
    app.restart();
}

/// 시작 때 한 번: 1분 뒤 첫 확인, 그다음 3시간마다 (실패는 조용히 — 다음에 다시)
pub fn start(app: &AppHandle) {
    if URL.is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            if let Err(e) = run(&app).await {
                eprintln!("update: {e}");
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// 설정 › 정보 [업데이트 확인] → "최신이에요" 또는 오류 (새 판이면 바로 설치되어 다시 켜진다)
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<String, String> {
    match run(&app).await? {
        None => Ok(format!("최신 판이에요 ({})", app.package_info().version)),
        Some(v) => Ok(format!("{v}로 업데이트해요")),
    }
}
