<#
  把 ERP 本机服务装成「开机自启的 Windows 计划任务」（需要管理员）
  ============================================================
  为什么用计划任务而不是 Windows 服务：
    · 服务（sc create / nssm）要求被启动的进程自己实现 SCM 握手（StartServiceCtrlDispatcher），
      node 不是服务程序，`sc create ... binPath=node.exe` 会直接 1053 超时失败；
      要用服务就得再引一个 nssm / WinSW 之类的包装器（本机没有，且要外网下载）。
    · 计划任务没有这个限制，还能设置「失败自动重启」「开机即启（SYSTEM，无需登录）」，
      正好覆盖需求，且是系统自带、可审计、可一键卸载。

  做的事：
    1. 校验权限（必须是管理员）与配置
    2. 注册计划任务 ErpServer：
         触发：系统启动（开机即启，不需要任何人登录）
         身份：SYSTEM（最高权限）
         动作：powershell -File deploy\win\erp-server.ps1（守护脚本，本身会拉起并守住 node）
         设置：失败每分钟重启、最多 99 次；不限运行时长；已在跑就不再起第二个
    3. 停掉当前手动起的实例 → 立刻启动任务 → 健康检查
    4. -Uninstall 卸载任务（不动数据）

  用法（在“以管理员身份运行”的窗口里）：
    powershell -NoProfile -ExecutionPolicy Bypass -File install-startup-task.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File install-startup-task.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  # 默认空，取目录放在下面用 $MyInvocation 解析。
  # 别在 param 默认值里写 $PSScriptRoot —— 用 `powershell -File` 调用时它是空字符串，
  # 会直接抛「Join-Path : 无法将参数绑定到参数“Path”，因为该参数为空字符串」。
  [string]$ConfigPath = '',
  [string]$TaskName = 'ErpServer',
  [switch]$Uninstall,
  [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'

# 脚本所在目录：-File 与 & 两种调用方式都可靠（$PSScriptRoot 不是都可靠）
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $scriptDir 'erp-server.config.json' }

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $pr = New-Object Security.Principal.WindowsPrincipal($id)
  return $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Host '需要管理员权限。' -ForegroundColor Yellow
  Write-Host '请用「以管理员身份运行」打开 PowerShell 或命令提示符，再执行同一条命令。'
  Write-Host '（在普通窗口里跑不会报错退出，但注册会被系统拒绝，所以这里直接拦下）'
  exit 3
}

if ($Uninstall) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host ('已卸载计划任务：' + $TaskName)
  } else {
    Write-Host ('计划任务不存在：' + $TaskName)
  }
  Write-Host '（服务若还在跑，用 deploy\win\stop-erp.cmd 停；启动文件夹里的自启项可用 install-autostart.ps1 -Uninstall 移除）'
  exit 0
}

if (-not (Test-Path $ConfigPath)) { throw "找不到配置：$ConfigPath" }
$cfg = Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not (Test-Path $cfg.nodeExe)) { throw ('node 不存在：' + $cfg.nodeExe) }
$ps1 = Join-Path $scriptDir 'erp-server.ps1'
if (-not (Test-Path $ps1)) { throw ('缺少守护脚本：' + $ps1) }

# ---- 任务定义 ----
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ps1 + '"')

$trigger = New-ScheduledTaskTrigger -AtStartup

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 99 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Description '跳色科技 ERP 本机服务（守护 node，开机自启）' -Force | Out-Null
Write-Host ('已注册计划任务：' + $TaskName + '（触发：系统启动；身份：SYSTEM）')

if (-not $SkipStart) {
  # 先停掉当前手动起的实例，否则任务里的守护会发现端口被占而退出
  $stopPs1 = Join-Path $scriptDir 'stop-erp.ps1'
  if (Test-Path $stopPs1) {
    Write-Host '停止当前实例…'
    & $stopPs1 -ConfigPath $ConfigPath | Out-Null
  }
  Write-Host '启动计划任务…'
  Start-ScheduledTask -TaskName $TaskName

  $ok = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $cfg.port + '/api/health') -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
  }
  if ($ok) {
    Write-Host ('健康检查通过：http://127.0.0.1:' + $cfg.port) -ForegroundColor Green
    $info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
    Write-Host ('任务状态：' + (Get-ScheduledTask -TaskName $TaskName).State + ' / 上次结果码：' + $info.LastTaskResult)
  } else {
    Write-Host '健康检查未通过 —— 看 backend\data\logs\erp-server-*.log 与 run-*.err.log' -ForegroundColor Yellow
    $info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
    Write-Host ('任务状态：' + (Get-ScheduledTask -TaskName $TaskName).State + ' / 上次结果码：' + $info.LastTaskResult)
  }
}

Write-Host ''
Write-Host '完成。之后的行为：'
Write-Host '  · 开机后不需要任何人登录，服务自动起来'
Write-Host '  · node 挂了由守护拉起；守护本身挂了由任务每分钟重试'
Write-Host '  · 手动停止：deploy\win\stop-erp.cmd（任务若配置了自动重启，会在下一分钟被拉起，属正常）'
Write-Host '  · 彻底卸载：本脚本加 -Uninstall'
Write-Host '  · 启动文件夹里的旧自启项建议移除，避免两处重复：install-autostart.ps1 -Uninstall'
