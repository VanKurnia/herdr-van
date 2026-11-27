# Measures the media row's poster, so a look change can be compared with numbers
# instead of eyeballs.
#
# Why: the row's changes are all look changes — how much artwork shows, where a
# fade ends, whether the artist line stays readable. Twice, hand-rolled pixel
# measurements gave wrong answers: a sampled band held window chrome instead of
# the poster, and a "before" and an "after" frame had different cover art, so
# every number was apples-to-oranges. This probe measures fixed horizontal bands
# of an explicit rectangle and refuses to compare runs whose cover differs.
#
# It is read-only: it takes one screenshot (into $env:TEMP, or none at all with
# -Image) and prints one JSON object on stdout. Nothing else is written.
#
# The bands are anchored to the rectangle, not to fractions of -H: the words sit a
# fixed inset from the block's top and the skyline is fixed to its foot, so
# fractions of H drift off them the moment -H changes. Each band also reports
# `p98_right`, the 98th percentile of its rightmost quarter: a line that stops
# truncating shows up there first (plan 006 reads it).
#
# Usage (this machine: zoom 1.1, media block 268 px, sidebar footer 40 px):
#   pwsh -File tools/poster-probe.ps1 -Y 690 -H 295
#   pwsh -File tools/poster-probe.ps1 -Y 690 -H 295 > $env:TEMP\a.json
#   pwsh -File tools/poster-probe.ps1 -Y 690 -H 295 -Compare $env:TEMP\a.json
#
# -H is the media block's `px` * `zoom`; -Y is window height - H - the footer's
# height. Both are physical pixels. Read `layouts/.state/<layout>.json` for the
# block's size (click overrides win over the layout file) and `herdr-app status`
# for `zoom`. On this machine the frame is 1908x1029, the block/footer divider
# sits at y 985, and -Y 690 -H 295 lands exactly on it.

param(
  [string]$Image,
  [int]$X = 20,
  [int]$Y,
  [int]$W = 270,
  [int]$H,
  [string]$Compare
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Notes go to stderr, never to stdout: a caller parses stdout as JSON, and pwsh's
# own warning stream would land there when stdout is redirected.
function Write-Note([string]$Message) { [Console]::Error.WriteLine("WARNING: $Message") }

# herdr-app is a GUI-subsystem executable: `& herdr-app shot` neither waits for it
# nor collects its output, and leaves $LASTEXITCODE unset. Capturing the streams
# through a real process handle is what makes the printed path and the exit code
# trustworthy.
function Invoke-HerdrApp([string[]]$Arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'herdr-app'
  foreach ($a in $Arguments) { $psi.ArgumentList.Add($a) }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdout = $proc.StandardOutput.ReadToEnd()
  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  [pscustomobject]@{ ExitCode = $proc.ExitCode; Stdout = $stdout; Stderr = $stderr }
}

# A mandatory parameter would prompt when missing and hang a non-interactive run,
# so -Y and -H are checked here and fail loudly instead.
if (-not $PSBoundParameters.ContainsKey('Y') -or -not $PSBoundParameters.ContainsKey('H')) {
  [Console]::Error.WriteLine('-Y and -H are required (physical px). -H = media block px * zoom; -Y = window height - H - footer height. A wrong -Y silently measures window chrome.')
  exit 3
}
if ($W -le 0 -or $H -le 0) {
  [Console]::Error.WriteLine("-W and -H must be positive (got $W x $H).")
  exit 3
}
if ($X -lt 0) {
  [Console]::Error.WriteLine("-X must not be negative (got $X).")
  exit 3
}

# --- the app's own facts -----------------------------------------------------

$appHome = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE '.config\herdr-app' }

$zoom = $null
try {
  $status = Invoke-HerdrApp @('status')
  if ($status.ExitCode -eq 0 -and $status.Stdout -match '\S') { $zoom = (ConvertFrom-Json $status.Stdout).zoom }
  elseif ($status.Stderr -match '\S') { Write-Note "herdr-app status said: $($status.Stderr.Trim())" }
} catch {
  Write-Note "could not run 'herdr-app status': $($_.Exception.Message)"
}
if ($null -eq $zoom) { Write-Note 'zoom unknown: the frame cannot be tied back to the layout' }

# The payload carries `cover`/`title` only while a session is live; with nothing
# playing the file is exactly {"session": false, "v": 1}. Both are reported as
# null then, which is normal, not a failure.
$cover = $null
$title = $null
$statePath = Join-Path $appHome 'data\media\state.json'
if (Test-Path -LiteralPath $statePath) {
  try {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $names = @($state.PSObject.Properties.Name)
    if ($names -contains 'cover') { $cover = $state.cover }
    if ($names -contains 'title') { $title = $state.title }
    if (-not $state.session) {
      Write-Note 'nothing playing: state.json says "session": false, so it has no cover and no title (expected when no player reports a session)'
    }
  } catch {
    Write-Note "could not parse ${statePath}: $($_.Exception.Message)"
  }
} else {
  Write-Note "no media state at $statePath"
}

# --- the frame ---------------------------------------------------------------

