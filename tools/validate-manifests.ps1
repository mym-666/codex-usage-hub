<#
.SYNOPSIS
  Validate the plugin, marketplace and extension manifests.

.DESCRIPTION
  Mirrors the checks the Codex plugin ingestion path performs: allowed manifest
  keys, required fields, semver, asset paths inside the plugin, and a Manifest V3
  extension. Runs without any dependency (no Python, no npm install).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\validate-manifests.ps1
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = Join-Path $PSScriptRoot '..' }
$root = [IO.Path]::GetFullPath($RepoRoot)
$errors = New-Object System.Collections.Generic.List[string]

function Read-Json([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    $script:errors.Add("missing file: $Path")
    return $null
  }
  try {
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
  } catch {
    $script:errors.Add("invalid JSON in $Path : $($_.Exception.Message)")
    return $null
  }
}

$pluginRoot = Join-Path $root 'plugins\usage-hub'
$manifest = Read-Json (Join-Path $pluginRoot '.codex-plugin\plugin.json')
if ($manifest) {
  $allowed = @('id', 'name', 'version', 'description', 'skills', 'apps', 'mcpServers', 'interface', 'author', 'homepage', 'repository', 'license', 'keywords')
  foreach ($key in $manifest.PSObject.Properties.Name) {
    if ($allowed -notcontains $key) { $errors.Add("plugin.json field '$key' is not accepted by plugin validation") }
  }
  foreach ($field in 'name', 'version', 'description') {
    if (-not $manifest.$field) { $errors.Add("plugin.json is missing '$field'") }
  }
  if ($manifest.version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') {
    $errors.Add("plugin.json version is not strict semver: $($manifest.version)")
  }
  if ($manifest.mcpServers -ne './.mcp.json') { $errors.Add("plugin.json mcpServers must be './.mcp.json'") }
  if (-not $manifest.author -or -not $manifest.author.name) { $errors.Add('plugin.json author.name is required') }

  $interface = $manifest.interface
  if (-not $interface) {
    $errors.Add('plugin.json is missing the interface block')
  } else {
    foreach ($field in 'displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'capabilities') {
      if (-not $interface.$field) { $errors.Add("plugin.json interface.$field is required") }
    }
    if ($interface.defaultPrompt -and @($interface.defaultPrompt).Count -gt 3) {
      $errors.Add('plugin.json interface.defaultPrompt accepts at most 3 prompts')
    }
    foreach ($urlField in 'websiteURL', 'privacyPolicyURL', 'termsOfServiceURL') {
      $value = $interface.$urlField
      if ($value -and $value -notmatch '^https://') { $errors.Add("plugin.json interface.$urlField must be an absolute https URL") }
    }
    foreach ($assetField in 'composerIcon', 'logo', 'logoDark') {
      $value = $interface.$assetField
      if ($value) {
        $assetPath = Join-Path $pluginRoot ($value -replace '^\./', '' -replace '/', '\')
        if (-not (Test-Path -LiteralPath $assetPath)) { $errors.Add("plugin.json interface.$assetField points at a missing file: $value") }
      }
    }
    foreach ($shot in @($interface.screenshots)) {
      if (-not $shot) { continue }
      if ($shot -notmatch '^\./assets/.+\.png$') { $errors.Add("screenshot must be a PNG under ./assets/: $shot") }
      $assetPath = Join-Path $pluginRoot ($shot -replace '^\./', '' -replace '/', '\')
      if (-not (Test-Path -LiteralPath $assetPath)) { $errors.Add("screenshot file is missing: $shot") }
    }
  }
}

$marketplace = Read-Json (Join-Path $root '.agents\plugins\marketplace.json')
if ($marketplace) {
  if (-not $marketplace.name) { $errors.Add('marketplace.json is missing name') }
  $entry = @($marketplace.plugins) | Where-Object { $_.name -eq 'usage-hub' } | Select-Object -First 1
  if (-not $entry) {
    $errors.Add('marketplace.json has no usage-hub entry')
  } else {
    if ($entry.source.source -ne 'local') { $errors.Add("marketplace entry source must be 'local'") }
    if ($entry.source.path -notmatch '^\./plugins/') { $errors.Add("marketplace entry path must be a plugin-relative path, got '$($entry.source.path)'") }
    foreach ($field in 'installation', 'authentication') {
      if (-not $entry.policy.$field) { $errors.Add("marketplace entry policy.$field is required") }
    }
    if (-not $entry.category) { $errors.Add('marketplace entry category is required') }
    $pluginDir = Join-Path $root ($entry.source.path -replace '^\./', '' -replace '/', '\')
    if (-not (Test-Path -LiteralPath $pluginDir)) { $errors.Add("marketplace entry path does not exist: $($entry.source.path)") }
  }
}

$mcp = Read-Json (Join-Path $pluginRoot '.mcp.json')
if ($mcp -and -not $mcp.mcpServers.'usage-hub') { $errors.Add('.mcp.json has no usage-hub server entry') }

$extension = Read-Json (Join-Path $pluginRoot 'edge-extension\manifest.json')
if ($extension) {
  if ($extension.manifest_version -ne 3) { $errors.Add('edge extension must use manifest_version 3') }
  if ($extension.version -notmatch '^\d+\.\d+\.\d+$') { $errors.Add("edge extension version must be x.y.z, got $($extension.version)") }
  if (-not $extension.background.service_worker) { $errors.Add('edge extension needs a background service worker') }
  foreach ($hostPermission in @($extension.host_permissions)) {
    if (-not $hostPermission) { continue }
    if ($hostPermission -notmatch '^(https://[^/]+/|http://127\.0\.0\.1)') { $errors.Add("edge extension host permission is unexpected: $hostPermission") }
  }
  if (-not (Join-Path $pluginRoot 'edge-extension\popup.html' | Test-Path)) { $errors.Add('edge extension popup.html is missing') }
}

if ($errors.Count -gt 0) {
  Write-Host 'Manifest validation failed:' -ForegroundColor Red
  foreach ($item in $errors) { Write-Host "  - $item" -ForegroundColor Red }
  exit 1
}

Write-Host ("Manifest validation passed: plugin {0}, extension {1}" -f $manifest.version, $extension.version) -ForegroundColor Green