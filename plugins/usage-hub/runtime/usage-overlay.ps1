param(
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'UsageHubPlugin'),
  [string]$HelperPath = '',
  [string]$NodePath = '',
  [int]$WebBillPort = 32146,
  [string]$OwnerDir = '',
  [string]$StopPath = '',
  [int]$IdleExitSeconds = 300,
  [switch]$ExitWithCodex,
  # Standalone mode: the overlay is started by scripts/overlay-standalone.ps1
  # instead of by a Codex MCP server, so there is no owner heartbeat to watch and
  # no reason to close when Codex goes away. It lives until the user exits it.
  [switch]$Standalone
)

$ErrorActionPreference = 'Stop'
# A hidden overlay is kept warm so reopening Codex does not pay the PowerShell +
# WinForms start again; never let a caller set that window to zero.
if ($IdleExitSeconds -lt 15) { $IdleExitSeconds = 15 }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('UsageHub.Native' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
namespace UsageHub {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int awareness);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int valueSize);
  }
}
"@
}

function Enable-HighDpiRendering {
  # Prefer per-monitor DPI awareness v2 so Windows does not bitmap-scale the overlay.
  try {
    if ([UsageHub.Native]::SetProcessDpiAwarenessContext([IntPtr](-4))) { return }
  } catch {}
  try {
    if ([UsageHub.Native]::SetProcessDpiAwareness(2) -eq 0) { return }
  } catch {}
  try { [UsageHub.Native]::SetProcessDPIAware() | Out-Null } catch {}
}

Enable-HighDpiRendering
try { [System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false) } catch {}

$snapshotPath = Join-Path $DataDir 'snapshot.json'
$helperPidPath = Join-Path $DataDir 'helper.pid'
$overlayPidPath = Join-Path $DataDir 'overlay.pid'
$controlPath = Join-Path $DataDir 'overlay-control.json'
$logPath = Join-Path $DataDir 'plugin.log'
$settingsPath = Join-Path $DataDir 'overlay-settings.json'
if (-not $StopPath) {
  $StopPath = Join-Path $DataDir 'overlay-stopped.json'
}
$script:Snapshot = $null
$script:Expanded = $false
$script:Following = $true
$script:ManualPosition = $false
$script:ForceHidden = $false
$script:HelperProcess = $null
$script:StartedHelper = $false
$script:Dragging = $false
$script:DragStart = $null
$script:LastPosition = $null
$script:DpiScale = 1.0
$script:FontScale = 1.0
$script:TitleFont = $null
$script:BodyFont = $null
$script:RefreshFont = $null
$script:FontMenuItems = @()
$script:CodexMissingSince = $null
$script:OwnerMissingSince = $null
$script:CodexProcessCache = $null
$script:CodexLookupTick = 0
$script:OwnerCheckAt = [datetime]::MinValue
$script:OwnerAliveCache = $null
$script:OwnerPruneAt = [datetime]::MinValue
$script:DpiCheckAt = [datetime]::MinValue
$script:SnapshotStamp = ''

if (-not (Test-Path -LiteralPath $DataDir)) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
}

function Write-OverlayLog([string]$Message) {
  try {
    Add-Content -LiteralPath $logPath -Value ("{0} [overlay] {1}" -f (Get-Date).ToString('o'), $Message) -Encoding UTF8
    $item = Get-Item -LiteralPath $logPath -ErrorAction SilentlyContinue
    if ($item -and $item.Length -gt 1MB) {
      $tail = @(Get-Content -LiteralPath $logPath -Encoding UTF8 -Tail 2000)
      Set-Content -LiteralPath $logPath -Value (@('... log truncated, older entries dropped ...') + $tail) -Encoding UTF8
    }
  } catch {}
}

Write-OverlayLog 'starting'

if ($StopPath -and (Test-Path -LiteralPath $StopPath)) {
  Write-OverlayLog 'start cancelled by user exit marker'
  exit 0
}

$createdNew = $false
$overlayMutex = New-Object System.Threading.Mutex($true, 'Local\UsageHubPluginOverlay', [ref]$createdNew)
if (-not $createdNew) {
  Write-OverlayLog 'another overlay instance is already running'
  $overlayMutex.Dispose()
  exit 0
}
Write-OverlayLog 'overlay mutex acquired'
[ordered]@{ pid = $PID; startedAt = (Get-Date).ToString('o') } |
  ConvertTo-Json |
  Set-Content -LiteralPath $overlayPidPath -Encoding UTF8

