# Taskbar-replacement human checks (needs an UNLOCKED session). Build first: npx tauri build --no-bundle
# Automated part (works locked): start Hera with $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'
#   then node .omc/verify/taskbar-cdp.mjs
# Run from the repo root. Kills Hera at the end. If anything goes wrong with step 6, Hera restores the taskbar on its
# next start (setting off) — or run:  Start-Process explorer  after  Stop-Process -Name explorer  as a last resort.
$exe = "src-tauri\target\release\hera.exe"
$p = Start-Process $exe -PassThru
Start-Sleep 4
$steps = @(
  "1. Running apps: open Paint and a File Explorer window (not pinned in the dock). Hover the dock: after a separator right of the pinned/group items both appear with their icons and a running dot. A pinned app that is running (e.g. 계산기) shows only its dot, not a second icon. Close Paint: its icon leaves the dock within ~0.5s.",
  "2. Click behaviour: click Paint's dock icon -> Paint comes to front. Click it again (it is foreground) -> it minimizes. Click again -> it restores.",
  "3. Multiple windows: open 2-3 File Explorer windows. Click the Explorer dock icon -> a popover springs up with one card per window: live DWM thumbnail (appears right after the spring settles), title, and an x on hover. Click a card -> that window comes forward and the popover closes. Middle-click a card or press x -> that window closes and the card disappears. (If thumbnails never show, the card still shows the app icon — note it.)",
  "4. Right-click a running (unpinned) icon -> menu '독에 고정' / '창 닫기'. 독에 고정 -> it moves into the pinned area (no duplicate). 창 닫기 -> its window(s) close.",
  "5. Flash: open Notepad, then in a PowerShell window run:  Add-Type -Namespace W -Name F -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool FlashWindow(System.IntPtr h, bool i);'; $h=(Get-Process notepad | Sort-Object StartTime | Select-Object -Last 1).MainWindowHandle; Start-Sleep 4; 1..6 | % { [W.F]::FlashWindow($h,$true) | Out-Null; Start-Sleep -m 400 }  and click another app within 4s. Expected: Notepad's dock item (or its pinned record) gets a pulsing orange dot and bounces gently; with the dock collapsed, the bottom dot pulses orange. Click Notepad: the attention clears.",
  "6. Buttons (dock left, 2x2): Start -> Start menu opens. Top-right (^) -> hidden tray icons overflow opens. Bottom-left -> Quick Settings (Win+A). Bottom-right -> Notification center (Win+N). The app you were typing in keeps focus otherwise (type afterwards: text goes there).",
  "7. Taskbar hide: Panel > 설정 > 'Windows 작업 표시줄 숨기기' ON. Within ~2s the Windows taskbar disappears, the dock moves to the very bottom, and a maximized window fills the whole screen height. Tray check item '...작업 표시줄 숨기기' is checked. Press the Win key: Start opens; when it closes the taskbar is hidden again. Click the dock's ^ button: the taskbar shows briefly with the overflow; click elsewhere: it hides again. Restart explorer (Task Manager > Windows Explorer > Restart): after ~2s the taskbar is hidden again.",
  "8. Restore: toggle the setting OFF (Panel or tray) -> the taskbar comes back and maximized windows stop above it again. Turn it ON, quit Hera from the tray -> the taskbar comes back. Turn it ON, kill Hera (Stop-Process -Name hera) -> the taskbar stays hidden (expected after a crash); start Hera again, toggle OFF -> restored. (Startup recovery with the setting already OFF is covered by the taskbar::actions unit test.)",
  "9. Sun times: Panel > 설정 > 도시 = 'Reykjavik' -> (weather server permitting) the store gets fx.coords; the sunset effect then fires around Reykjavik's sunset-30m local time instead of a fixed hour (check hera.json 'fx.coords')."
)
foreach ($s in $steps) { Write-Host $s; Read-Host "Enter when done" | Out-Null }
Stop-Process -Id $p.Id -Force
