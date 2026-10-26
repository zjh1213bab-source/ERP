@echo off
chcp 65001 >nul
cd /d "%~dp0..\backend"
set PORT=3000
echo ============================================
echo   跳色科技 ERP 后端启动中 (端口 3000)
echo   本机访问:   http://127.0.0.1:3000
echo   局域网访问: http://本机IP:3000
echo ============================================
echo.
node src\server.js
echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul
