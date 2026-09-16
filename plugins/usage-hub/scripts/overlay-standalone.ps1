<#
.SYNOPSIS
  Start, stop or query a standalone Usage Hub overlay.

.DESCRIPTION
  Normally the overlay is a child of the plugin's MCP server, which Codex starts
  and kills with the app. In standalone mode the overlay is owned by nothing but
  the user: it survives Codex restarts, and Codex start-up costs nothing.

  With "overlayAutoStart": false in config.json, the plugin leaves the overlay
  alone (the watchdog will not resurrect it either) and this script is the way to
  bring it up. It is also useful on machines where Codex start-up latency matters
  more than the overlay being always on screen.

  The overlay is started hidden-adjacent: it attaches to the Codex window when one
  is visible and hides itself when there is none, but it keeps running and can be
  brought back from its tray icon.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File overlay-standalone.ps1 start
  powershell -NoProfile -ExecutionPolicy Bypass -File overlay-standalone.ps1 status
  powershell -NoProfile -ExecutionPolicy Bypass -File overlay-standalone.ps1 stop
#>
[CmdletBinding()]
param(
  [ValidateSet('start', 'stop', 'status')][string]$Action = 'start',
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'UsageHubPlugin'),
  [string]$PluginRoot = '',
  [int]$WebBillPort = 32146,
  [int]$TimeoutSeconds = 25
)

$ErrorActionPreference = 'Stop'

if (-not $PluginRoot) { $PluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
$overlayScript = Join-Path $PluginRoot 'runtime\usage-overlay.ps1'
$helperScript = Join-Path $PluginRoot 'runtime\usage-helper.mjs'
$overlayPidPath = Join-Path $DataDir 'overlay.pid'
$helperPidPath = Join-Path $DataDir 'helper.pid'
$controlPath = Join-Path $DataDir 'overlay-control.json'
$stopPath = Join-Path $DataDir 'overlay-stopped.json'

function Get-OverlayProcess {
  if (-not (Test-Path -LiteralPath $overlayPidPath)) { return $null }
  $recordedPid = 0
  try {
    $raw = (Get-Content -LiteralPath $overlayPidPath -Raw -Encoding UTF8).Trim()
    if ($raw.StartsWith('{')) { $recordedPid = [int](($raw | ConvertFrom-Json).pid) } else { $recordedPid = [int]$raw }
  } catch { return $null }
  if ($recordedPid -le 0) { return $null }
  return Get-Process -Id $recordedPid -ErrorAction SilentlyContinue
}

function Resolve-NodePath {
  if ($env:CODEX_MCP_NODE_PATH -and (Test-Path -LiteralPath $env:CODEX_MCP_NODE_PATH)) { return $env:CODEX_MCP_NODE_PATH }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command -and $command.Source) { return $command.Source }
  $candidates = @()
  foreach ($root in @((Join-Path $env:ProgramFiles 'nodejs'), (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes'))) {
    if ($root -and (Test-Path -LiteralPath $root)) {
      $candidates += @(Get-ChildItem -LiteralPath $root -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
    }
  }
  if ($candidates.Count -gt 0) { return $candidates[0] }
  throw 'Node.js 22+ was not found; set CODEX_MCP_NODE_PATH or install Node.js.'
}

switch ($Action) {
  'status' {
    $process = Get-OverlayProcess
    if ($process) {
      $mode = if ($process.Id) { 'running' } else { 'unknown' }
      "overlay: $mode (pid $($process.Id))"
    } else {
      'overlay: not running'
    }
    if (Test-Path -LiteralPath $helperPidPath) {
      $helperPid = 0
      try { $helperPid = [int]((Get-Content -LiteralPath $helperPidPath -Raw).Trim()) } catch {}
      if ($helperPid -gt 0 -and (Get-Process -Id $helperPid -ErrorAction SilentlyContinue)) {
        "helper:  running (pid $helperPid)"
      } else {
        'helper:  not running'
      }
    } else {
      'helper:  not running'
    }
    if (Test-Path -LiteralPath $stopPath) { 'start marker: the overlay was exited from its menu; `start` clears it' }
    return
  }
  'stop' {
    $process = Get-OverlayProcess
    if (-not $process) {
      'overlay is not running.'
      return
    }
    [ordered]@{ action = 'exit'; requestedAt = (Get-Date).ToString('o') } |
      ConvertTo-Json |
      Set-Content -LiteralPath $controlPath -Encoding UTF8
    for ($i = 0; $i -lt ($TimeoutSeconds * 4); $i++) {
      Start-Sleep -Milliseconds 250
      if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
        "overlay stopped (pid $($process.Id)). The helper and the web-bill receiver were stopped with it."
        return
      }
    }
    Write-Warning "overlay pid $($process.Id) did not stop within $TimeoutSeconds s; stop it from its tray menu (Exit) or end the process manually."
    return
  }
  'start' {
    if (-not (Test-Path -LiteralPath $overlayScript)) { throw "Overlay script not found: $overlayScript" }
    if (-not (Test-Path -LiteralPath $helperScript)) { throw "Helper script not found: $helperScript" }
    if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }

    $process = Get-OverlayProcess
    if ($process) {
      "overlay is already running (pid $($process.Id))."
      return
    }

    if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath -Force }
    if (Test-Path -LiteralPath $overlayPidPath) { Remove-Item -LiteralPath $overlayPidPath -Force }

    $node = Resolve-NodePath
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $powerShell)) { $powerShell = 'powershell.exe' }

    $arguments = @(
      '-NoProfile'
      '-ExecutionPolicy Bypass'
      '-WindowStyle Hidden'
      ('-File "{0}"' -f $overlayScript.Replace('"', '""'))
      ('-DataDir "{0}"' -f $DataDir.Replace('"', '""'))
      ('-HelperPath "{0}"' -f $helperScript.Replace('"', '""'))
      ('-NodePath "{0}"' -f $node.Replace('"', '""'))
      ('-WebBillPort {0}' -f $WebBillPort)
      ('-OwnerDir "{0}"' -f (Join-Path $DataDir 'mcp-owners').Replace('"', '""'))
      ('-StopPath "{0}"' -f $stopPath.Replace('"', '""'))
      '-Standalone'
    ) -join ' '

    Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden | Out-Null

    for ($i = 0; $i -lt ($TimeoutSeconds * 4); $i++) {
      Start-Sleep -Milliseconds 250
      $started = Get-OverlayProcess
      if ($started) {
        "overlay started (pid $($started.Id)); it will follow Codex when a Codex window is visible."
        return
      }
    }
    Write-Warning "overlay did not report a pid within $TimeoutSeconds s. Check $(Join-Path $DataDir 'plugin.log')."
  }
}