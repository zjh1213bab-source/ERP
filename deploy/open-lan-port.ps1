# 以【管理员】身份运行本脚本：放行 3000 端口（仅局域网）
# 运行方式：右键此文件 →「使用 PowerShell 运行」；若提示权限，请右键开始菜单用管理员 PowerShell 执行：
#   powershell -ExecutionPolicy Bypass -File .\open-lan-port.ps1

$ErrorActionPreference = 'Stop'
$name = 'ERP Mindmap 3000 (LAN only)'

if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort 3000 `
    -Action Allow -Profile Any -RemoteAddress LocalSubnet | Out-Null
  Write-Host "已放行 3000 端口（仅本地局域网，公网不可访问）" -ForegroundColor Green
} else {
  Write-Host "规则已存在，无需重复添加" -ForegroundColor Yellow
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -First 1).IPAddress
Write-Host ""
Write-Host ("本机访问:   http://127.0.0.1:3000") -ForegroundColor Cyan
Write-Host ("局域网访问: http://" + $ip + ":3000") -ForegroundColor Cyan
Write-Host ""
Read-Host "按回车退出"
