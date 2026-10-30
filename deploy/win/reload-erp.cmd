@echo off
rem Reload code without admin: drop a marker file, the supervisor restarts node.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0reload-erp.ps1"
echo.
pause
