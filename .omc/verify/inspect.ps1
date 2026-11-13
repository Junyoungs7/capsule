# Hera windows: rect, ex-styles, Alt+Tab filter. usage: -procId <hera pid>
param([int]$procId)
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static List<IntPtr> Top(uint pid) { var l = new List<IntPtr>(); EnumWindows((h, x) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) l.Add(h); return true; }, IntPtr.Zero); return l; }
  // Alt+Tab approximation: visible, no owner (or APPWINDOW), not TOOLWINDOW, NOACTIVATE needs APPWINDOW, not cloaked
  public static bool AltTab(IntPtr h) {
    if (!IsWindowVisible(h)) return false;
    long ex = GetWindowLongPtr(h, -20).ToInt64();
    bool app = (ex & 0x40000) != 0;
    if ((ex & 0x80) != 0 && !app) return false;
    if ((ex & 0x08000000) != 0 && !app) return false;
    if (GetWindow(h, 4) != IntPtr.Zero && !app) return false;
    int c; DwmGetWindowAttribute(h, 14, out c, 4); if (c != 0) return false;
    return true;
  }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Title(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
}
'@
[W]::SetProcessDPIAware() | Out-Null
$all = @($procId) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId" | ForEach-Object ProcessId)
$alt = 0
foreach ($p in $all) { foreach ($h in [W]::Top([uint32]$p)) {
  $r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null
  $ex = [W]::GetWindowLongPtr($h, -20).ToInt64()
  $at = [W]::AltTab($h); if ($at) { $alt++ }
  if ([W]::IsWindowVisible($h)) {
    "{0,-8} pid={1} title='{2}' class={3} rect=({4},{5})-({6},{7}) {8}x{9} ex=0x{10:X} TOOL={11} NOACT={12} TRANSP={13} APPWIN={14} altTab={15}" -f $h, $p, [W]::Title($h), [W]::Cls($h), $r.L, $r.T, $r.R, $r.B, ($r.R-$r.L), ($r.B-$r.T), $ex, (($ex -band 0x80) -ne 0), (($ex -band 0x08000000) -ne 0), (($ex -band 0x20) -ne 0), (($ex -band 0x40000) -ne 0), $at
  }
}}
"ALT+TAB visible Hera windows: $alt"
