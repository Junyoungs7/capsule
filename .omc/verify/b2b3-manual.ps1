# B2/B3 human checks (needs an UNLOCKED session). Run the release build first:
#   npm run tauri build -- --no-bundle ; then run this script from the repo root.
# Each step prints what to do and what to look for. Kills Hera at the end.
$exe = "src-tauri\target\release\hera.exe"
$p = Start-Process $exe -PassThru
Start-Sleep 4
$steps = @(
  "1. Hover the dot at the bottom centre: the dock opens. Move across the icons so they magnify, then click the TOP edge of a magnified icon. Expected: it launches (the click is not passed to the desktop).",
  "2. Click Calculator in the dock. Expected: Calculator comes to the front within 0.3s and its dock dot lights up within 2.5s. Close it: the dot goes out within 2.5s.",
  "3. With Calculator in the foreground, the Island shows the Calculator title (계산기) with its icon and the mini LP spins for 10s, then stops.",
  "4. Drag an .exe or .lnk from Explorer onto the dock. Expected: a new icon (real app icon) is added and still there after restarting Hera.",
  "5. Open the panel (dock button) and go to the Library tab: '시작 메뉴에서 앱 추가…' then search 'calc' and add it. Drag a URL from the browser address bar into the panel. Expected: both records are added; the URL shows a favicon or an initial.",
  "6. While the panel is open the dock's panel button has a dot; close the panel and the dot disappears.",
  "7. Add a record with target C:\nope.exe and click it in the dock. Expected: Island alert '<name> 실행 실패'.",
  "8. Change the display scale (Settings > Display 100% -> 125%) and repeat step 1: magnified icons stay clickable and the transparent area still passes clicks through."
)
foreach ($s in $steps) { Write-Host $s; Read-Host "Enter when done" | Out-Null }
Stop-Process -Id $p.Id -Force