function Read-JsonFile([string]$Path) {
  try {
    if (Test-Path -LiteralPath $Path) {
      return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
  } catch {}
  return $null
}

# ConvertFrom-Json hands back the heartbeat as a plain string under Windows
# PowerShell 5.1 but as a [datetime] under PowerShell 7. Both forms must be
# normalised to local time, or a fresh UTC heartbeat from a UTC+8 machine looks
# eight hours stale and gets pruned as a dead owner.
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

$savedSettings = Read-JsonFile $settingsPath
if ($savedSettings -and $null -ne $savedSettings.fontScale) {
  try {
    $script:FontScale = [Math]::Min(1.5, [Math]::Max(0.85, [double]$savedSettings.fontScale))
  } catch {}
}

function Apply-UiFonts {
  $oldFonts = @($script:TitleFont, $script:BodyFont, $script:RefreshFont)
  foreach ($font in $oldFonts) {
    if ($font) {
      try { $font.Dispose() } catch {}
    }
  }
  $scale = [single]$script:FontScale
  $script:TitleFont = New-Object System.Drawing.Font('Segoe UI', (10.0 * $scale), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
  $script:BodyFont = New-Object System.Drawing.Font('Segoe UI', (10.0 * $scale), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  $script:RefreshFont = New-Object System.Drawing.Font('Segoe UI', (11.0 * $scale), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
  $titleLabel.Font = $script:TitleFont
  $bodyLabel.Font = $script:BodyFont
  $refreshButton.Font = $script:RefreshFont
}

function Save-OverlaySettings {
  try {
    if (-not (Test-Path -LiteralPath $DataDir)) {
      New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    }
    [ordered]@{ fontScale = [Math]::Round($script:FontScale, 2) } |
      ConvertTo-Json |
      Set-Content -LiteralPath $settingsPath -Encoding UTF8
  } catch {}
}

function Update-DpiScale {
  # Creating a GDI Graphics object every second just to re-read the monitor DPI
  # kept a handle churning for a value that changes at most on a drag between
  # monitors, so the probe itself is throttled.
  $now = Get-Date
  if (($now - $script:DpiCheckAt).TotalSeconds -lt 4) { return $false }
  $script:DpiCheckAt = $now
  $newScale = $script:DpiScale
  $foundDpi = $false
  try {
    if ($form -and $form.IsHandleCreated) {
      $graphics = [System.Drawing.Graphics]::FromHwnd($form.Handle)
      try {
        if ($graphics.DpiX -gt 0) {
          $newScale = [double]$graphics.DpiX / 96.0
          $foundDpi = $true
        }
      } finally { $graphics.Dispose() }
    }
  } catch {}
  if (-not $foundDpi) {
    try {
      if ($form -and $form.DeviceDpi -gt 0) {
        $newScale = [double]$form.DeviceDpi / 96.0
        $foundDpi = $true
      }
    } catch {}
  }
  if (-not $foundDpi) {
    try {
      $graphics = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
      try { $newScale = [double]$graphics.DpiX / 96.0 } finally { $graphics.Dispose() }
    } catch {}
  }
  if ($newScale -le 0) { $newScale = 1.0 }
  $changed = [Math]::Abs($newScale - $script:DpiScale) -gt 0.01
  $script:DpiScale = $newScale
  return $changed
}

function Format-Money($Value, [string]$Currency) {
  if ($null -eq $Value -or "$Value" -eq '') { return '--' }
  $number = 0.0
  if (-not [double]::TryParse("$Value", [ref]$number)) { return "$Value" }
  $symbol = if ($Currency -eq 'CNY') { '¥' } elseif ($Currency -eq 'USD') { '$' } else { '' }
  return ('{0}{1:N2}{2}' -f $symbol, $number, $(if ($symbol) { '' } else { " $Currency" }))
}

function Format-Compact($Value) {
  $number = [double]($Value | ForEach-Object { if ($null -eq $_) { 0 } else { $_ } })
  if ($number -ge 1000000000) { return ('{0:N2}B' -f ($number / 1000000000)) }
  if ($number -ge 1000000) { return ('{0:N2}M' -f ($number / 1000000)) }
  if ($number -ge 1000) { return ('{0:N1}K' -f ($number / 1000)) }
  return ('{0:N0}' -f $number)
}

function Get-BalanceSourceLabel($Source, [switch]$Stale) {
  $name = switch ($Source) {
    'provider-api' { 'API' }
    'web-extension' { '官网' }
    default { '' }
  }
  if (-not $name) { return '' }
  if ($Stale) { return "（$name，已过期）" }
  return "（$name）"
}
function Get-OverlayText($Snap) {
  if (-not $Snap) { return "Usage Hub`r`n等待数据…" }
  $balanceOk = [bool]($Snap.balance -and $Snap.balance.status -eq 'ok')
  $balanceText = if ($balanceOk) { Format-Money $Snap.balance.available $Snap.balance.currency } else { '--' }
  # Only label a balance we actually have; "未探测到余额接口" is reported in the warning row.
  $balance = if ($balanceOk) { $balanceText + (Get-BalanceSourceLabel $Snap.balance.source -Stale:([bool]$Snap.balance.stale)) } else { $balanceText }
  $today = if ($Snap.today) { Format-Money $Snap.today.cost $Snap.today.currency } else { '--' }
  $tokens = if ($Snap.today -and $Snap.today.tokens) { Format-Compact $Snap.today.tokens.total } else { '0' }
  $tokenNote = if ($Snap.today.tokenScope -eq 'codex') { '（Codex 统计）' } elseif ($Snap.today.tokenSource -eq 'dom-scrape') { '（页面刮取）' } else { '' }
  $sessionLabel = '当前会话'
  $sessionDetail = if ($Snap.session -and $Snap.session.status -ne 'unavailable' -and $Snap.session.tokens) {
    $st = $Snap.session.tokens
    "Token $(Format-Compact $st.total)（输入 $(Format-Compact $st.input) · 命中 $(Format-Compact $st.cacheRead) · 未命中 $(Format-Compact $st.freshInput) · 输出 $(Format-Compact $st.output)）"
  } else { '--' }
  $source = if ($Snap.today) { switch ($Snap.today.source) { 'web' { '官网账单' } 'web-extension' { '网页扩展账单' } 'balance_delta' { '余额减少估算' } 'cc-switch' { 'CC Switch 本地' } default { $Snap.today.source } } } else { '' }
  if ($Snap.today.stale) { $source = $source + '（已过期）' }
  if ($Snap.webBillStatus -and $Snap.webBillStatus.status -eq 'error') { $source = $source + '（网络异常）' }
  $warning = if ($Snap.warnings -and $Snap.warnings.Count -gt 0) { ($Snap.warnings -join '；') } else { '' }
  return @"
余额：$balance
今日消费：$today（$source）
今日 Token：总 $tokens$tokenNote
$sessionLabel：$sessionDetail
$warning
"@
}
function Update-SnapshotCache {
  # The data timer used to re-read and repaint the whole card every 5s even when
  # no value had moved. Keep the parsed snapshot until the file really changes.
  try {
    $item = Get-Item -LiteralPath $snapshotPath -ErrorAction SilentlyContinue
    if (-not $item) { return $false }
    $stamp = '{0}:{1}' -f $item.Length, $item.LastWriteTimeUtc.Ticks
    if ($stamp -eq $script:SnapshotStamp) { return $false }
    $script:SnapshotStamp = $stamp
  } catch {
    return $false
  }
  $snap = Read-JsonFile $snapshotPath
  if ($snap) { $script:Snapshot = $snap }
  return $true
}

function Read-Snapshot {
  if ($null -eq $script:Snapshot) { [void](Update-SnapshotCache) }
  return $script:Snapshot
}

function Start-HelperIfNeeded {
  $helper = if ($HelperPath) { $HelperPath } else { Join-Path $PSScriptRoot 'usage-helper.mjs' }
  $node = $NodePath
  if (-not $node -and $env:CODEX_MCP_NODE_PATH) { $node = $env:CODEX_MCP_NODE_PATH }
  if (-not $node) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $node = $nodeCommand.Source }
  }
  if (-not $node -or -not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $helper)) { return }
  $existingPid = $null
  if (Test-Path -LiteralPath $helperPidPath) {
    try { $existingPid = [int](Get-Content -LiteralPath $helperPidPath -Raw).Trim() } catch {}
  }
  if ($existingPid) {
    $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($existing) { return }
  }
  $argLine = '"' + $helper + '" --daemon --data-dir "' + $DataDir + '" --web-bill-port ' + $WebBillPort
  $process = Start-Process -FilePath $node -ArgumentList $argLine -WindowStyle Hidden -PassThru
  $script:HelperProcess = $process
  $script:StartedHelper = $true
  Set-Content -LiteralPath $helperPidPath -Value $process.Id -Encoding ASCII
}

function Get-ReceiverToken {
  try {
    $tokenPath = Join-Path $DataDir 'receiver-token.json'
    if (Test-Path -LiteralPath $tokenPath) {
      $parsed = Read-JsonFile $tokenPath
      if ($parsed -and $parsed.token) { return [string]$parsed.token }
    }
  } catch {}
  return ''
}

function Get-ReceiverHeaders {
  $headers = @{}
  $token = Get-ReceiverToken
  if ($token) { $headers['X-Usage-Hub-Token'] = $token }
  return $headers
}

function Stop-HelperProcess {
  try {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$WebBillPort/shutdown" -Headers (Get-ReceiverHeaders) -TimeoutSec 2 | Out-Null
  } catch {}
  $helperPid = $null
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 150
    $helperPid = $null
    if (Test-Path -LiteralPath $helperPidPath) {
      try { $helperPid = [int](Get-Content -LiteralPath $helperPidPath -Raw).Trim() } catch {}
    }
    if (-not $helperPid) { break }
    if (-not (Get-Process -Id $helperPid -ErrorAction SilentlyContinue)) { break }
  }
  if ($helperPid -and (Get-Process -Id $helperPid -ErrorAction SilentlyContinue)) {
    # Without this the pid file was deleted while the daemon still lived, leaving
    # an orphan holding the web-bill port that the next helper silently failed on.
    Write-OverlayLog "helper $helperPid ignored graceful shutdown; forcing"
    try { Stop-Process -Id $helperPid -Force -ErrorAction SilentlyContinue } catch {}
  }
  Remove-Item -LiteralPath $helperPidPath -Force -ErrorAction SilentlyContinue
}

