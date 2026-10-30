<#
  停止 ERP 本机服务（守护 + node）
  ============================================================
  顺序：
    1. 写停止标记，让守护脚本自己收尾（正常路径，node 会被优雅结束）
    2. 最多等 20 秒，看端口是否释放
    3. 还没释放就按命令行认人，杀掉跑本项目的 node（只杀本项目，不误伤别的 node）
  最后把停止标记删掉，否则下次启动会立刻又退出。
#>
[CmdletBinding()]
param([string]$ConfigPath = (Join-Path $PSScriptRoot 'erp-server.config.json'))

$ErrorActionPreference = 'Continue'
if (-not (Test-Path $ConfigPath)) { Write-Host "找不到配置：$ConfigPath"; exit 1 }
$cfg = Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$appDir = $cfg.appDir
$port = [int]$cfg.port
$stopFile = Join-Path $appDir $cfg.stopFile
$logDir = Join-Path $appDir $cfg.logDir

function Test-PortListening([int]$p) {
  try {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($c) { return $true }
    return $false
  } catch {
    try { $t = New-Object System.Net.Sockets.TcpClient; $t.Connect('127.0.0.1', $p); $t.Close(); return $true } catch { return $false }
  }
}

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
Set-Content -Path $stopFile -Value ('stop requested at ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8
Write-Host '已写停止标记，等待守护收尾…'

$freed = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  if (-not (Test-PortListening $port)) { $freed = $true; break }
}

if (-not $freed) {
  Write-Host '端口仍被占用，按命令行匹配结束本项目的 node 进程…'
  $hit = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*src\server.js*' -and $_.CommandLine -like "*$appDir*" }
  # 兼容用正斜杠传参的情况（node src/server.js 从 Git Bash 起时命令行里是 /）
  if (-not $hit) {
    $hit = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like '*src/server.js*' }
  }
  foreach ($p in $hit) {
    Write-Host ('  结束 pid=' + $p.ProcessId)
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
  }
  Start-Sleep -Seconds 2
}

# 兜底：守护脚本本身（powershell 跑 erp-server.ps1）
$sup = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*erp-server.ps1*' }
foreach ($p in $sup) {
  Write-Host ('  结束守护 pid=' + $p.ProcessId)
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
}

Remove-Item -Path $stopFile -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

if (Test-PortListening $port) {
  Write-Host ('停止失败：端口 ' + $port + ' 仍在监听，请用 netstat -ano | findstr :' + $port + ' 看是谁')
  exit 2
}
Write-Host ('已停止：端口 ' + $port + ' 已释放')
exit 0
