# WindowFromPoint after moving the cursor (needs an unlocked session). usage: -procId <pid> -points "x,y;x,y"
param([int]$procId, [string]$points)  # "x,y;x,y"
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class C {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
}
'@
[C]::SetProcessDPIAware() | Out-Null
foreach ($pt in $points.Split(';')) {
  $x, $y = $pt.Split(',') | ForEach-Object { [int]$_ }
  [C]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 250
  $c = New-Object C+POINT; [C]::GetCursorPos([ref]$c) | Out-Null
  $p = New-Object C+POINT; $p.X = $x; $p.Y = $y
  $h = [C]::GetAncestor([C]::WindowFromPoint($p), 2); $pid2 = 0; [C]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  $name = (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName
  "point=($x,$y) cursor=($($c.X),$($c.Y)) -> hwnd=$h class=$([C]::Cls($h)) proc=$name hera=$($pid2 -eq $procId)"
}