function Remove-OverlayArtifacts {
  Stop-HelperProcess
  if ($overlayMutex) {
    try { $overlayMutex.ReleaseMutex() } catch {}
    try { $overlayMutex.Dispose() } catch {}
    $overlayMutex = $null
  }
  Remove-Item -LiteralPath $overlayPidPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $controlPath -Force -ErrorAction SilentlyContinue
}

function Write-OverlayStopMarker {
  try {
    if (-not (Test-Path -LiteralPath $DataDir)) {
      New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    }
    [ordered]@{
      requestedAt = (Get-Date).ToString('o')
      pid = $PID
    } |
      ConvertTo-Json |
      Set-Content -LiteralPath $StopPath -Encoding UTF8
  } catch {
    Write-OverlayLog "failed to write stop marker: $($_.Exception.Message)"
  }
}

function Test-OverlayOwnersAlive {
  if ($Standalone) { return $true }
  if (-not $OwnerDir) { return $true }
  # Runs from the 1s follow timer. Directory listing plus a JSON parse per owner
  # record, every tick, was the measurable idle cost in the security review
  # (B13); the answer is now cached for two seconds and stale records are only
  # swept once a minute.
  $now = Get-Date
  if ($null -ne $script:OwnerAliveCache -and ($now - $script:OwnerCheckAt).TotalMilliseconds -lt 2000) {
    return $script:OwnerAliveCache
  }
  $script:OwnerCheckAt = $now
  $prune = ($now - $script:OwnerPruneAt).TotalSeconds -ge 60
  try {
    if (-not (Test-Path -LiteralPath $OwnerDir -PathType Container)) { $script:OwnerAliveCache = $false; return $false }
    $ownerFiles = @(Get-ChildItem -LiteralPath $OwnerDir -Filter '*.json' -File -ErrorAction SilentlyContinue)
    if ($ownerFiles.Count -eq 0) { $script:OwnerAliveCache = $false; return $false }
    $alive = $false
    $staleBefore = $now.AddMinutes(-10)
    foreach ($ownerFile in $ownerFiles) {
      $owner = $null
      try { $owner = Read-JsonFile $ownerFile.FullName } catch { $owner = $null }
      if (-not $owner) {
        # Unreadable or mid-write record. Never delete it: the MCP server
        # heartbeats this file, and deleting a live owner used to strand the
        # overlay forever because registerOwner() would not rewrite it.
        continue
      }
      $ownerPid = 0
      try { $ownerPid = [int]$owner.pid } catch { $ownerPid = 0 }
      if ($ownerPid -le 0) { continue }
      $writtenAt = ConvertTo-LocalTimestamp $owner.writtenAt
      if ($writtenAt -and $writtenAt -lt $staleBefore) {
        # Heartbeat is stale: the owner really is gone (this also defeats PID reuse).
        if ($prune) { Remove-Item -LiteralPath $ownerFile.FullName -Force -ErrorAction SilentlyContinue }
        continue
      }
      if (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue) { $alive = $true; continue }
      if ($writtenAt) {
        # Recent heartbeat but Get-Process failed: treat as a transient error.
        $alive = $true
        continue
      }
      if ($prune) { Remove-Item -LiteralPath $ownerFile.FullName -Force -ErrorAction SilentlyContinue }
    }
    $script:OwnerAliveCache = $alive
    if ($prune) { $script:OwnerPruneAt = $now }
    return $alive
  } catch {
    # Fail open: a transient filesystem error must not close the overlay.
    return $true
  }
}

