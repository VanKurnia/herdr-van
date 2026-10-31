# Copies this layout's live files from the Herdr home into the repo.
#
# The Herdr home is the source of truth: edit there, then commit here. This
# script (and the optional pre-commit hook) keeps the repo in step.
#
# Why copies instead of symlinks: Herdr's asset loader does not follow
# symlinked paths. Linked mod folders still execute their JavaScript, but every
# SVG/PNG inside them (Lucide icons, the background grid) fails to load, and
# the layout's background image is ignored. Real files are required.
#
# Usage:
#   pwsh -File tools/sync-from-live.ps1
#   pwsh -File tools/sync-from-live.ps1 -HerdrHome 'C:\Users\me\.config\herdr-app'

param(
  [string]$HerdrHome = "$env:USERPROFILE\.config\herdr-app"
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (!(Test-Path $HerdrHome)) { throw "Herdr home not found: $HerdrHome" }

# Never copied down from the home folder: what the app generates (jsconfig.json,
# gpui-kit.d.ts, *.error) and docs, whose installed copies go stale and would
# overwrite edits made here.
$skip = @('jsconfig.json', 'gpui-kit.d.ts')
function Copy-Real($src, $dst) {
  $name = Split-Path $src -Leaf
  if ($skip -contains $name -or $name -match '\.(error|md)$') { return }
  $dir = Split-Path $dst -Parent
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  Copy-Item -Path $src -Destination $dst -Force
}

# Mods
foreach ($m in @('herdr-van', 'herdr-tui-prefix')) {
  $src = Join-Path $HerdrHome "mods\$m"
  if (!(Test-Path $src)) { continue }
  Get-ChildItem $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length).TrimStart('\')
    Copy-Real $_.FullName (Join-Path $repo "mods\$m\$rel")
  }
}

# Layout, theme, backdrop, icon, program overrides.
# herdr-van-config.json is deliberately NOT synced: it is personal.
foreach ($f in @('layouts\herdr-van.json', 'themes\tokyo-night.json', 'backgrounds\tokyo-grid.png', 'custom-icons\pi.svg', 'programs.json')) {
  $src = Join-Path $HerdrHome $f
  if (Test-Path $src) { Copy-Real $src (Join-Path $repo $f) }
}

Write-Host "synced from $HerdrHome"
