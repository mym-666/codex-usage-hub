<#
.SYNOPSIS
  Clean stale Usage Hub runtime state left behind by a Codex restart or a crash.

.DESCRIPTION
  Every Codex restart spawns a fresh MCP server, and each MCP server registers an
  owner heartbeat in <DataDir>\mcp-owners. After a hard shutdown those records and
  the pid files can outlive the processes they describe; the overlay then has to
  parse them on its follow timer and the next start can trip over a half-written
  owner.

  Only state that can be proven dead is touched:
    * mcp-owners/*.json whose pid is gone and whose heartbeat is older than -StaleMinutes
    * overlay.pid / helper.pid whose pid is gone
    * with -StopOrphans: an overlay/helper process for this data directory that has
      no live owner heartbeat and no running Codex desktop process

  Nothing is deleted or stopped unless -Apply is passed.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\cleanup-runtime-state.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\cleanup-runtime-state.ps1 -Apply
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\cleanup-runtime-state.ps1 -Apply -StopOrphans
#>
[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'UsageHubPlugin'),
  [int]$StaleMinutes = 10,
  [switch]$Apply,
  [switch]$StopOrphans
)

$ErrorActionPreference = 'Stop'

function Test-ProcessId([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

# Heartbeat timestamps arrive as strings under Windows PowerShell 5.1 and as
# [datetime] under PowerShell 7; normalise both to local time so a fresh UTC
# heartbeat is never mistaken for a stale one.
function ConvertTo-LocalTimestamp($Value) {
  if ($null -eq $Value) { return $null }
  if ($Value -is [datetime]) {
    $stamp = [datetime]$Value
    if ($stamp.Kind -eq [DateTimeKind]::Local) { return $stamp }
    if ($stamp.Kind -eq [DateTimeKind]::Utc) { return $stamp.ToLocalTime() }
    return [datetime]::SpecifyKind($stamp, [DateTimeKind]::Utc).ToLocalTime()
  }
  try {
    $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
    return [datetime]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, $styles).ToLocalTime()
  } catch {
    return $null
  }
}

function Read-JsonSafe([string]$Path) {
  try {
    if (Test-Path -LiteralPath $Path) {
      return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
  } catch {}
  return $null
}

if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
  Write-Host "No Usage Hub data directory at $DataDir - nothing to clean."
  return
}

Write-Host "Usage Hub data directory: $DataDir"
Write-Host ("Mode: {0}" -f $(if ($Apply) { 'APPLY' } else { 'dry run (pass -Apply to change anything)' }))
Write-Host ''

$staleBefore = (Get-Date).AddMinutes(-1 * [Math]::Abs($StaleMinutes))
$removals = New-Object System.Collections.Generic.List[string]
$liveOwners = New-Object System.Collections.Generic.List[int]

$ownerDir = Join-Path $DataDir 'mcp-owners'
$ownerFiles = @()
if (Test-Path -LiteralPath $ownerDir -PathType Container) {
  $ownerFiles = @(Get-ChildItem -LiteralPath $ownerDir -Filter '*.json' -File -ErrorAction SilentlyContinue)
}

foreach ($ownerFile in $ownerFiles) {
  $owner = Read-JsonSafe $ownerFile.FullName
  if (-not $owner) {
    Write-Host ("  keep   {0} (unreadable or mid-write; an MCP server may still own it)" -f $ownerFile.Name)
    continue
  }
  $ownerPid = 0
  try { $ownerPid = [int]$owner.pid } catch { $ownerPid = 0 }
  $writtenAt = ConvertTo-LocalTimestamp $owner.writtenAt

  if ($ownerPid -gt 0 -and (Test-ProcessId $ownerPid)) {
    $liveOwners.Add($ownerPid) | Out-Null
    Write-Host ("  keep   {0} (pid {1} is alive)" -f $ownerFile.Name, $ownerPid)
    continue
  }
  if ($writtenAt -and $writtenAt -gt $staleBefore) {
    Write-Host ("  keep   {0} (heartbeat {1:HH:mm:ss} is recent; treating the pid lookup as transient)" -f $ownerFile.Name, $writtenAt)
    continue
  }
  $removals.Add($ownerFile.FullName) | Out-Null
  $heartbeat = if ($writtenAt) { $writtenAt.ToString('u') } else { 'missing' }
  Write-Host ("  remove {0} (pid {1} is gone, heartbeat {2})" -f $ownerFile.Name, $ownerPid, $heartbeat)
}

foreach ($pidFileName in @('overlay.pid', 'helper.pid')) {
  $pidFilePath = Join-Path $DataDir $pidFileName
  if (-not (Test-Path -LiteralPath $pidFilePath)) { continue }
  $recordedPid = 0
  try {
    $raw = (Get-Content -LiteralPath $pidFilePath -Raw -Encoding UTF8).Trim()
    if ($raw.StartsWith('{')) {
      # overlay.pid is written as a JSON record; helper.pid is a bare integer.
      $parsed = $raw | ConvertFrom-Json
      if ($parsed -and $parsed.pid) { $recordedPid = [int]$parsed.pid }
    } else {
      $recordedPid = [int]$raw
    }
  } catch { $recordedPid = 0 }
  if (Test-ProcessId $recordedPid) {
    Write-Host ("  keep   {0} (pid {1} is alive)" -f $pidFileName, $recordedPid)
    continue
  }
  $removals.Add($pidFilePath) | Out-Null
  Write-Host ("  remove {0} (pid {1} is gone)" -f $pidFileName, $recordedPid)
}

if ($StopOrphans) {
  $liveCodex = @(Get-Process -Name ChatGPT, Codex -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
  $orphans = @()
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue)) {
    $commandLine = [string]$process.CommandLine
    if (-not $commandLine) { continue }
    if ($commandLine -notlike '*usage-hub*') { continue }
    if ($commandLine -notlike ('*' + $DataDir + '*')) { continue }
    if ($commandLine -notlike '*usage-overlay.ps1*' -and $commandLine -notlike '*usage-helper.mjs*') { continue }
    $orphans += $process
  }
  if ($orphans.Count -eq 0) {
    Write-Host '  keep   no orphan overlay/helper process found'
  } elseif ($liveOwners.Count -gt 0 -and $liveCodex.Count -gt 0) {
    Write-Host ("  keep   {0} overlay/helper process(es): a live owner heartbeat and a Codex window exist" -f $orphans.Count)
  } else {
    foreach ($orphan in $orphans) {
      $preview = [string]$orphan.CommandLine
      if ($preview.Length -gt 90) { $preview = $preview.Substring(0, 90) }
      Write-Host ("  stop   pid {0} ({1})" -f $orphan.ProcessId, $preview)
      if ($Apply) {
        try { Stop-Process -Id $orphan.ProcessId -Force -ErrorAction Stop } catch { Write-Warning "could not stop $($orphan.ProcessId): $($_.Exception.Message)" }
      }
    }
  }
}

Write-Host ''
if ($removals.Count -eq 0) {
  Write-Host 'Nothing stale found.'
} elseif (-not $Apply) {
  Write-Host ("{0} stale file(s) would be removed. Re-run with -Apply." -f $removals.Count)
} else {
  foreach ($path in $removals) {
    try { Remove-Item -LiteralPath $path -Force -ErrorAction Stop } catch { Write-Warning "could not remove ${path}: $($_.Exception.Message)" }
  }
  Write-Host ("Removed {0} stale file(s)." -f $removals.Count)
}