# Live cost: how much CPU the running window actually spends, which no stub can
# tell you. Samples herdr-app and every herdr-core over a window and reports the
# share of one core each burned, plus what the window's memory did.
#
#   pwsh -File bench/live.ps1                 # 90 s, idle
#   pwsh -File bench/live.ps1 -Seconds 30 -Label "agent streaming"
#
# Compare two runs to see what activity costs; do not compare across machines.

param(
  [int]$Seconds = 90,
  [string]$Label = "idle",
  [string]$Out = ""
)

$ErrorActionPreference = 'Stop'
$names = @('herdr-app', 'herdr-core')
$procs = Get-Process -Name $names -ErrorAction SilentlyContinue
if (!$procs) { throw "herdr-app is not running" }

$start = @{}
foreach ($p in $procs) { $start[$p.Id] = @{ Name = $p.ProcessName; Cpu = $p.TotalProcessorTime.TotalSeconds; Ws = $p.WorkingSet64 } }
$elapsed = (Measure-Command { Start-Sleep -Seconds $Seconds }).TotalSeconds

$rows = @()
foreach ($p in $procs) {
  $now = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
  if (!$now) { continue }
  $s = $start[$p.Id]
  $cpu = $now.TotalProcessorTime.TotalSeconds - $s.Cpu
  $rows += [pscustomobject]@{
    Process   = $s.Name
    Pid       = $p.Id
    CpuSec    = [math]::Round($cpu, 2)
    CorePct   = [math]::Round(100 * $cpu / $elapsed, 2)
    WsBefore  = [math]::Round($s.Ws / 1MB, 1)
    WsAfter   = [math]::Round($now.WorkingSet64 / 1MB, 1)
    Threads   = $now.Threads.Count
  }
}

$totalCpu = ($rows | Measure-Object -Property CpuSec -Sum).Sum
$summary = [pscustomobject]@{
  Label     = $Label
  Seconds   = [math]::Round($elapsed, 1)
  CpuSec    = [math]::Round($totalCpu, 2)
  CorePct   = [math]::Round(100 * $totalCpu / $elapsed, 2)
  At        = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
}

$rows | Format-Table -AutoSize | Out-String | Write-Host
$summary | Format-List | Out-String | Write-Host

if ($Out) {
  [pscustomobject]@{ summary = $summary; processes = $rows } | ConvertTo-Json -Depth 4 | Set-Content -Path $Out -Encoding utf8
  Write-Host "written: $Out"
}
