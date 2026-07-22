param(
  [string]$Version = "0.1.0.0",
  [string[]]$Architectures = @("x64", "arm64")
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$DistRoot = Join-Path $Root "msix-dist"
$BundleInput = Join-Path $DistRoot "bundle-input"
$BundlePath = Join-Path $DistRoot "NoteStash_$($Version).msixbundle"

function Find-WindowsKitTool {
  param([string]$ToolName)
  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (-not (Test-Path $kitsRoot)) {
    throw "Windows Kits folder not found. Install the Windows SDK (MSIX packaging tools)."
  }
  $versions = Get-ChildItem -LiteralPath $kitsRoot -Directory | Sort-Object Name -Descending
  foreach ($version in $versions) {
    $candidate = Join-Path $version.FullName "x64\$ToolName"
    if (Test-Path $candidate) { return $candidate }
  }
  throw "$ToolName not found under $kitsRoot"
}

# One .msix per architecture (build-msix.ps1 throws if anything fails).
foreach ($arch in $Architectures) {
  Write-Host "=== Packaging $arch ==="
  & (Join-Path $ScriptDir "build-msix.ps1") -Version $Version -Architecture $arch
}

# The bundle folder must hold ONLY the packages going into the bundle.
if (Test-Path $BundleInput) { Remove-Item -LiteralPath $BundleInput -Recurse -Force }
New-Item -ItemType Directory -Force -Path $BundleInput | Out-Null
foreach ($arch in $Architectures) {
  $msix = Join-Path $DistRoot "NoteStash_$($Version)_$($arch).msix"
  if (-not (Test-Path $msix)) { throw "Missing package: $msix" }
  Copy-Item -LiteralPath $msix -Destination $BundleInput -Force
}

$makeAppx = Find-WindowsKitTool "makeappx.exe"
& $makeAppx bundle /d $BundleInput /bv $Version /p $BundlePath /o
if ($LASTEXITCODE -ne 0) { throw "makeappx bundle failed with exit code $LASTEXITCODE" }

Write-Host "MSIX bundle created: $BundlePath"
