@echo off
rem Start ERP local server in a VISIBLE window (for debugging: you can watch the log).
rem Closing this window stops the server. For background use erp-server-hidden.vbs.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0erp-server.ps1"
