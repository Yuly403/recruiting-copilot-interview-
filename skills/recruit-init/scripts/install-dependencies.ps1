[CmdletBinding()]
param(
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDir '..\..\..')).Path
$bossSource = if ($env:BOSS_CLI_SOURCE) { $env:BOSS_CLI_SOURCE } else { Join-Path $projectRoot 'boss-cli-source' }
$gatewaySource = if ($env:GATEWAY_SOURCE) { $env:GATEWAY_SOURCE } else { Join-Path $projectRoot 'recruiting-gateway' }
$wuyouSource = if ($env:WUYOU_CLI_SOURCE) { $env:WUYOU_CLI_SOURCE } else { Join-Path $projectRoot 'wuyou-cli' }
$liepinSource = $env:LIEPIN_CLI_SOURCE

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20 or newer is required.' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm is required.' }
$nodeMajor = [int]((& node --version).Trim().TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node.js 20 or newer is required (found $nodeMajor)." }
if (-not $liepinSource) { throw 'LIEPIN_CLI_SOURCE is required; no audited Liepin source is bundled and floating latest is not allowed.' }

Write-Host "Node.js major: $nodeMajor"
Write-Host "Boss source: $bossSource"
Write-Host "Gateway source: $gatewaySource"
Write-Host "Liepin source: $liepinSource"
Write-Host "Wuyou source: $wuyouSource"
if ($CheckOnly) {
  Write-Host 'Check completed; no packages were installed.'
  exit 0
}

$tempBase = [System.IO.Path]::GetTempPath()
$buildRoot = Join-Path $tempBase ("recruiting-copilot-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildRoot | Out-Null

function New-LocalPackage {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Name,
    [switch]$Build,
    [switch]$KeepDist
  )
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "$Name source directory does not exist: $Source"
  }
  $packageRoot = Join-Path $buildRoot $Name
  $sourceCopy = Join-Path $packageRoot 'source'
  New-Item -ItemType Directory -Path $sourceCopy -Force | Out-Null
  $excluded = @('node_modules', 'coverage')
  if (-not $KeepDist) { $excluded += 'dist' }
  & robocopy $Source $sourceCopy /E /NFL /NDL /NJH /NJS /NP /XD $excluded | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "$Name source staging failed (robocopy exit $LASTEXITCODE)" }
  Push-Location $sourceCopy
  try {
    if ($Build) {
      & npm.cmd ci
      if ($LASTEXITCODE -ne 0) { throw "$Name npm ci failed" }
      & npm.cmd run build
      if ($LASTEXITCODE -ne 0) { throw "$Name build failed" }
    }
    & npm.cmd pack --pack-destination $packageRoot
    if ($LASTEXITCODE -ne 0) { throw "$Name pack failed" }
  } finally {
    Pop-Location
  }
  $archives = @(Get-ChildItem -LiteralPath $packageRoot -Filter '*.tgz' -File)
  if ($archives.Count -ne 1) { throw "$Name did not produce exactly one package archive" }
  return $archives[0].FullName
}

try {
  $bossPackage = New-LocalPackage -Source $bossSource -Name 'boss' -Build
  $gatewayPackage = New-LocalPackage -Source $gatewaySource -Name 'gateway' -Build
  $wuyouPackage = New-LocalPackage -Source $wuyouSource -Name 'wuyou' -KeepDist

  foreach ($source in @($bossPackage, $liepinSource, $wuyouPackage, $gatewayPackage)) {
    & npm.cmd install -g $source
    if ($LASTEXITCODE -ne 0) { throw "Global install failed: $source" }
  }

  foreach ($command in @('recruitctl', 'boss', 'liepin', 'wuyou')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Installed command not found: $command" }
  }
  Write-Host 'Dependencies installed. Next: recruitctl session.login, liepin login, and wuyou login.'
} finally {
  $resolvedBuild = [System.IO.Path]::GetFullPath($buildRoot)
  $resolvedTemp = [System.IO.Path]::GetFullPath($tempBase)
  if ($resolvedBuild.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedBuild)) {
    Remove-Item -LiteralPath $resolvedBuild -Recurse -Force
  }
}
