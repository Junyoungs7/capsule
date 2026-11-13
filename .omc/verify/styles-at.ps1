# Moves the cursor and reads dock/island WS_EX_TRANSPARENT (click-through). usage: -procId <pid> -points "x,y;x,y"
param([int]$procId, [string]$points)
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class S {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<IntPtr> Top(uint pid) { var l = new List<IntPtr>(); EnumWindows((h, x) => { uint p; GetWindowThreadProcessId(h, out p); var s = new StringBuilder(64); GetClassName(h, s, 64); if (p == pid && IsWindowVisible(h) && s.ToString() == "Tauri Window") l.Add(h); return true; }, IntPtr.Zero); return l; }
}
'@
[S]::SetProcessDPIAware() | Out-Null
$wins = [S]::Top([uint32]$procId)
foreach ($pt in $points.Split(';')) {
  $x, $y = $pt.Split(',') | ForEach-Object { [int]$_ }
  [S]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 250
  $o = foreach ($h in $wins) { $r = New-Object S+RECT; [S]::GetWindowRect($h, [ref]$r) | Out-Null; $ex = [S]::GetWindowLongPtr($h, -20).ToInt64(); "win@($($r.L),$($r.T)) clickThrough=$(($ex -band 0x20) -ne 0)" }
  "cursor=($x,$y): " + ($o -join ' | ')
}
