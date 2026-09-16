param(
  [Parameter(Mandatory = $true)][string]$DataDir,
  [Parameter(Mandatory = $true)][string]$HelperPath,
  [Parameter(Mandatory = $true)][string]$NodePath,
  [int]$WebBillPort = 32146,
  [string]$OwnerDir = '',
  [string]$StopPath = '',
  [int]$IdleExitSeconds = 300
)

$ErrorActionPreference = 'Stop'
$overlayPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\runtime\usage-overlay.ps1'))
$arguments = @(
  '-NoProfile'
  '-ExecutionPolicy Bypass'
  '-WindowStyle Hidden'
  ('-File "{0}"' -f $overlayPath.Replace('"', '""'))
  ('-DataDir "{0}"' -f $DataDir.Replace('"', '""'))
  ('-HelperPath "{0}"' -f $HelperPath.Replace('"', '""'))
  ('-NodePath "{0}"' -f $NodePath.Replace('"', '""'))
  ('-WebBillPort {0}' -f $WebBillPort)
  ('-OwnerDir "{0}"' -f $OwnerDir.Replace('"', '""'))
  ('-StopPath "{0}"' -f $StopPath.Replace('"', '""'))
  ('-IdleExitSeconds {0}' -f $IdleExitSeconds)
  '-ExitWithCodex'
) -join ' '

Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden | Out-Null
