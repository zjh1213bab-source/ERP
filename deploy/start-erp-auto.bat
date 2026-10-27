@echo off
rem ERP backend auto-start launcher (called by start-erp-auto.vbs with hidden window)
setlocal
chcp 65001 >nul
cd /d "%~dp0..\backend"
set PORT=3000
if not exist logs mkdir logs
set LOG=logs\server.log
set NODE=C:\Users\admin\.workbuddy\binaries\node\versions\22.22.2-6\node.exe
netstat -ano | findstr /C:":3000" | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 goto alreadyrun
echo.>>"%LOG%"
>>"%LOG%" echo [%date% %time%] ==== starting ERP backend on port 3000 ====
"%NODE%" -e "const os=require('os');const n=os.networkInterfaces();for(const k in n){for(const i of n[k]){if(i.family==='IPv4'&&!i.internal)console.log('[net] LAN IP:',i.address)}}" >>"%LOG%"
"%NODE%" src\server.js >>"%LOG%" 2>&1
>>"%LOG%" echo [%date% %time%] ERP backend exited with code %errorlevel%
goto end
:alreadyrun
>>"%LOG%" echo [%date% %time%] port 3000 already listening, skip start
:end
endlocal
