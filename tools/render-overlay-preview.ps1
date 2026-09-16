<#
.SYNOPSIS
  Render docs and plugin-card images for Usage Hub.

.DESCRIPTION
  The preview uses the overlay's own text-formatting code (Format-Money,
  Format-Compact, Get-BalanceSourceLabel, Get-OverlayText) so the picture cannot
  drift from the shipped layout. All values in the preview are demo data.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\render-overlay-preview.ps1
#>
[CmdletBinding()]
param(
  [string]$PluginRoot = ''
)

$ErrorActionPreference = 'Stop'
if (-not $PluginRoot) { $PluginRoot = Join-Path $PSScriptRoot '..\plugins\usage-hub' }
Add-Type -AssemblyName System.Drawing

$pluginRoot = [IO.Path]::GetFullPath($PluginRoot)
$overlayPath = Join-Path $pluginRoot 'runtime\usage-overlay.ps1'
$assetDir = Join-Path $pluginRoot 'assets'
if (-not (Test-Path -LiteralPath $overlayPath)) { throw "Missing overlay script: $overlayPath" }
if (-not (Test-Path -LiteralPath $assetDir)) { New-Item -ItemType Directory -Force -Path $assetDir | Out-Null }

# Reuse the real formatting helpers instead of duplicating them here.
$overlayText = [IO.File]::ReadAllText($overlayPath)
$start = $overlayText.IndexOf('function Format-Money(')
$end = $overlayText.IndexOf('function Read-Snapshot')
if ($start -lt 0 -or $end -lt 0 -or $end -le $start) { throw 'Could not slice the formatting helpers out of usage-overlay.ps1' }
Invoke-Expression $overlayText.Substring($start, $end - $start)

$demoSnapshot = [pscustomobject]@{
  provider = [pscustomobject]@{ name = 'deepseek' }
  model    = [pscustomobject]@{ displayName = 'DeepSeek V4 Flash' }
  balance  = [pscustomobject]@{ status = 'ok'; available = 128.40; currency = 'CNY'; source = 'provider-api' }
  today    = [pscustomobject]@{
    cost         = 3.26
    currency     = 'CNY'
    source       = 'web-extension'
    tokenScope   = 'codex'
    tokenSource  = 'codex-log'
    reliable     = $true
    stale        = $false
    tokens       = [pscustomobject]@{ total = 12340000; input = 12100000; output = 240000; cacheRead = 11800000; freshInput = 300000 }
  }
  session  = [pscustomobject]@{
    status = 'ok'
    tokens = [pscustomobject]@{ total = 1280000; input = 1260000; output = 24600; cacheRead = 1100000; freshInput = 155200 }
  }
  warnings = @()
}

$title = "$($demoSnapshot.provider.name) · $($demoSnapshot.model.displayName)"
$bodyExpanded = (Get-OverlayText $demoSnapshot).TrimEnd("`r", "`n")
$bodyCollapsed = "余额 $(Format-Money $demoSnapshot.balance.available $demoSnapshot.balance.currency)$(Get-BalanceSourceLabel $demoSnapshot.balance.source) · 今日 $(Format-Money $demoSnapshot.today.cost $demoSnapshot.today.currency)"

$backColor = [System.Drawing.Color]::FromArgb(28, 31, 36)
$borderColor = [System.Drawing.Color]::FromArgb(70, 75, 84)
$accentColor = [System.Drawing.Color]::FromArgb(170, 225, 255)
$buttonColor = [System.Drawing.Color]::FromArgb(36, 41, 48)
$bodyColor = [System.Drawing.Color]::White

