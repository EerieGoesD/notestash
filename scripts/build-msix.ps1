param(
  [string]$IdentityName = "20715EerieGoesD.NoteStash",
  [string]$Publisher = "CN=A2A89A47-0B2B-4C32-B85C-9753888A9FFC",
  [string]$Version = "0.1.0.0",
  [ValidateSet("x64", "x86", "arm64")]
  [string]$Architecture = "x64"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir

# The SDK tools we run (makeappx/makepri) are host tools - makepri has no ARM
# build - so always look them up under x64, whatever we are packaging for.
$ToolArch = "x64"

# A cross-compiled build lands in target\<rust-target>\release, not target\release.
$RustTarget = switch ($Architecture) {
  "arm64" { "aarch64-pc-windows-msvc" }
  "x86"   { "i686-pc-windows-msvc" }
  default { "" }
}
$ReleaseDir = if ($RustTarget) {
  Join-Path $Root "src-tauri\target\$RustTarget\release"
} else {
  Join-Path $Root "src-tauri\target\release"
}
$Template = Join-Path $Root "packaging\msix\AppxManifest.xml.template"
$AssetsSrc = Join-Path $Root "packaging\msix\assets"
$DistRoot = Join-Path $Root "msix-dist"
$LayoutDir = Join-Path $DistRoot "layout"
$AssetsDir = Join-Path $LayoutDir "Assets"
$PackagePath = Join-Path $DistRoot "NoteStash_$($Version)_$($Architecture).msix"

function Find-WindowsKitTool {
  param([string]$ToolName)
  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (-not (Test-Path $kitsRoot)) {
    throw "Windows Kits folder not found. Install the Windows SDK (MSIX packaging tools)."
  }
  $versions = Get-ChildItem -LiteralPath $kitsRoot -Directory | Sort-Object Name -Descending
  foreach ($version in $versions) {
    $candidate = Join-Path $version.FullName "$ToolArch\$ToolName"
    if (Test-Path $candidate) { return $candidate }
  }
  throw "$ToolName not found under $kitsRoot"
}

# ALWAYS build. This used to build only when the exe was missing, which shipped
# 0.1.8.0 to the Store with the 0.1.7 app inside it: the leftover exe was there,
# so nothing was compiled and only the manifest version changed.
$ExeName = "notestash.exe"
$ReleaseExe = Join-Path $ReleaseDir $ExeName
Push-Location $Root
try {
  if ($RustTarget) { npm run tauri build -- --no-bundle --target $RustTarget }
  else { npm run tauri build -- --no-bundle }
} finally { Pop-Location }
if (-not (Test-Path $ReleaseExe)) {
  $exe = Get-ChildItem -LiteralPath $ReleaseDir -Filter *.exe -File |
    Where-Object { $_.Name -notlike "*setup*" } | Select-Object -First 1
  if (-not $exe) { throw "No release exe found in $ReleaseDir" }
  $ExeName = $exe.Name
  $ReleaseExe = $exe.FullName
}

# Stage the package layout: exe + Assets + manifest.
if (Test-Path $LayoutDir) { Remove-Item -LiteralPath $LayoutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $AssetsDir | Out-Null
Copy-Item -LiteralPath $ReleaseExe -Destination (Join-Path $LayoutDir $ExeName) -Force
Copy-Item -Path (Join-Path $AssetsSrc "*.png") -Destination $AssetsDir -Force

$manifest = Get-Content -Raw -LiteralPath $Template
$manifest = $manifest.Replace("{{IDENTITY_NAME}}", $IdentityName)
$manifest = $manifest.Replace("{{PUBLISHER}}", $Publisher)
$manifest = $manifest.Replace("{{VERSION}}", $Version)
$manifest = $manifest.Replace("{{ARCHITECTURE}}", $Architecture)
$manifest = $manifest.Replace("{{EXE_NAME}}", $ExeName)
Set-Content -LiteralPath (Join-Path $LayoutDir "AppxManifest.xml") -Value $manifest -Encoding UTF8

# The target-based "unplated" taskbar icons are qualified resource names, so the
# package needs a resource index or Windows ignores them and plates the icon.
$makePri = Find-WindowsKitTool "makepri.exe"
$PriConfig = Join-Path $DistRoot "priconfig.xml"
if (Test-Path $PriConfig) { Remove-Item -LiteralPath $PriConfig -Force }
& $makePri createconfig /cf $PriConfig /dq en-US /o
if ($LASTEXITCODE -ne 0) { throw "makepri createconfig failed with exit code $LASTEXITCODE" }
& $makePri new /pr $LayoutDir /cf $PriConfig /of (Join-Path $LayoutDir "resources.pri") /o
if ($LASTEXITCODE -ne 0) { throw "makepri new failed with exit code $LASTEXITCODE" }

# Pack (unsigned; the Microsoft Store re-signs on submission).
New-Item -ItemType Directory -Force -Path $DistRoot | Out-Null
$makeAppx = Find-WindowsKitTool "makeappx.exe"
& $makeAppx pack /d $LayoutDir /p $PackagePath /o /v
if ($LASTEXITCODE -ne 0) { throw "makeappx failed with exit code $LASTEXITCODE" }

Write-Host "MSIX created: $PackagePath"
