<#
  把 ERP 本机服务挂到「登录后自动启动」（当前用户，不需要管理员）
  ============================================================
  做的事：
    1. 校验配置（node 路径 / 应用目录 / 入口文件）
    2. 在「启动文件夹」写一个 ERP-Server.cmd —— Windows 登录时会自动执行它
    3. 立刻用同一方式拉起来，并做健康检查（可加 -SkipStart 跳过）

  为什么用启动文件夹 + cmd，而不是计划任务 / VBS / Windows 服务：
    · 计划任务：本机的 schtasks 被安全策略禁用，注册不了
    · VBS（wscript）：被安全策略列为 LOLBin，禁止调用
    · Windows 服务：要管理员权限，当前会话没有
  启动文件夹是纯用户级机制，链路上只有 cmd -> powershell -> node，全部能验证。

  限制（必须知道）：这是「登录后自动起」，不是「开机即起」。机器重启后如果没人登录，
  服务不会跑。要真正开机即启（无人登录也跑）必须装成 Windows 服务，需要管理员。

  取消自启：install-autostart.ps1 -Uninstall（只删启动项，不动数据）
#>
[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot 'erp-server.config.json'),
  [switch]$SkipStart,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$startupDir = [Environment]::GetFolderPath('Startup')
$cmdPath = Join-Path $startupDir 'ERP-Server.cmd'
$oldVbs = Join-Path $startupDir 'ERP-Server.vbs'   # 早期版本用 VBS（已被安全策略禁用）

if ($Uninstall) {
  if (Test-Path $cmdPath) { Remove-Item -Path $cmdPath -Force; Write-Host ('已移除自启项：' + $cmdPath) }
  if (Test-Path $oldVbs) { Remove-Item -Path $oldVbs -Force; Write-Host ('已移除旧 VBS 自启项：' + $oldVbs) }
  Write-Host '（服务若还在跑，用 stop-erp.cmd 停）'
  exit 0
}

if (-not (Test-Path $ConfigPath)) { throw "找不到配置：$ConfigPath" }
$cfg = Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not (Test-Path $cfg.nodeExe)) { throw ('node 不存在：' + $cfg.nodeExe + ' —— 改 erp-server.config.json 的 nodeExe') }
if (-not (Test-Path (Join-Path $cfg.appDir $cfg.entry))) { throw ('入口不存在：' + $cfg.appDir + '\' + $cfg.entry) }

$ps1 = Join-Path $PSScriptRoot 'erp-server.ps1'
if (-not (Test-Path $ps1)) { throw ('缺少守护脚本：' + $ps1) }

if (-not (Test-Path $startupDir)) { New-Item -ItemType Directory -Path $startupDir -Force | Out-Null }
if (Test-Path $oldVbs) { Remove-Item -Path $oldVbs -Force; Write-Host '已清理旧的 VBS 自启项（该方式已被安全策略禁用）' }

# 用 CRLF + 纯 ASCII 写 cmd：cmd.exe 按系统代码页读文件，中文容易乱码
#
# 注意这里两个坑（都真踩过）：
#   1. PowerShell 里**逗号比 + 优先级高**，@('a','b','c', 'd' + $x) 会变成 4 个元素、
#      $x 单独成一项，-join 之后路径被 CRLF 拆到下一行 → 生成的 cmd 一跑就废。
#      所以拼接式必须用括号包起来。
#   2. cmd 里路径带空格要引号；这里路径本身没空格，仍加引号更稳。
$launchLine = 'powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ps1 + '"'
$lines = @(
  '@echo off',
  'rem Auto-start ERP local server at logon (current user, no admin needed).',
  'rem Supervisor keeps node alive; stop it with deploy\win\stop-erp.cmd',
  $launchLine
)
$content = ($lines -join "`r`n") + "`r`n"
[System.IO.File]::WriteAllText($cmdPath, $content, (New-Object System.Text.ASCIIEncoding))

# 写完回读自检：必须是一条完整命令行（含 .ps1 且不含换行），否则说明又踩了上面的坑
$back = [System.IO.File]::ReadAllText($cmdPath, [System.Text.Encoding]::ASCII)
if ($back -notmatch [regex]::Escape($ps1)) { throw ('自启项写入异常，路径不在同一行：' + $cmdPath) }
Write-Host ('已写入自启项：' + $cmdPath)
Write-Host ('  启动文件夹：' + $startupDir)

if (-not $SkipStart) {
  # 用 cmd /c start 拉起：脱离当前进程树，比 Start-Process 更容易活过调用方结束
  Write-Host '立即启动一次（隐藏窗口）…'
  $inner = 'start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ps1 + '"'
  Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c ' + $inner) -WindowStyle Hidden
  $ok = $false
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $cfg.port + '/api/health') -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
  }
  if ($ok) { Write-Host ('健康检查通过：http://127.0.0.1:' + $cfg.port) }
  else {
    Write-Host '健康检查未通过 —— 先看 backend\data\logs\erp-server-*.log 与 run-*.err.log'
    Write-Host '  若在受限环境（安全策略禁止脚本派生 powershell 子进程）里执行，上面的"立即启动"会被拦，'
    Write-Host '  但登录时由系统触发不受此限制；现在就要用请双击 deploy\win\start-erp.cmd。'
  }
}

Write-Host ''
Write-Host '完成。日常操作：'
Write-Host '  启动（可见日志）  deploy\win\start-erp.cmd'
Write-Host '  停止              deploy\win\stop-erp.cmd'
Write-Host '  取消自启          powershell -File deploy\win\install-autostart.ps1 -Uninstall'
