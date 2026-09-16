# Usage Hub unit test runner.
#
# Why this exists: "node --test <directory>" fails on Node 24 with
# "Cannot find module <directory>", so the explicit file list is required.
#
# Usage (Windows PowerShell 5.1 or newer):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\run-tests.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\run-tests.ps1 -NamePattern fetchJson

param(
  [string]$NamePattern = ""
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$files = @(Get-ChildItem -LiteralPath $here -Filter '*.test.mjs' -File | Sort-Object Name | Select-Object -ExpandProperty FullName)
if ($files.Count -eq 0) { throw "No *.test.mjs files found in $here" }

$nodeArgs = @('--test')
if ($NamePattern) { $nodeArgs += @('--test-name-pattern', $NamePattern) }
$nodeArgs += $files

Write-Host ("Running {0} test file(s) with {1}" -f $files.Count, (Get-Command node).Source)
& node @nodeArgs
exit $LASTEXITCODE