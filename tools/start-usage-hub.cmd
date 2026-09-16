@echo off
rem Double-click entry point: start the standalone Usage Hub overlay.
call "%~dp0usage-hub-overlay.cmd" start %*
exit /b %ERRORLEVEL%