function Set-OverlayVisibility([bool]$Visible, [string]$Reason) {
  if ($Visible) {
    if (-not $form.Visible) {
      $form.Show()
      # The 5s data timer skips hidden windows, so fill the card once here.
      Update-Ui
      Write-OverlayLog "shown: $Reason"
    }
  } elseif ($form.Visible) {
    $form.Hide()
    Write-OverlayLog "hidden: $Reason"
  }
}

function Invoke-OneShotRefresh {
  try {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$WebBillPort/request-refresh" -Headers (Get-ReceiverHeaders) -TimeoutSec 2 | Out-Null
  } catch {}
  $helper = if ($HelperPath) { $HelperPath } else { Join-Path $PSScriptRoot 'usage-helper.mjs' }
  $node = if ($NodePath) { $NodePath } else { $env:CODEX_MCP_NODE_PATH }
  if (-not $node) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $node = $nodeCommand.Source }
  }
  if (-not $node -or -not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $helper)) { return }
  try {
    $argLine = '"' + $helper + '" --once --write --data-dir "' + $DataDir + '"'
    Start-Process -FilePath $node -ArgumentList $argLine -WindowStyle Hidden -Wait
    Update-Ui
  } catch {}
}

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.BackColor = [System.Drawing.Color]::FromArgb(28, 31, 36)
$form.ForeColor = [System.Drawing.Color]::White
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.Add_FormClosing({ Remove-OverlayArtifacts })

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.AutoSize = $false
$titleLabel.ForeColor = [System.Drawing.Color]::FromArgb(170, 225, 255)
$titleLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$titleLabel.UseMnemonic = $false

