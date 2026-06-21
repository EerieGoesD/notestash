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
$ReleaseDir = Join-Path $Root "src-tauri\target\release"
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
    $candidate = Join-Path $version.FullName "$Architecture\$ToolName"
    if (Test-Path $candidate) { return $candidate }
  }
  throw "$ToolName not found under $kitsRoot"
}

# Build the self-contained exe if it isn't there yet.
$ExeName = "notestash.exe"
$ReleaseExe = Join-Path $ReleaseDir $ExeName
if (-not (Test-Path $ReleaseExe)) {
  Push-Location $Root
  try { npm run tauri build -- --no-bundle } finally { Pop-Location }
}
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

# Pack (unsigned; the Microsoft Store re-signs on submission).
New-Item -ItemType Directory -Force -Path $DistRoot | Out-Null
$makeAppx = Find-WindowsKitTool "makeappx.exe"
& $makeAppx pack /d $LayoutDir /p $PackagePath /o /v
if ($LASTEXITCODE -ne 0) { throw "makeappx failed with exit code $LASTEXITCODE" }

Write-Host "MSIX created: $PackagePath"
