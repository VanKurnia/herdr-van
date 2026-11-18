# Starts mods/media/helper.py hidden and prints its pid (or "no-python"), which
# the mod kills when it closes.
#
# -AppHome rather than -Home: the latter collides with PowerShell's read-only $Home.
param(
  [Parameter(Mandatory = $true)][string]$AppHome,
  [Parameter(Mandatory = $true)][string]$ModDir
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $ModDir 'helper.py'

# One helper per app home: it outlives a window that closed without stopping it.
$running = Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*helper.py*' -and $_.CommandLine -like '*--home*' } |
  Select-Object -First 1
if ($running) {
  $running.ProcessId
  exit 0
}

$python = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source }
if (-not $python) {
  'no-python'
  exit 1
}

# The mod's dependencies are installed into vendor/, not committed (see the mod's
# README). pythonw has no console streams to read a result from, so the probe runs
# on python.exe and only its exit code is used.
$probe = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
if ($probe) {
  $snippet = "import sys; sys.path.insert(0, r'$(Join-Path $ModDir 'vendor')'); import winrt.windows.media.control, soundcard, numpy"
  $ErrorActionPreference = 'SilentlyContinue'  # the probe reports through its exit code
  & $probe -c $snippet 2>&1 | Out-Null
  $depsMissing = $LASTEXITCODE -ne 0
  $ErrorActionPreference = 'Stop'
  if ($depsMissing) {
    'no-deps'
    exit 1
  }
}

(Start-Process -FilePath $python -ArgumentList @("`"$helper`"", '--home', "`"$AppHome`"") -WindowStyle Hidden -PassThru).Id
