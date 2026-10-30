@echo off
rem Stop ERP local server (supervisor + node) and confirm the port is released.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-erp.ps1"
echo.
pause