$bodyLabel = New-Object System.Windows.Forms.Label
$bodyLabel.AutoSize = $false
$bodyLabel.ForeColor = [System.Drawing.Color]::White
$bodyLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$bodyLabel.UseCompatibleTextRendering = $false
$bodyLabel.UseMnemonic = $false

$refreshButton = New-Object System.Windows.Forms.Button
$refreshButton.Text = '↻'
$refreshButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$refreshButton.FlatAppearance.BorderSize = 0
$refreshButton.BackColor = [System.Drawing.Color]::FromArgb(36, 41, 48)
$refreshButton.ForeColor = [System.Drawing.Color]::FromArgb(170, 225, 255)
$refreshButton.TabStop = $false
$refreshButton.Add_Click({ Invoke-OneShotRefresh })

$form.Controls.Add($titleLabel)
$form.Controls.Add($bodyLabel)
$form.Controls.Add($refreshButton)
Apply-UiFonts

function Update-Layout {
  Update-DpiScale | Out-Null
  $scale = [Math]::Max(0.5, $script:DpiScale * $script:FontScale)
  if ($script:Expanded) {
    $baseWidth = 520
    $baseHeight = 230
  } else {
    $baseWidth = 300
    $baseHeight = 72
  }

  $width = [int][Math]::Round($baseWidth * $scale)
  $height = [int][Math]::Round($baseHeight * $scale)
  try {
    $screen = [System.Windows.Forms.Screen]::FromControl($form)
    if ($screen) {
      $width = [Math]::Min($width, [int][Math]::Round($screen.WorkingArea.Width * 0.94))
      $height = [Math]::Min($height, [int][Math]::Round($screen.WorkingArea.Height * 0.90))
    }
  } catch {}

  $form.ClientSize = New-Object System.Drawing.Size($width, $height)
  $padding = [int][Math]::Round(12 * $scale)
  $top = [int][Math]::Round(7 * $scale)
  $gap = [int][Math]::Round(4 * $scale)
  $refreshSize = [Math]::Max([int][Math]::Round(24 * $scale), [int][Math]::Round($refreshButton.Font.GetHeight() + 10 * $scale))
  $titleHeight = [Math]::Max([int][Math]::Round(24 * $scale), [int][Math]::Round($titleLabel.Font.GetHeight() + 6 * $scale))

  $refreshButton.Left = $form.ClientSize.Width - $padding - $refreshSize
  $refreshButton.Top = $top
  $refreshButton.Width = $refreshSize
  $refreshButton.Height = $refreshSize
  $refreshButton.BringToFront()
  $titleLabel.Left = $padding
  $titleLabel.Top = $top
  $titleLabel.Width = [Math]::Max(60, $refreshButton.Left - $padding - $gap)
  $titleLabel.Height = $titleHeight

  $bodyTop = $top + $titleHeight + $gap
  $bodyLabel.Left = $padding
  $bodyLabel.Top = $bodyTop
  $bodyLabel.Width = $form.ClientSize.Width - (2 * $padding)
  $bodyLabel.Height = [Math]::Max(20, $form.ClientSize.Height - $bodyTop - $padding)
  $bodyLabel.TextAlign = if ($script:Expanded) {
    [System.Drawing.ContentAlignment]::TopLeft
  } else {
    [System.Drawing.ContentAlignment]::MiddleLeft
  }
}

