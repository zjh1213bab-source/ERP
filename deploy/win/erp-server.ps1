<#
  跳色科技 ERP —— 本机常驻服务守护（Windows / 无需管理员）
  ============================================================
  作用：让 backend（Express + SQLite）在本机长期挂着
    · 进程挂了自动拉起（3s 起，反复挂逐步退避到 60s，避免端口占用时刷爆日志）
    · 所有启停与异常写进日志，出问题先看日志，不用猜
    · 单实例保护：端口已有人在听就退出，绝不让两个 node 抢同一份 SQLite

  为什么不用 Windows 服务 / 计划任务：
    · 装服务要管理员权限；本机当前会话没有
    · 计划任务注册程序被安全策略禁用
  所以用「用户启动文件夹 + 本脚本」：登录后自动起，退出登录就停 —— 对一台
  一直开着、一直登录着的开发机来说，效果一样，而且随时能看见、能停。

  用法：
    前台可见（调试用）：  powershell -NoProfile -ExecutionPolicy Bypass -File erp-server.ps1
    后台隐藏（自启用）：  同一条命令，外面用 erp-server-hidden.vbs 调起来
    停止：                stop-erp.ps1（或双击 stop-erp.cmd）

  参数：
    -ConfigPath        默认同目录 erp-server.config.json
    -RestartDelaySec   首次重启等待（默认 3）
    -MaxDelaySec       退避上限（默认 60）
#>
[CmdletBinding()]
param(
  # 默认空 → 下面用 $MyInvocation 解析目录。
  # param 默认值里不能写 $PSScriptRoot：用 powershell -File 调用时它是空字符串，
  # 会直接抛「Join-Path : 无法将参数绑定到参数"Path"，因为该参数为空字符串」。
  [string]$ConfigPath = '',
  [int]$RestartDelaySec = 3,
  [int]$MaxDelaySec = 60
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $scriptDir 'erp-server.config.json' }

function Get-Cfg {
  if (-not (Test-Path $ConfigPath)) { throw "找不到配置文件：$ConfigPath" }
  return (Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json)
}

$cfg = Get-Cfg
$appDir = $cfg.appDir
$nodeExe = $cfg.nodeExe
$entry = $cfg.entry
$port = [int]$cfg.port
$logDir = Join-Path $appDir $cfg.logDir
$stopFile = Join-Path $appDir $cfg.stopFile
$mainLog = Join-Path $logDir ('erp-server-' + (Get-Date -Format 'yyyyMMdd') + '.log')

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
if (-not (Test-Path $nodeExe)) { throw "node 不存在：$nodeExe（改 erp-server.config.json 里的 nodeExe）" }
if (-not (Test-Path (Join-Path $appDir $entry))) { throw "入口不存在：$appDir\$entry" }

function Write-Log([string]$msg) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg
  Add-Content -Path $mainLog -Value $line -Encoding UTF8
  Write-Host $line
}

# 日志按天分文件；超过 10MB 改名保留一份上一版，避免长期挂机把盘写满
function Rotate-LogIfBig {
  if ((Test-Path $mainLog) -and ((Get-Item $mainLog).Length -gt 10MB)) {
    $prev = Join-Path $logDir 'erp-server-prev.log'
    Move-Item -Path $mainLog -Destination $prev -Force
  }
}

function Test-PortListening([int]$p) {
  try {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($c) { return $true }
    return $false
  } catch {
    # 老系统没有 Get-NetTCPConnection 时退回 TcpClient 探测
    try {
      $t = New-Object System.Net.Sockets.TcpClient
      $t.Connect('127.0.0.1', $p)
      $t.Close()
      return $true
    } catch { return $false }
  }
}

# 清理 3 天前的单次运行日志（run-*.log），只留最近几份够排查就行
function Clear-OldRunLogs {
  try {
    Get-ChildItem -Path $logDir -Filter 'run-*.log' -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-3) } |
      Remove-Item -Force -ErrorAction SilentlyContinue
  } catch { }
}

<#
  修掉「同名不同大小写的代理环境变量」

  Windows 的进程环境块允许同时存在 HTTP_PROXY 与 http_proxy（大小写不同视为两个条目），
  但 PowerShell 的 Start-Process 会把环境装进一个大小写不敏感的字典 —— 一遇到这种重复
  就直接抛「已添加项。字典中的关键字:“HTTP_PROXY”所添加的关键字:“http_proxy”」，
  表现是「node 完全没有被启动、日志文件是空的」。
  这类环境在装了代理/沙箱工具的开发机上很常见，所以启动前统一归一成大写一份。
