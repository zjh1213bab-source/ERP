<#
  ERP 本机服务 —— 真正的重启（需要管理员）
  ============================================================
  为什么需要单独的脚本：

    node 是守护用 Start-Process 起的独立进程，Windows 不会因为父进程退出就把它带走。
    所以「停计划任务」只会杀掉守护 powershell，node 继续活着占端口；
    紧接着「启动计划任务」，新守护发现端口被占（单实例保护）→ 立刻退出。
    净效果：**什么都没换，跑的还是旧代码**，而 /api/health 依旧 200，看着一切正常。

  本脚本就是补这个洞，顺序固定：
    1. 停计划任务（停掉守护）
    2. 杀掉占用端口的那个 node —— 杀之前先问 /api/health 确认是本项目服务，不误伤别的程序
    3. 等端口真的释放
    4. 启动计划任务（守护起来 → 拉起 node）
    5. 等健康检查通过，并把这个进程的 pid / 启动时间 / 代码时间戳打出来
    6. 跟磁盘上源码的最新修改时间比对 → 明确告诉你「跑的是最新代码」还是「还是旧的」

  用法（管理员窗口，cmd 或 PowerShell 都行）：
    powershell -NoProfile -ExecutionPolicy Bypass -File "D:\...\deploy\win\restart-erp.ps1"

  参数：
    -TaskName     计划任务名（默认 ErpServer）
    -TimeoutSec   等健康检查的上限秒数（默认 45）
#>
[CmdletBinding()]
param(
  # 默认值留空：-File 调用时 param 里的 $PSScriptRoot 是空字符串
  [string]$ConfigPath = '',
  [string]$TaskName = 'ErpServer',
  [int]$TimeoutSec = 45
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $scriptDir 'erp-server.config.json' }

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $pr = New-Object Security.Principal.WindowsPrincipal($id)
  return $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Host '需要管理员权限（node 归 SYSTEM，普通权限杀不掉）。' -ForegroundColor Yellow
  Write-Host '请用「以管理员身份运行」的窗口再执行同一条命令。'
  Write-Host ''
  Write-Host '如果只是想换代码、不想提权：守护在跑的时候用 reload-erp.cmd（普通权限即可）。'
  exit 3
}

if (-not (Test-Path $ConfigPath)) { throw "找不到配置：$ConfigPath" }
$cfg = Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$appDir = $cfg.appDir
$port = [int]$cfg.port
$healthUrl = 'http://127.0.0.1:' + $port + '/api/health'

function Get-Health {
  try {
    $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -ne 200) { return $null }
    return ($r.Content | ConvertFrom-Json)
  } catch { return $null }
}

# 占用端口的进程里，哪个是本项目的 node（用 /api/health 认身份，不靠命令行猜）
function Get-ProjectNodePid {
  try {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return 0 }
    $owner = [int]$conn.OwningProcess
    $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $owner) -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.Name -ne 'node.exe') { return 0 }
    $h = Get-Health
    if (-not $h -or $h.service -ne 'erp-system') { return 0 }
    return $owner
  } catch { return 0 }
}

Write-Host ('===== 重启前 =====')
$before = Get-Health
$beforePid = Get-ProjectNodePid
if ($before) {
  Write-Host ('  health ok，pid=' + $before.pid + '  uptime=' + [int]$before.uptime + 's  code_stamp=' + $(if ($before.code_stamp) { $before.code_stamp.newest_at } else { '(旧代码，无此字段)' }))
} else { Write-Host '  health 不通（服务当前没起或正在起）' }
if ($beforePid) { Write-Host ('  端口 ' + $port + ' 的 node pid=' + $beforePid) }

Write-Host ''
Write-Host '1) 停止计划任务…'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host ('   任务状态：' + (Get-ScheduledTask -TaskName $TaskName).State)
} else {
  Write-Host ('   任务不存在：' + $TaskName + '（只做杀进程 + 手动拉起）')
}