$titleFont = New-Object System.Drawing.Font('Segoe UI', 10.0, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
$bodyFont = New-Object System.Drawing.Font('Segoe UI', 10.0, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
$refreshFont = New-Object System.Drawing.Font('Segoe UI', 11.0, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)

function New-Panel([int]$width, [int]$height, [string]$body, [bool]$expanded) {
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $graphics.Clear($backColor)
  $borderPen = New-Object System.Drawing.Pen($borderColor, 1)
  $graphics.DrawRectangle($borderPen, 0, 0, $width - 1, $height - 1)

  $padding = 12
  $top = 7
  $gap = 4
  $titleHeight = 24
  $refreshSize = 24

  $refreshRect = New-Object System.Drawing.RectangleF(($width - $padding - $refreshSize), $top, $refreshSize, $refreshSize)
  $buttonBrush = New-Object System.Drawing.SolidBrush($buttonColor)
  $graphics.FillRectangle($buttonBrush, $refreshRect)
  $accentBrush = New-Object System.Drawing.SolidBrush($accentColor)
  $refreshFormat = New-Object System.Drawing.StringFormat
  $refreshFormat.Alignment = [System.Drawing.StringAlignment]::Center
  $refreshFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
  $graphics.DrawString([char]0x21BB, $refreshFont, $accentBrush, $refreshRect, $refreshFormat)

  $titleFormat = New-Object System.Drawing.StringFormat
  $titleFormat.Alignment = [System.Drawing.StringAlignment]::Near
  $titleFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
  $titleRect = New-Object System.Drawing.RectangleF($padding, $top, ($width - (2 * $padding) - $refreshSize - $gap), $titleHeight)
  $graphics.DrawString($title, $titleFont, $accentBrush, $titleRect, $titleFormat)

  $bodyTop = $top + $titleHeight + $gap
  $bodyRect = New-Object System.Drawing.RectangleF($padding, $bodyTop, ($width - (2 * $padding)), ($height - $bodyTop - $padding))
  $bodyBrush = New-Object System.Drawing.SolidBrush($bodyColor)
  $bodyFormat = New-Object System.Drawing.StringFormat
  $bodyFormat.LineAlignment = if ($expanded) { [System.Drawing.StringAlignment]::Near } else { [System.Drawing.StringAlignment]::Center }
  $graphics.DrawString($body, $bodyFont, $bodyBrush, $bodyRect, $bodyFormat)

  $graphics.Dispose()
  $borderPen.Dispose(); $buttonBrush.Dispose(); $accentBrush.Dispose(); $bodyBrush.Dispose()
  $refreshFormat.Dispose(); $titleFormat.Dispose(); $bodyFormat.Dispose()
  return $bitmap
}
# --- overlay.png: collapsed and expanded card side by side -------------------
$collapsed = New-Panel 300 72 $bodyCollapsed $false
$expanded = New-Panel 520 260 $bodyExpanded $true

$gap = 24
$margin = 12
$canvasWidth = $margin + $collapsed.Width + $gap + $expanded.Width + $margin
$canvasHeight = $margin + [Math]::Max($collapsed.Height, $expanded.Height) + $margin
$canvas = New-Object System.Drawing.Bitmap($canvasWidth, $canvasHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$canvasGraphics = [System.Drawing.Graphics]::FromImage($canvas)
$canvasGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$canvasGraphics.Clear([System.Drawing.Color]::Transparent)
$collapsedY = $margin + [int](($expanded.Height - $collapsed.Height) / 2)
$canvasGraphics.DrawImage($collapsed, $margin, $collapsedY)
$canvasGraphics.DrawImage($expanded, $margin + $collapsed.Width + $gap, $margin)
$canvasGraphics.Dispose()

$overlayPng = Join-Path $assetDir 'overlay.png'
$canvas.Save($overlayPng, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()
$collapsed.Dispose()
$expanded.Dispose()

# --- logo.png / icon.png -----------------------------------------------------
function New-Logo([int]$size) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $radius = [single]($size * 0.22)
  $inset = [single]($size * 0.02)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $left = $inset; $top = $inset; $right = $size - $inset; $bottom = $size - $inset
  $path.AddArc($left, $top, $diameter, $diameter, 180, 90)
  $path.AddArc($right - $diameter, $top, $diameter, $diameter, 270, 90)
  $path.AddArc($right - $diameter, $bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($left, $bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()

  $brandBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF(0, 0)),
    (New-Object System.Drawing.PointF($size, $size)),
    [System.Drawing.Color]::FromArgb(37, 99, 235),
    [System.Drawing.Color]::FromArgb(56, 189, 248))
  $graphics.FillPath($brandBrush, $path)

  $barBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $unit = $size / 16.0
  $bars = @(
    @(3.5, 9.0, 2.0, 4.0),
    @(7.0, 6.0, 2.0, 7.0),
    @(10.5, 3.0, 2.0, 10.0)
  )
  foreach ($bar in $bars) {
    $x = [single]($bar[0] * $unit)
    $y = [single]($bar[1] * $unit)
    $w = [single]($bar[2] * $unit)
    $h = [single]($bar[3] * $unit)
    $rect = New-Object System.Drawing.RectangleF($x, $y, $w, $h)
    $graphics.FillRectangle($barBrush, $rect)
  }

  $graphics.Dispose()
  $path.Dispose(); $brandBrush.Dispose(); $barBrush.Dispose()
  return $bitmap
}

$logo = New-Logo 512
$logoPng = Join-Path $assetDir 'logo.png'
$logo.Save($logoPng, [System.Drawing.Imaging.ImageFormat]::Png)
$logo.Dispose()

$icon = New-Logo 128
$iconPng = Join-Path $assetDir 'icon.png'
$icon.Save($iconPng, [System.Drawing.Imaging.ImageFormat]::Png)
$icon.Dispose()

foreach ($font in $titleFont, $bodyFont, $refreshFont) { $font.Dispose() }

Write-Host "Wrote:"
Write-Host "  $overlayPng"
Write-Host "  $logoPng"
Write-Host "  $iconPng"