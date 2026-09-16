@echo off
rem Double-click entry point: stop the standalone Usage Hub overlay and its helper.
call "%~dp0usage-hub-overlay.cmd" stop %*
exit /b %ERRORLEVEL%