function Set-FontScale([double]$Scale) {
  $nextScale = [Math]::Round([Math]::Min(1.5, [Math]::Max(0.85, $Scale)), 2)
  if ([Math]::Abs($nextScale - $script:FontScale) -lt 0.001) { return }
  $script:FontScale = $nextScale
  Apply-UiFonts
  Save-OverlaySettings
  Update-Layout
  Update-Ui
  Update-FontMenuChecks
  $script:LastPosition = $null
  Follow-Codex
}

function Update-Ui {
  $snap = Read-Snapshot
  if (-not $snap) { $titleLabel.Text = 'Usage Hub'; $bodyLabel.Text = '等待数据…'; return }
  $provider = if ($snap.provider) { $snap.provider.name } else { 'Usage Hub' }
  $model = if ($snap.model) { $snap.model.displayName } else { '' }
  $titleLabel.Text = "$provider · $model"
  if ($script:Expanded) {
    $bodyLabel.Text = (Get-OverlayText $snap)
  } else {
    $balance = if ($snap.balance -and $snap.balance.status -eq 'ok') { (Format-Money $snap.balance.available $snap.balance.currency) + (Get-BalanceSourceLabel $snap.balance.source -Stale:([bool]$snap.balance.stale)) } else { '--' }
    $today = if ($snap.today) { Format-Money $snap.today.cost $snap.today.currency } else { '--' }
    $todayLabel = if ($snap.today.reliable) { '今日' } else { '今日估算' }
    $bodyLabel.Text = "余额 $balance · $todayLabel $today"
  }
}

function Select-CodexWindowUncached {
  $processes = Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue
  $windows = @()
  foreach ($process in $processes) {
    if ($process.MainWindowHandle -eq 0) { continue }
    try {
      $processPath = "$($process.Path)"
      if ($processPath -notlike '*OpenAI.Codex*' -and $processPath -notlike '*\ChatGPT.exe' -and $processPath -notlike '*\Codex.exe') {
        continue
      }
    } catch {
      continue
    }
    $windows += $process
  }
  if ($windows.Count -eq 0) { return $null }

  $foregroundWindow = [UsageHub.Native]::GetForegroundWindow()
  if ($foregroundWindow -ne [IntPtr]::Zero) {
    $foregroundPid = [uint32]0
    [void][UsageHub.Native]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundPid)
    foreach ($process in $windows) {
      if ([uint32]$process.Id -eq $foregroundPid) { return $process }
    }
  }
  return $windows[0]
}

# Enumerating every ChatGPT/Codex process and reading Path on each one, twice per
# second, was a measurable constant CPU cost. Re-validate the cached process every
# tick (cheap) and only re-enumerate when it died or once every five ticks.
function Get-CodexWindow {
  $script:CodexLookupTick = [int]$script:CodexLookupTick + 1
  $cached = $script:CodexProcessCache
  if ($cached -and ($script:CodexLookupTick % 5) -ne 0) {
    try {
      $fresh = Get-Process -Id $cached.Id -ErrorAction Stop
      if ($fresh.MainWindowHandle -ne 0) { return $fresh }
    } catch {}
    $script:CodexProcessCache = $null
  }
  $selected = Select-CodexWindowUncached
  $script:CodexProcessCache = $selected
  return $selected
}

function Test-CodexWindowVisible([IntPtr]$Handle) {
  if ($Handle -eq [IntPtr]::Zero) { return $false }
  if ([UsageHub.Native]::IsIconic($Handle) -or -not [UsageHub.Native]::IsWindowVisible($Handle)) {
    return $false
  }
  try {
    $cloaked = 0
    if ([UsageHub.Native]::DwmGetWindowAttribute($Handle, 14, [ref]$cloaked, 4) -eq 0 -and $cloaked -ne 0) {
      return $false
    }
  } catch {}
  return $true
}

