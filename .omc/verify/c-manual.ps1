# Stage C human checks (needs an UNLOCKED session). Build first: npm run tauri build -- --no-bundle
# Run from the repo root. Each step prints what to do and what to look for. Kills Hera at the end.
$exe = "src-tauri\target\release\hera.exe"
$p = Start-Process $exe -PassThru
Start-Sleep 4
$steps = @(
  "1. Tray > '턴테이블 보이기/숨기기'. Expected: the pixel turntable appears at the left middle of the screen. Click its transparent margin (right of the card, below the closed drawer front): the click reaches the desktop/app underneath.",
  "2. Drag the turntable by its header (the '턴테이블' title area). Expected: the window follows the mouse; the previously focused app keeps focus. Quit Hera from the tray, start it again: the turntable is back at the new position.",
  "3. Click the walnut drawer front. Expected: the LP tray slides down BELOW the card and reads as part of the deck (no glass card edge crossing it). Click into the tray area: it is clickable; with the drawer closed the same area is click-through.",
  "4. Drag the '계산기' LP onto the platter. Expected: snap, tonearm down, platter spins up, Calculator opens in front. Minimize Calculator, then click the spinning platter: Calculator is restored and comes to the front. Close Calculator: within ~2.5s the arm returns and the platter slows to a stop.",
  "5. Panel > 라이브러리 > 'LP 세트 만들기…': tick 계산기 and 메모장 (order = launch order), name it, 만들기. In the turntable drawer the set sleeve (stacked) appears; drop it: both apps open in sequence and the record spins until BOTH are closed.",
  "6. Right-click a dock icon. Expected: the turntable shows (if hidden) and plays that record. The '-' button in the turntable header hides it (window destroyed; Task Manager memory drops).",
  "7. In any app (e.g. Notepad), press Ctrl+Alt+K. Expected: the palette appears quickly (<150ms feel) with the cursor in the search box. Type 'calc' and Enter: Calculator launches. Press Ctrl+Alt+K again, then Esc: the palette hides and focus returns to the app you were in (typing goes there). Press Ctrl+Alt+K, click another window: the palette closes.",
  "8. Palette: type part of a Start-menu app name (e.g. 'Paint') -> Enter launches it; type a todo title -> Enter opens the panel on 할 일.",
  "9. Drag a document (e.g. a .pdf/.txt) from Explorer onto the dock. Expected: the dock opens while dragging; dropping on the dashed 선반 area adds a file chip (extension label). Click the chip: the file opens in its default app. Right-click the chip: it is removed. Restart Hera: remaining chips are kept.",
  "10. On a laptop: the dock shows a battery ring with the real %; plug/unplug the charger -> it updates within ~2s. On a desktop without a battery the widget is absent.",
  "11. Frame timing with DevTools (optional): set `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'`, start Hera, open edge://inspect, attach to surface=turntable, record Performance while opening the drawer and dropping an LP. Pass: >=95% frames <=16.7ms, no long task >50ms, no per-frame Layout."
)
foreach ($s in $steps) { Write-Host $s; Read-Host "Enter when done" | Out-Null }
Stop-Process -Id $p.Id -Force
