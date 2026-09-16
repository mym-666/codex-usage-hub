$ErrorActionPreference = 'Stop'

# Node is resolved from an explicit allowlist of installation roots. Anything
# else is skipped WITHOUT being executed, so a hostile node.exe dropped into a
# writable directory that happens to appear early in PATH cannot run here.
function Get-AllowedNodeRoots {
  $roots = @()
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs'),
    $(if ($env:ProgramFiles) { Join-Path ${env:ProgramFiles(x86)} 'nodejs' }),
    (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes'),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes')
  )
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    if (Test-Path -LiteralPath $candidate -PathType Container) {
      try { $roots += (Resolve-Path -LiteralPath $candidate).Path.TrimEnd('\') } catch {}
    }
  }
  return $roots
}

function Resolve-NodeLiteral([string]$Path) {
  if (-not $Path) { return $null }
  try { return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path } catch { return $null }
}

function Test-AllowedNodePath([string]$Path) {
  $full = Resolve-NodeLiteral $Path
  if (-not $full) { return $false }
  $configured = Resolve-NodeLiteral $env:CODEX_MCP_NODE_PATH
  if ($configured -and $full -ieq $configured) { return $true }
  foreach ($root in (Get-AllowedNodeRoots)) {
    if ($full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Test-NodePath([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  if (-not (Test-AllowedNodePath $Path)) { return $false }
  try {
    $version = (& $Path --version 2>$null).TrimStart('v')
    $major = [int]($version.Split('.')[0])
    return $major -ge 22
  } catch {
    return $false
  }
}

function Resolve-NodePath {
  if ($env:CODEX_MCP_NODE_PATH -and (Test-NodePath $env:CODEX_MCP_NODE_PATH)) { return $env:CODEX_MCP_NODE_PATH }

  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command -and (Test-NodePath $command.Source)) { return $command.Source }

  $candidates = @()
  $searchRoots = @(
    (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes'),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes')
  )
  foreach ($root in $searchRoots) {
    $candidates += Get-ChildItem -Path $root -Filter node.exe -Recurse -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -ExpandProperty FullName
  }

  foreach ($candidate in $candidates) {
    if (Test-NodePath $candidate) { return $candidate }
  }

  throw (@(
    'Usage Hub requires Node.js 22 or newer from one of these locations:',
    "  CODEX_MCP_NODE_PATH (currently: '$($env:CODEX_MCP_NODE_PATH)')",
    "  $(Join-Path $env:ProgramFiles 'nodejs')",
    "  $(Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes')",
    "  $(Join-Path $env:USERPROFILE '.cache\codex-runtimes')",
    'A node.exe outside these locations was found but not executed.'
  ) -join [Environment]::NewLine)
}

$nodePath = Resolve-NodePath
$serverPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\mcp\server.mjs'))
& $nodePath $serverPath
exit $LASTEXITCODE