# v2 human checks (needs an UNLOCKED session). Build first: npx tauri build --no-bundle
# Run from the repo root. Automated part (no unlock needed): start Hera with
#   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'  then  node .omc/verify/v2-cdp.mjs
# Kills Hera at the end.
$exe = "src-tauri\target\release\hera.exe"
$p = Start-Process $exe -PassThru
Start-Sleep 4
$steps = @(
  "1. Clipboard: copy 3 different texts in Notepad (Ctrl+C). Press Ctrl+Alt+K. Expected: '최근 복사' at the top, newest first. Pick the 2nd one: '복사됨 ✓' flashes, the palette closes, Ctrl+V pastes that text. Copy a password from a password manager (KeePass/1Password/Bitwarden): it must NOT appear in the list. Quit Hera and restart: the list is empty (memory only).",
  "2. App groups: Panel > 라이브러리 > '앱 묶음 만들기…', pick 3+ apps, 만들기. Expected: a 2x2 mini-grid slot appears in the dock. Click it: the grid popover springs up above the dock, fully visible (not clipped). Click an app: it launches and the popover closes. Open again, click the empty desktop above it: the popover closes (that click is eaten once), and right after that clicks on the desktop pass through again.",
  "3. Island drop: drag a file from Explorer up to the top-center pill. Expected: as you reach the pill it springs open into '선반에 놓기'; drop -> the file chip appears on the dock shelf (max 4, oldest dropped). Drag past the island without dropping: it shrinks back. Moving the mouse near the island WITHOUT dragging: clicks still reach the app below.",
  "4. ASCII: hover the dock, click the ASCII widget. Expected: the scene zooms out from the widget to fullscreen (spring), Esc or a click zooms it back into the widget and the window is gone (Task Manager: one msedgewebview2 renderer fewer).",
  "5. Idle screensaver: Panel > 설정 > 자리 비움 화면보호기 = 1 (분). Don't touch anything for ~1 min. Expected: fullscreen ASCII fades in (no focus steal). Press any key or move the mouse: it fades out. Start a fullscreen video / F5 slideshow and wait 1 min: no screensaver. Set it back to 10.",
  "6. Effects: Panel > 설정 > '지금 보기'. Expected: a fullscreen effect (sky/snow/rain/leaves) fades in BELOW the dock and island (hover the dock: it opens above the effect), clicks pass through to apps, it fades out after ~25s. Tray > '날씨·계절 효과' unchecked -> the Panel switch turns off within ~2s, and vice versa.",
  "7. Weather: Panel > 설정 > 도시 = 'Busan' (or 부산), Enter. Within a few seconds the row shows the real weather/temperature (needs api.open-meteo.com reachable — on this PC's network it timed out during development; then the row shows '날씨 정보 없음' and effects use season/time only).",
  "8. December scene (optional, set the system date to Dec or wait): the widget/fullscreen shows the spinning tree; gifts drop one by one and pile up, star rays pulse, lights chase along the garland, a shooting star crosses every ~11s, snow builds up on the ground; after ~40s the pile sinks into the snow and starts over."
)
foreach ($s in $steps) { Write-Host $s; Read-Host "Enter when done" | Out-Null }
Stop-Process -Id $p.Id -Force