function Follow-Codex {
  if (Update-DpiScale) {
    Update-Layout
    $script:LastPosition = $null
  }

  if (-not (Test-OverlayOwnersAlive)) {
    if (-not $script:OwnerMissingSince) { $script:OwnerMissingSince = Get-Date }
    Set-OverlayVisibility $false 'plugin MCP unavailable'
    # Keep the hidden process warm for IdleExitSeconds so reopening Codex
    # reuses it instead of paying the PowerShell + WinForms start again.
    if (((Get-Date) - $script:OwnerMissingSince).TotalSeconds -ge $IdleExitSeconds) {
      $form.Close()
    }
    return
  }
  $script:OwnerMissingSince = $null

  $process = Get-CodexWindow
  if (-not $process) {
    if ($ExitWithCodex) {
      if (-not $script:CodexMissingSince) { $script:CodexMissingSince = Get-Date }
      if (((Get-Date) - $script:CodexMissingSince).TotalSeconds -ge $IdleExitSeconds) {
        $form.Close()
        return
      }
    } else {
      $script:CodexMissingSince = $null
    }
    Set-OverlayVisibility $false 'Codex window unavailable'
    return
  }
  $script:CodexMissingSince = $null

  if (-not (Test-CodexWindowVisible $process.MainWindowHandle)) {
    Set-OverlayVisibility $false 'Codex window hidden'
    return
  }

  if ($script:ForceHidden) {
    Set-OverlayVisibility $false 'control request'
    return
  }

  if (-not $script:Following -or $script:ManualPosition) {
    Set-OverlayVisibility $true 'Codex window visible'
    return
  }

  $rect = New-Object UsageHub.Native+RECT
  if (-not [UsageHub.Native]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) { return }
  $screen = [System.Windows.Forms.Screen]::FromHandle($process.MainWindowHandle).WorkingArea
  $x = $screen.Right - $form.Width - 20
  $y = $screen.Top + 70
  $positionKey = "$x,$y,$($form.Width),$($form.Height)"
  if ($script:LastPosition -ne $positionKey) {
    [UsageHub.Native]::SetWindowPos($form.Handle, [IntPtr](-1), $x, $y, $form.Width, $form.Height, 0x0010 -bor 0x0040) | Out-Null
    $script:LastPosition = $positionKey
  }
  Set-OverlayVisibility $true 'Codex window visible'
}

