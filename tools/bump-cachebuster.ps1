<#
.SYNOPSIS
  Bump the Codex plugin cachebuster suffix.

.DESCRIPTION
  Codex caches an installed local plugin under a version-suffixed directory
  (%USERPROFILE%\.codex\plugins\cache\<marketplace>\<plugin>\<version>), so the
  version string must change before `codex plugin add` picks up your edits. This
  script rewrites <base>+codex.<cachebuster> and leaves the rest of the manifest
  byte-for-byte untouched.

.EXAMPLE
  pwsh -File tools\bump-cachebuster.ps1
  pwsh -File tools\bump-cachebuster.ps1 -Cachebuster local-test -DryRun
#>
[CmdletBinding()]
param(
  [string]$PluginPath = '',
  [string]$Cachebuster = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
if (-not $PluginPath) { $PluginPath = Join-Path $PSScriptRoot '..\plugins\usage-hub' }

$root = [IO.Path]::GetFullPath($PluginPath)
$manifestPath = Join-Path $root '.codex-plugin\plugin.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "Missing plugin manifest: $manifestPath"
}

$raw = [IO.File]::ReadAllText($manifestPath)
$pattern = '"version"\s*:\s*"(?<version>[^"]+)"'
$match = [regex]::Match($raw, $pattern)
if (-not $match.Success) {
  throw "No string version field found in $manifestPath"
}

$version = $match.Groups['version'].Value
$semver = [regex]::Match($version, '^(?<base>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+(?<meta>[0-9A-Za-z.-]+))?$')
if (-not $semver.Success) {
  throw "Unsupported version '$version'; expected semver such as 2.2.0 or 2.2.0+codex.20260101000000"
}

$token = if ($Cachebuster) { $Cachebuster } else { (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss') }
$token = ($token -replace '[^0-9A-Za-z-]', '-')
if (-not $token) { $token = (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss') }

$nextVersion = "$($semver.Groups['base'].Value)+codex.$token"
Write-Host ("{0} -> {1}" -f $version, $nextVersion)

if ($DryRun) {
  Write-Host '(dry run: manifest not written)'
  return
}

$nextRaw = [regex]::Replace($raw, $pattern, ('"version": "{0}"' -f $nextVersion), 1)
[IO.File]::WriteAllText($manifestPath, $nextRaw, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Updated $manifestPath"