Write-Host '2) 结束占用端口的 node（先确认身份，不误伤别的程序）…'
$target = Get-ProjectNodePid
if ($target -gt 0) {
  Write-Host ('   结束 pid=' + $target)
  Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
} else {
  if ($beforePid -gt 0) { Write-Host ('   结束 pid=' + $beforePid) ; Stop-Process -Id $beforePid -Force -ErrorAction SilentlyContinue }
  else { Write-Host '   端口上没有本项目的 node（无需结束）' }
}

Write-Host '3) 等端口释放…'
$freed = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { $freed = $true; break }
}
if ($freed) { Write-Host ('   端口 ' + $port + ' 已释放') }
else {
  Write-Host ('   端口仍被占用 —— 不是本项目 node 的话请手动处理：netstat -ano | findstr :' + $port) -ForegroundColor Red
  exit 4
}

Write-Host '4) 启动计划任务…'
Start-ScheduledTask -TaskName $TaskName

Write-Host ('5) 等健康检查（最多 ' + $TimeoutSec + ' 秒）…')
$ok = $false
for ($i = 0; $i -lt $TimeoutSec; $i++) {
  Start-Sleep -Seconds 1
  if (Get-Health) { $ok = $true; break }
}

Write-Host ''
if (-not $ok) {
  Write-Host '健康检查未通过。' -ForegroundColor Red
  Write-Host ('  日志：' + (Join-Path $appDir 'data\logs'))
  Write-Host '  先看 erp-server-<日期>.log（守护事件），再看最新 run-*.err.log（node 自己的报错）'
  exit 5
}

$after = Get-Health
$newPid = Get-ProjectNodePid
$info = $null
try { $info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo } catch { }

Write-Host '===== 重启后 =====' -ForegroundColor Green
Write-Host ('  health=200   pid=' + $after.pid + '   uptime=' + [int]$after.uptime + 's')
if ($after.started_at) { Write-Host ('  启动时间(UTC)：' + $after.started_at) }
if ($newPid) { Write-Host ('  监听端口 ' + $port + ' 的 node pid=' + $newPid) }
if ($task -and $info) { Write-Host ('  任务状态：' + (Get-ScheduledTask -TaskName $TaskName).State + ' / 上次结果码：' + $info.LastTaskResult) }

# ---- 关键一步：这份进程到底加载的是哪份代码 ----
Write-Host ''
$newest = $null
try {
  $newest = Get-ChildItem -Path (Join-Path $appDir 'src') -Recurse -Filter *.js -ErrorAction Stop |
    Sort-Object LastWriteTime | Select-Object -Last 1
} catch { }

if (-not $after.code_stamp) {
  Write-Host '✗ 跑的还是旧代码：这个进程没有 code_stamp 字段（说明它启动在本次改动之前）。' -ForegroundColor Yellow
  Write-Host '  再执行一次本脚本；如果反复如此，看下面的任务结果码与日志。'
} elseif ($newest) {
  $diskUtc = $newest.LastWriteTime.ToUniversalTime()
  $runUtc = ([datetime]::Parse($after.code_stamp.newest_at)).ToUniversalTime()
  $diff = [int]($diskUtc - $runUtc).TotalSeconds
  Write-Host ('  磁盘上最新的源码：' + $newest.Name + '  ' + $newest.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
  Write-Host ('  进程加载的源码时间：' + $runUtc.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss') + '（共 ' + $after.code_stamp.files + ' 个文件）')
  if ([Math]::Abs($diff) -le 2) {
    Write-Host '✓ 已加载最新代码（磁盘与进程的源码时间一致）' -ForegroundColor Green
  } elseif ($diff -gt 0) {
    Write-Host ('✗ 仍是旧代码：磁盘上的代码比进程新 ' + $diff + ' 秒。重启没有真正生效，检查下面两项：') -ForegroundColor Yellow
    Write-Host '    · 任务是否真的重启了（状态 Running / 结果码 0）'
    Write-Host '    · 是否有别的 node 占着端口（netstat -ano | findstr :' + $port + '）'
  } else {
    Write-Host '（进程的源码时间比磁盘新，通常是有文件被回滚/时间戳被改，属正常）'
  }
}

Write-Host ''
Write-Host '以后要换代码（不涉及本次这类守护脚本本身的改动）：
  普通权限执行 reload-erp.cmd 即可，不用管理员、不用停任务。'
