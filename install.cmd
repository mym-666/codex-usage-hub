@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem Resolve the marketplace root from this script instead of a fixed drive.
for %%I in ("%~dp0.") do set "ROOT=%%~fI"
set "MARKETPLACE_NAME=usage-hub-local"
set "PLUGIN_SELECTOR=usage-hub@usage-hub-local"
set "MARKETPLACE_FILE=%ROOT%\.agents\plugins\marketplace.json"
set "PLUGIN_MANIFEST=%ROOT%\plugins\usage-hub\.codex-plugin\plugin.json"
set "EXTENSION_DIR=%ROOT%\plugins\usage-hub\edge-extension"

echo Usage Hub installer
echo ===================
echo.

if not exist "%MARKETPLACE_FILE%" goto :missing_files
if not exist "%PLUGIN_MANIFEST%" goto :missing_files
if not exist "%EXTENSION_DIR%\manifest.json" goto :missing_files

call :FindCodex
if not defined CODEX_EXE goto :codex_missing

"%CODEX_EXE%" plugin --help >nul 2>&1
if errorlevel 1 goto :unsupported_codex

echo Codex executable: "%CODEX_EXE%"
echo Marketplace root: "%ROOT%"
echo.

echo Registering local marketplace...
"%CODEX_EXE%" plugin marketplace add "%ROOT%"
if errorlevel 1 goto :install_failed

set "PLUGIN_INSTALLED="
"%CODEX_EXE%" plugin list --json 2>nul | findstr /i /c:"usage-hub@usage-hub-local" >nul
if not errorlevel 1 set "PLUGIN_INSTALLED=1"

if defined PLUGIN_INSTALLED (
  echo Usage Hub is already installed. Skipping plugin add.
) else (
  echo Installing Usage Hub plugin...
  "%CODEX_EXE%" plugin add "%PLUGIN_SELECTOR%"
  if errorlevel 1 goto :install_failed
)

echo.
echo Installation command completed.
echo Start a new Codex thread so the plugin MCP server and overlay can load.
echo.
echo Edge extension directory for manual setup:
echo   "%EXTENSION_DIR%"
echo.
echo IMPORTANT: if Usage Hub was already installed, reload the Edge extension.
echo Its version must read 1.7.1 after this update; older copies stop working.
echo Reloading is required because the plugin cache path changes on every update.
echo.
echo To install the optional web-bill bridge, open edge://extensions, enable
echo Developer mode, choose "Load unpacked", and select the directory above.
exit /b 0

:FindCodex
set "CODEX_EXE="

for /f "delims=" %%I in ('where.exe codex.exe 2^>nul') do (
  if not defined CODEX_EXE set "CODEX_EXE=%%I"
)
if defined CODEX_EXE exit /b 0

if exist "%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe" (
  set "CODEX_EXE=%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe"
  exit /b 0
)

if exist "%USERPROFILE%\.codex\bin\codex.exe" (
  set "CODEX_EXE=%USERPROFILE%\.codex\bin\codex.exe"
  exit /b 0
)

for /f "delims=" %%D in ('dir /b /ad /o-d "%LOCALAPPDATA%\OpenAI\Codex\bin" 2^>nul') do (
  if not defined CODEX_EXE if exist "%LOCALAPPDATA%\OpenAI\Codex\bin\%%D\codex.exe" (
    set "CODEX_EXE=%LOCALAPPDATA%\OpenAI\Codex\bin\%%D\codex.exe"
  )
)
exit /b 0

:missing_files
echo ERROR: The installer could not find the expected Usage Hub files under:
echo   "%ROOT%"
echo.
echo Keep install.cmd in the repository root and run it from the extracted
echo or cloned copy of the full project.
exit /b 1

:codex_missing
echo ERROR: Codex CLI was not found.
echo Install or start the Codex desktop app, then run this file again.
echo If Codex is installed in a custom location, add codex.exe to PATH.
exit /b 1

:unsupported_codex
echo ERROR: The detected Codex CLI does not support plugin commands.
echo Update Codex, then run this installer again.
exit /b 1

:install_failed
echo.
echo ERROR: Usage Hub installation failed.
echo Close or restart the Codex desktop app if the plugin cache is in use,
echo then run install.cmd again.
exit /b 1
