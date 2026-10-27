@echo off
setlocal
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting administrator privileges, please click YES ...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo.
echo [1/3] Disabling inbound BLOCK rules for node.exe (they override allow rules) ...
powershell -NoProfile -Command "$rs=Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True -ErrorAction SilentlyContinue; foreach($r in $rs){ $a=$r|Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue; if($a.Program -like '*node.exe*'){ Disable-NetFirewallRule -InputObject $r -ErrorAction SilentlyContinue } }"
echo [2/3] Ensuring inbound ALLOW rule for TCP 3000 (LocalSubnet) ...
netsh advfirewall firewall delete rule name="ERP Mindmap 3000 (LAN only)" >nul 2>&1
netsh advfirewall firewall add rule name="ERP Mindmap 3000 (LAN only)" dir=in action=allow protocol=TCP localport=3000 remoteip=localsubnet profile=any
echo [3/3] Verify ...
netsh advfirewall firewall show rule name="ERP Mindmap 3000 (LAN only)"
echo.
echo ---- node.exe inbound rules status ----
powershell -NoProfile -Command "Get-NetFirewallRule -DisplayName 'node.exe' -Direction Inbound -ErrorAction SilentlyContinue | Select-Object DisplayName,Action,Enabled | Format-Table -AutoSize | Out-String -Width 120"
echo.
echo Done. LAN URL: http://192.168.110.69:3000
echo If still blocked: 1) router AP isolation ? 2) different VLAN ?
echo.
pause