function Invoke-OverlayControl {
  if (-not (Test-Path -LiteralPath $controlPath)) { return }
  $control = Read-JsonFile $controlPath
  if (-not $control -or -not $control.action) { return }
  $action = "$($control.action)".ToLowerInvariant()
  Remove-Item -LiteralPath $controlPath -Force -ErrorAction SilentlyContinue
  if ($action -eq 'hide') {
    $script:ForceHidden = $true
    Set-OverlayVisibility $false 'control request'
  } elseif ($action -eq 'show') {
    $script:ForceHidden = $false
    Update-Layout
    Update-Ui
    Set-OverlayVisibility $true 'control request'
    Follow-Codex
  } elseif ($action -eq 'restart') {
    $form.Close()
  } elseif ($action -eq 'exit') {
    Write-OverlayStopMarker
    $form.Close()
  }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$refreshItem = [System.Windows.Forms.ToolStripMenuItem]$menu.Items.Add('立即刷新')
$followItem = [System.Windows.Forms.ToolStripMenuItem]$menu.Items.Add('跟随 Codex')
$expandItem = [System.Windows.Forms.ToolStripMenuItem]$menu.Items.Add('展开/收起')
$menuSeparator = New-Object System.Windows.Forms.ToolStripSeparator
[void]$menu.Items.Add($menuSeparator)

$fontMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem
$fontMenuItem.Text = '文字大小'
[void]$menu.Items.Add($fontMenuItem)
$fontMenuItem.DropDown.ShowImageMargin = $false

$fontIncreaseItem = New-Object System.Windows.Forms.ToolStripMenuItem
$fontIncreaseItem.Text = '增大字号'
[void]$fontMenuItem.DropDownItems.Add($fontIncreaseItem)
$fontDecreaseItem = New-Object System.Windows.Forms.ToolStripMenuItem
$fontDecreaseItem.Text = '减小字号'
[void]$fontMenuItem.DropDownItems.Add($fontDecreaseItem)
[void]$fontMenuItem.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$fontPresets = @(
  [pscustomobject]@{ Label = '小（85%）'; Scale = 0.85 },
  [pscustomobject]@{ Label = '标准（100%）'; Scale = 1.0 },
  [pscustomobject]@{ Label = '大（115%）'; Scale = 1.15 },
  [pscustomobject]@{ Label = '特大（130%）'; Scale = 1.3 },
  [pscustomobject]@{ Label = '超大（150%）'; Scale = 1.5 }
)
foreach ($preset in $fontPresets) {
  $presetItem = New-Object System.Windows.Forms.ToolStripMenuItem
  $presetItem.Text = $preset.Label
  $presetItem.Tag = [double]$preset.Scale
  $presetItem.CheckOnClick = $false
  $presetItem.Add_Click({
    param($sender, $event)
    Set-FontScale ([double]$sender.Tag)
  })
  [void]$fontMenuItem.DropDownItems.Add($presetItem)
  $script:FontMenuItems += $presetItem
}

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exitItem = [System.Windows.Forms.ToolStripMenuItem]$menu.Items.Add('退出')
$followItem.Checked = $true

function Update-FontMenuChecks {
  $percent = [int][Math]::Round($script:FontScale * 100)
  $fontMenuItem.Text = "文字大小（$percent%）"
  foreach ($item in $script:FontMenuItems) {
    $item.Checked = [Math]::Abs(([double]$item.Tag) - $script:FontScale) -lt 0.001
  }
}

$refreshItem.Add_Click({ Invoke-OneShotRefresh })
$followItem.Add_Click({
  $script:Following = -not $script:Following
  $script:ManualPosition = -not $script:Following
  $followItem.Checked = $script:Following
  $script:LastPosition = $null
  if ($script:Following) { Follow-Codex }
})
$expandItem.Add_Click({
  $script:Expanded = -not $script:Expanded
  Update-Layout
  Update-Ui
  $script:LastPosition = $null
})
$fontIncreaseItem.Add_Click({ Set-FontScale ($script:FontScale + 0.05) })
$fontDecreaseItem.Add_Click({ Set-FontScale ($script:FontScale - 0.05) })
$menu.Add_Opening({
  if (Update-DpiScale) {
    Update-Layout
    $script:LastPosition = $null
  }
  Update-FontMenuChecks
})

$exitItem.Add_Click({
  Write-OverlayStopMarker
  $form.Close()
})
$form.ContextMenuStrip = $menu
$titleLabel.ContextMenuStrip = $menu
$bodyLabel.ContextMenuStrip = $menu
$refreshButton.ContextMenuStrip = $menu
Update-FontMenuChecks

$titleLabel.Add_MouseDown({
  param($sender, $event)
  if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $script:Dragging = $true
    $script:DragStart = [System.Windows.Forms.Cursor]::Position
    $script:DragForm = @($form.Left, $form.Top)
  }
})
$titleLabel.Add_MouseMove({
  param($sender, $event)
  if (-not $script:Dragging) { return }
  $current = [System.Windows.Forms.Cursor]::Position
  $dx = $current.X - $script:DragStart.X
  $dy = $current.Y - $script:DragStart.Y
  $form.Left = $script:DragForm[0] + $dx
  $form.Top = $script:DragForm[1] + $dy
  $script:Following = $false
  $script:ManualPosition = $true
  $followItem.Checked = $false
})
$titleLabel.Add_MouseUp({
  param($sender, $event)
  $moved = $false
  if ($script:DragStart) {
    $current = [System.Windows.Forms.Cursor]::Position
    $moved = ([Math]::Abs($current.X - $script:DragStart.X) -gt 3 -or [Math]::Abs($current.Y - $script:DragStart.Y) -gt 3)
  }
  $script:Dragging = $false
  if (-not $moved) {
    $script:Expanded = -not $script:Expanded
    Update-Layout
    Update-Ui
    $script:LastPosition = $null
  }
})

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.SystemIcons]::Information
$tray.Text = 'Codex Usage Hub'
$tray.Visible = $true
$tray.ContextMenuStrip = $menu
$tray.Add_DoubleClick({
  $script:ForceHidden = $false
  $script:Expanded = -not $script:Expanded
  Update-Layout
  Update-Ui
  Follow-Codex
})

$followTimer = New-Object System.Windows.Forms.Timer
$followTimer.Interval = 1000
$followTimer.Add_Tick({ Follow-Codex })
$followTimer.Start()

$dataTimer = New-Object System.Windows.Forms.Timer
$dataTimer.Interval = 5000
$dataTimer.Add_Tick({
  if (Update-DpiScale) {
    Update-Layout
    $script:LastPosition = $null
  }
  # Repaint only when the snapshot on disk actually changed; the daemon already
  # skips no-op writes, so an unchanged file means an unchanged card.
  if ($form.Visible -and (Update-SnapshotCache)) {
    Update-Ui
  }
})
$dataTimer.Start()

$controlTimer = New-Object System.Windows.Forms.Timer
$controlTimer.Interval = 1500
$controlTimer.Add_Tick({ Invoke-OverlayControl })
$controlTimer.Start()

$form.Add_Shown({
  Write-OverlayLog 'form shown'
  Start-HelperIfNeeded
  Update-Layout
  Update-Ui
  Follow-Codex
})

$form.Add_FormClosed({ Write-OverlayLog 'form closed' })

[System.Windows.Forms.Application]::Run($form)
$controlTimer.Stop()
$dataTimer.Stop()
$followTimer.Stop()
$tray.Visible = $false
$tray.Dispose()
