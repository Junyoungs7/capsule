# B4/B5 human checks (needs an UNLOCKED session). Build first: npm run tauri build -- --no-bundle
# Run from the repo root. Each step prints what to do and what to look for. Kills Hera at the end.
$exe = "src-tauri\target\release\hera.exe"
$p = Start-Process $exe -PassThru
Start-Sleep 4
$steps = @(
  "1. Open the panel > 할 일. Add a todo with a due time 2 minutes from now (datetime-local picker). Close the panel. Expected: the Island briefly expands with the new item, and at the due time (+-3s) it expands into an alert.",
  "2. In the alert press '10분 뒤 다시'. Expected: the alert closes and comes back 10 minutes later. Then press '완료': the todo shows as done in the panel.",
  "3. Panel > 달력: click another day, add an event there with the time picker. Expected: a dot on that day, and the list under the grid shows the event when the day is clicked.",
  "4. Add a todo due in 1 minute, then play a video fullscreen (YouTube F11 or Movies & TV) past the due time. Expected: no alert over the video; the dock/island are hidden; the alert appears right after leaving fullscreen.",
  "5. Add a todo due in 1 minute, then quit Hera from the tray (종료) within a few seconds, wait past the due time, start Hera again. Expected: the todo is still there (tray quit flushed the store) and its missed alarm shows once; a second restart shows nothing.",
  "6. Drag a Start-menu .lnk (e.g. Chrome or VS Code shortcut) onto the dock, start that app. Expected: the new dock icon gets the running dot within 2.5s.",
  "7. Frame timing with DevTools (optional): set `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'`, start Hera, open edge://inspect, attach to surface=dock and record Performance while opening/magnifying the dock; repeat for island (alert) and panel open/close. Pass: >=95% frames <=16.7ms, no long task >50ms.",
  "8. Take a real screenshot (Win+Shift+S) of the dock open over your desktop and compare with .omc/mockup-shots/30-real-composite-dock-open.png."
)
foreach ($s in $steps) { Write-Host $s; Read-Host "Enter when done" | Out-Null }
Stop-Process -Id $p.Id -Force