if ($Image) {
  if (!(Test-Path -LiteralPath $Image)) {
    [Console]::Error.WriteLine("image not found: $Image")
    exit 3
  }
  $shotPath = (Resolve-Path -LiteralPath $Image).Path
} else {
  $shotPath = Join-Path $env:TEMP ('poster-probe-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.png')
  $shot = Invoke-HerdrApp @('shot', $shotPath)
  if ($shot.ExitCode -ne 0) {
    $why = if ($shot.Stderr -match '\S') { $shot.Stderr.Trim() } elseif ($shot.Stdout -match '\S') { $shot.Stdout.Trim() } else { "exit $($shot.ExitCode)" }
    [Console]::Error.WriteLine("herdr-app shot failed: $why")
    exit 1
  }
  $printed = ($shot.Stdout -split "`r?`n" | Where-Object { $_ -match '\S' } | Select-Object -Last 1)
  if ($printed -and (Test-Path -LiteralPath $printed.Trim())) { $shotPath = $printed.Trim() }
  if (!(Test-Path -LiteralPath $shotPath)) {
    [Console]::Error.WriteLine("herdr-app shot printed no readable file: $($shot.Stdout.Trim())")
    exit 1
  }
}

# --- the bands ---------------------------------------------------------------
# Offsets are physical px: `top` counts down from -Y, `*FromBottom` counts up from
# -Y + -H. `end` is the exclusive last row. Double every offset at zoom 2, halve it
# at 0.5: they follow the row's own fixed innards, not a share of its height.
$bandSpecs = @(
  @{ name = 'title'; top = 10; end = 34 }                        # the title line's ink (measured at +14 ... +26)
  @{ name = 'artist'; top = 34; end = 58 }                       # the artist line, past the gap(1)
  @{ name = 'mid'; top = 60; end = 100 }                         # inside the top scrim (0.35 * 295 = 103 px)
  @{ name = 'art'; top = 110; endFromBottom = 60 }               # the open artwork region
  @{ name = 'skyline'; topFromBottom = 50; endFromBottom = 2 }   # the bar chart at the foot
)
$contrastBands = @('title', 'artist')

# WCAG relative luminance of an sRGB triple, after linearising its channels.
function Get-RelativeLuminance([int]$r, [int]$g, [int]$b) {
  $lin = { param($c) $v = $c / 255.0; if ($v -le 0.04045) { $v / 12.92 } else { [math]::Pow(($v + 0.055) / 1.055, 2.4) } }
  return 0.2126 * (& $lin $r) + 0.7152 * (& $lin $g) + 0.0722 * (& $lin $b)
}

# A change that cannot be computed (a band clipped out of the frame) is null, not 0.
function Get-Delta($now, $was) {
  if ($null -eq $now -or $null -eq $was) { return $null }
  return [math]::Round([double]$now - [double]$was, 2)
}

$bitmap = $null
try {
  $bitmap = [System.Drawing.Bitmap]::FromFile($shotPath)
} catch {
  [Console]::Error.WriteLine("could not open image ${shotPath}: $($_.Exception.Message)")
  exit 1
}

$result = [ordered]@{
  image = $shotPath
  cover = $cover
  title = $title
  zoom  = $zoom
  bands = @()
}

