# Measures what the media helper and the app cost over a window, so a change to the
# capture path can be compared with the state it replaced.
param([int]$Seconds = 20)

# $home is read-only in PowerShell, hence the trailing underscore.
$home_ = Join-Path $env:USERPROFILE '.config\herdr-app'
$helper = Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*media*helper.py*' } | Select-Object -First 1
$app = Get-Process -Name 'herdr-app' -ErrorAction SilentlyContinue
$h0 = if ($helper) { (Get-Process -Id $helper.ProcessId).TotalProcessorTime.TotalSeconds } else { $null }
$a0 = ($app | ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum
Start-Sleep -Seconds $Seconds
$h1 = if ($helper) { (Get-Process -Id $helper.ProcessId -ErrorAction SilentlyContinue).TotalProcessorTime.TotalSeconds } else { $null }
$a1 = ((Get-Process -Name 'herdr-app' -ErrorAction SilentlyContinue) | ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum
$state = Get-Content (Join-Path $home_ 'data\media\state.json') -Raw -ErrorAction SilentlyContinue
"state: $state"
if ($null -ne $h1) { "helper: pid=$($helper.ProcessId) cpu={0:N2}% of one core" -f ((($h1 - $h0) / $Seconds) * 100) }
else { "helper: not running" }
"app:    cpu={0:N2}% of one core" -f (((($a1 - $a0)) / $Seconds) * 100)
