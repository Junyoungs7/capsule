# Hera Link: copy the embedded input engine (Deskflow core, GPL-2.0 + OpenSSL exception) into src-tauri/resources/link.
# Exactly what deskflow-core.exe needs (found by reading its PE imports + a test run in an empty folder):
#   Qt6Core/Gui/Widgets/Network, libssl/libcrypto, platforms\qwindows.dll (Qt platform plugin), + licenses.
# MSVC runtime (VCRUNTIME140/MSVCP140) comes from the system (VC++ redistributable).
# Read-only on the source. Run before `npx tauri build`:  powershell -File scripts\fetch-deskflow.ps1
param([string]$src = "C:\Program Files\Deskflow")
$dst = Join-Path $PSScriptRoot "..\src-tauri\resources\link"
New-Item -ItemType Directory -Force "$dst\platforms" | Out-Null
foreach ($f in 'deskflow-core.exe','Qt6Core.dll','Qt6Gui.dll','Qt6Widgets.dll','Qt6Network.dll','libssl-3-x64.dll','libcrypto-3-x64.dll','LICENSE','LICENSE_EXCEPTION') {
  Copy-Item (Join-Path $src $f) $dst -Force
}
Copy-Item (Join-Path $src "plugins\platforms\qwindows.dll") "$dst\platforms\" -Force
Get-ChildItem $dst -Recurse -File | Select-Object @{n='file';e={$_.FullName.Substring((Resolve-Path $dst).Path.Length+1)}}, Length