try {
  $imgW = $bitmap.Width
  $imgH = $bitmap.Height

  # A rectangle that reaches outside the frame cannot be measured: say so loudly
  # rather than reporting numbers for pixels that are not there.
  if ($X -ge $imgW -or ($X + $W) -gt $imgW -or $Y -ge $imgH -or ($Y + $H) -gt $imgH) {
    Write-Note "rectangle X=$X Y=$Y W=$W H=$H does not fit the ${imgW}x${imgH} frame; bands are clipped to what exists"
  }

  $rows = New-Object System.Collections.Generic.List[object]
  # The rightmost quarter of the rectangle: where a line that used to truncate
  # starts reaching for the edge.
  $xsRight = [math]::Max($X, $X + $W - [int][math]::Ceiling($W / 4.0))

  foreach ($spec in $bandSpecs) {
    $y0 = if ($spec.ContainsKey('top')) { $Y + [int]$spec['top'] } else { $Y + $H - [int]$spec['topFromBottom'] }
    $y1 = if ($spec.ContainsKey('end')) { $Y + [int]$spec['end'] } else { $Y + $H - [int]$spec['endFromBottom'] }   # exclusive
    $entry = [ordered]@{ name = $spec['name']; y0 = $y0; y1 = $y1; p50 = $null; p98 = $null; p98_right = $null }

    $ys = [math]::Max(0, $y0)
    $ye = [math]::Min($imgH, $y1)
    $xs = [math]::Max(0, $X)
    $xe = [math]::Min($imgW, $X + $W)
    $count = [math]::Max(0, $ye - $ys) * [math]::Max(0, $xe - $xs)

    if ($count -le 0) {
      Write-Note "band '$($spec['name'])' has no pixels inside the frame; reporting null"
      $rows.Add([pscustomobject]$entry)
      continue
    }

    # Per-pixel BT.601 luminance, kept with its colour so the chosen percentiles
    # can be turned back into a real sRGB triple for the contrast ratio.
    # Loop counters are not $x/$y: PowerShell variable names are case-insensitive,
    # so $x would overwrite -X and $y would overwrite -Y mid-run.
    $vals = New-Object 'double[]' $count
    $rgbs = New-Object 'int[]' $count
    $rightVals = New-Object System.Collections.Generic.List[double]
    $i = 0
    $uniform = $true
    $first = $null
    for ($row = $ys; $row -lt $ye; $row++) {
      for ($col = $xs; $col -lt $xe; $col++) {
        $pixel = $bitmap.GetPixel($col, $row)
        # `-shl` on a [byte] stays a byte, so `$pixel.R -shl 16` is 0: pack by
        # arithmetic on ints or the colour loses its red and green channels.
        $rgb = ([int]$pixel.R * 65536) + ([int]$pixel.G * 256) + [int]$pixel.B
        if ($null -eq $first) { $first = $rgb } elseif ($rgb -ne $first) { $uniform = $false }
        $lum = 0.299 * $pixel.R + 0.587 * $pixel.G + 0.114 * $pixel.B
        $rgbs[$i] = $rgb
        $vals[$i] = $lum
        $i++
        if ($col -ge $xsRight) { $rightVals.Add($lum) }
      }
    }

    if ($uniform) {
      $shown = ((($first -shr 16) -band 255), (($first -shr 8) -band 255), ($first -band 255)) -join ','
      Write-Note "band '$($spec['name'])' is one flat colour (rgb $shown) across its whole rectangle"
    }

    # Sort the luminances ascending, permuting the colours with them.
    [Array]::Sort($vals, $rgbs)
    $i50 = [int][math]::Floor(($count - 1) * 0.50)
    $i98 = [int][math]::Ceiling(0.98 * $count) - 1
    if ($i98 -ge $count) { $i98 = $count - 1 }

    $entry.p50 = [math]::Round($vals[$i50], 2)
    $entry.p98 = [math]::Round($vals[$i98], 2)

    if ($rightVals.Count -gt 0) {
      $rv = $rightVals.ToArray()
      [Array]::Sort($rv)
      $j98 = [math]::Max(0, [int][math]::Ceiling(0.98 * $rv.Length) - 1)
      if ($j98 -ge $rv.Length) { $j98 = $rv.Length - 1 }
      $entry.p98_right = [math]::Round($rv[$j98], 2)
    }

    if ($contrastBands -contains $spec['name']) {
      $c50 = $rgbs[$i50]
      $c98 = $rgbs[$i98]
      $l50 = Get-RelativeLuminance (($c50 -shr 16) -band 255) (($c50 -shr 8) -band 255) ($c50 -band 255)
      $l98 = Get-RelativeLuminance (($c98 -shr 16) -band 255) (($c98 -shr 8) -band 255) ($c98 -band 255)
      $hi = [math]::Max($l50, $l98)
      $lo = [math]::Min($l50, $l98)
      $entry.contrast = [math]::Round(($hi + 0.05) / ($lo + 0.05), 2)
    }

    $rows.Add([pscustomobject]$entry)
  }

  $result['bands'] = $rows.ToArray()
}
finally {
  if ($bitmap) { $bitmap.Dispose() }
}

# --- the guard ---------------------------------------------------------------
# Cover art changes with the track, and a bright cover versus a dark one moves
# every band by 40+ luminance points. Comparing across covers is the trap this
# script exists to prevent, so refuse instead.
if ($Compare) {
  if (!(Test-Path -LiteralPath $Compare)) {
    [Console]::Error.WriteLine("baseline not found: $Compare")
    exit 3
  }
  try {
    $baseline = Get-Content -LiteralPath $Compare -Raw | ConvertFrom-Json
  } catch {
    [Console]::Error.WriteLine("baseline is not readable JSON: $($_.Exception.Message)")
    exit 3
  }

  $baseCover = if (@($baseline.PSObject.Properties.Name) -contains 'cover') { $baseline.cover } else { $null }
  $nowCover = $cover
  if ("$baseCover" -ne "$nowCover") {
    [Console]::Error.WriteLine('REFUSED: cover changed (' + "$baseCover" + ' -> ' + "$nowCover" + ')')
    exit 2
  }

  $deltas = @()
  foreach ($band in $result.bands) {
    $was = @($baseline.bands) | Where-Object { $_.name -eq $band.name } | Select-Object -First 1
    $d = [ordered]@{
      name         = $band.name
      p50          = $band.p50
      d_p50        = Get-Delta $band.p50 $was.p50
      p98          = $band.p98
      d_p98        = Get-Delta $band.p98 $was.p98
      p98_right    = $band.p98_right
      d_p98_right  = Get-Delta $band.p98_right $was.p98_right
    }
    if (($null -ne $band.contrast) -or ($was -and $null -ne $was.contrast)) {
      $d.contrast = $band.contrast
      $d.d_contrast = Get-Delta $band.contrast $was.contrast
    }
    $deltas += [pscustomobject]$d
  }
  $result['compare'] = [pscustomobject]@{
    baseline = $Compare
    cover    = $baseCover
    bands    = @($deltas)
  }
}

$result | ConvertTo-Json -Depth 6