#>
function Repair-ProxyEnvDuplicate {
  $names = @('http_proxy', 'https_proxy', 'no_proxy', 'all_proxy')
  $saved = @{}
  foreach ($n in $names) {
    $u = $n.ToUpper()
    $v = [Environment]::GetEnvironmentVariable($u, 'Process')
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($n, 'Process') }
    if ($v) { $saved[$u] = $v }
  }
  if ($saved.Count -eq 0) { return }
  foreach ($k in @($saved.Keys)) {
    [Environment]::SetEnvironmentVariable($k, $null, 'Process')
    [Environment]::SetEnvironmentVariable($k.ToLower(), $null, 'Process')
  }
  foreach ($k in @($saved.Keys)) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
}

# 启动时如果还留着上次的停止标记，先清掉（否则一启动就退出，人会以为坏了）
if (Test-Path $stopFile) {
  Remove-Item -Path $stopFile -Force -ErrorAction SilentlyContinue
}

Rotate-LogIfBig
Clear-OldRunLogs
Repair-ProxyEnvDuplicate
Write-Log ('=== 守护启动  pid=' + $PID + '  node=' + $nodeExe + '  app=' + $appDir + ' ===')

$consecutiveFail = 0
$lastStartTime = Get-Date
$nodeProc = $null

try {
  while ($true) {
    if (Test-Path $stopFile) {
      Write-Log '收到停止标记，守护退出'
      break
    }

    # 单实例保护：端口已在监听说明有别的实例在跑（可能是手动起的），不要抢
    if (Test-PortListening $port) {
      Write-Log ('端口 ' + $port + ' 已在监听，本守护退出（避免两个实例抢同一份 SQLite）')
      break
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $runOut = Join-Path $logDir ('run-' + $stamp + '.out.log')
    $runErr = Join-Path $logDir ('run-' + $stamp + '.err.log')

    $lastStartTime = Get-Date
    Write-Log ('启动 node（第 ' + ($consecutiveFail + 1) + ' 次尝试）输出：' + (Split-Path $runOut -Leaf))
    $nodeProc = Start-Process -FilePath $nodeExe `
      -ArgumentList $entry `
      -WorkingDirectory $appDir `
      -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput $runOut `
      -RedirectStandardError $runErr

    Write-Log ('node 已启动 pid=' + $nodeProc.Id)

    # 主循环：等 node 退出；期间每秒检查一次停止标记，保证停得掉
    while (-not $nodeProc.HasExited) {
      Start-Sleep -Seconds 1
      if (Test-Path $stopFile) {
        Write-Log '收到停止标记，结束 node'
        try { Stop-Process -Id $nodeProc.Id -Force -ErrorAction SilentlyContinue } catch { }
        break
      }
      Rotate-LogIfBig
    }

    if (Test-Path $stopFile) { Write-Log '守护退出（已按停止标记收尾）'; break }

    $code = 'n/a'
    try { if ($null -ne $nodeProc.ExitCode) { $code = $nodeProc.ExitCode } } catch { }
    # 被 Stop-Process 强杀时 ExitCode 可能为空，别在日志里留一个「exitCode= 」的空洞
    $uptimeSec = [int]((Get-Date) - $lastStartTime).TotalSeconds
    Write-Log ('node 已退出 exitCode=' + $code + ' 运行 ' + $uptimeSec + ' 秒')

    # 退避：跑够 60 秒算“稳定过”，重置计数；否则指数退避，防止端口被占/启动即崩时刷爆日志
    if ($uptimeSec -ge 60) {
      $consecutiveFail = 0
      $delay = $RestartDelaySec
    } else {
      $consecutiveFail = $consecutiveFail + 1
      $delay = $RestartDelaySec * [Math]::Pow(2, [Math]::Min($consecutiveFail - 1, 5))
      if ($delay -gt $MaxDelaySec) { $delay = $MaxDelaySec }
    }
    $delay = [int]$delay
    Write-Log ('等待 ' + $delay + ' 秒后重启')
    Start-Sleep -Seconds $delay
  }
} finally {
  if ($nodeProc -and -not $nodeProc.HasExited) {
    try { Stop-Process -Id $nodeProc.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
  Write-Log '=== 守护结束 ==='
}
