# Private Working Set of hera.exe + its msedgewebview2 process tree. usage: -procId <pid>
param([int]$procId)
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
$tree = @($procId); $added = $true
while ($added) { $added = $false; foreach ($p in $procs) { if ($tree -contains $p.ParentProcessId -and -not ($tree -contains $p.ProcessId)) { $tree += $p.ProcessId; $added = $true } } }
$perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $tree -contains $_.IDProcess }
$sum = 0
foreach ($x in $perf) {
  $cl = ($procs | Where-Object ProcessId -eq $x.IDProcess).CommandLine
  $type = if ($cl -match '--type=([a-z-]+)') { $Matches[1] } else { 'main' }
  $mb = [math]::Round($x.WorkingSetPrivate / 1MB, 1); $sum += $x.WorkingSetPrivate
  "{0,-22} pid={1,-6} type={2,-14} privateWS={3} MB" -f $x.Name, $x.IDProcess, $type, $mb
}
"TOTAL processes=$($perf.Count) privateWS=$([math]::Round($sum / 1MB, 1)) MB"
