@echo off
rem Restart the ERP local server for real (needs an elevated window).
rem node runs as SYSTEM, so a normal window cannot kill it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-erp.ps1"
echo.
pause
