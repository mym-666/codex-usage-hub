@echo off
setlocal EnableExtensions
rem Usage Hub standalone overlay launcher.
rem Resolves the newest installed plugin copy under %USERPROFILE%\.codex\plugins\cache
rem and forwards the action (start|stop|status, default start) to that copy's
rem scripts\overlay-standalone.ps1. Copy this file anywhere - it has no fixed
rem dependency on the repository path.

set "PLUGIN="
set "CACHE=%USERPROFILE%\.codex\plugins\cache\usage-hub-local\usage-hub"
if exist "%CACHE%" (
  for /f "delims=" %%D in ('dir /b /ad /o-n "%CACHE%" 2^>nul') do (
    if not defined PLUGIN set "PLUGIN=%CACHE%\%%D"
  )
)
if not defined PLUGIN goto :missing
if not exist "%PLUGIN%\scripts\overlay-standalone.ps1" goto :missing

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PLUGIN%\scripts\overlay-standalone.ps1" %*
exit /b %ERRORLEVEL%

:missing
echo Usage Hub plugin was not found under "%CACHE%".
echo Install it first, for example: codex plugin add usage-hub@usage-hub-local
exit /b 1