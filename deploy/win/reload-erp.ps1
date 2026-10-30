<#
  ERP 本机服务 —— 重载代码（普通权限即可，不需要管理员）
  ============================================================
  原理：不直接杀进程（node 归 SYSTEM，普通权限杀不掉），而是在约定的路径上
  放一个「重载标记」文件，由守护（SYSTEM）看到后结束 node 并立刻重新拉起。
  这样换代码只走「写一个文件」这一步，权限问题绕开了。

  前提：守护必须在跑（计划任务里的守护进程）。守护没跑时标记不会有人处理，
  本脚本会在超时后删掉标记并提示用 restart-erp.ps1（需管理员）。

  用法：
    reload-erp.cmd            （双击，或命令行执行）
    powershell -NoProfile -ExecutionPolicy Bypass -File reload-erp.ps1

  判断成功与否不看"脚本有没有报错"，而是看 /api/health 里的 pid 有没有换、
  uptime 有没有归零 —— 这才是"真的重启了"。
#>
[CmdletBinding()]
param(
  [string]$ConfigPath = '',
  [int]$TimeoutSec = 40
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $scriptDir 'erp-server.config.json' }
if (-not (Test-Path $ConfigPath)) { Write-Host "找不到配置：$ConfigPath"; exit 1 }

$cfg = Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$appDir = $cfg.appDir
$port = [int]$cfg.port
$healthUrl = 'http://127.0.0.1:' + $port + '/api/health'
$reloadFile = if ($cfg.reloadFile) { Join-Path $appDir $cfg.reloadFile } else { Join-Path $appDir 'data\logs\erp-server.reload' }

function Get-Health {
  try {
    $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -ne 200) { return $null }
    return ($r.Content | ConvertFrom-Json)
  } catch { return $null }
}

$before = Get-Health
if (-not $before) {
  Write-Host ('服务当前不通（' + $healthUrl + '），没有可重载的进程。' ) -ForegroundColor Yellow
  Write-Host '  守护可能没在跑 —— 用管理员窗口执行 restart-erp.ps1。'
  exit 2
}

$beforePid = $before.pid
$beforeUptime = [int]$before.uptime
Write-Host ('当前进程：pid=' + $beforePid + '  uptime=' + $beforeUptime + 's')

$dir = Split-Path -Parent $reloadFile
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
Set-Content -Path $reloadFile -Value ('reload requested at ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8
Write-Host '已提交重载标记，等待守护重启 node…'

$ok = $false
$after = $null
for ($i = 0; $i -lt $TimeoutSec; $i++) {
  Start-Sleep -Seconds 1
  $h = Get-Health
  if (-not $h) { continue }
  $pidChanged = ($null -ne $h.pid) -and ($null -ne $beforePid) -and ($h.pid -ne $beforePid)
  $uptimeReset = ([int]$h.uptime) -lt [Math]::Max(20, $beforeUptime)
  if ($pidChanged -or $uptimeReset) { $ok = $true; $after = $h; break }
}

if (-not $ok) {
  Write-Host ('等了 ' + $TimeoutSec + ' 秒，进程没有变化。' ) -ForegroundColor Red
  Remove-Item -Path $reloadFile -Force -ErrorAction SilentlyContinue
  Write-Host '  可能原因：守护没在跑（标记没人处理），或守护是旧版本（还不认这个标记）。'
  Write-Host '  处理办法：用管理员窗口执行 restart-erp.ps1（会一并把守护升到新版）。'
  exit 3
}

Write-Host ''
Write-Host '===== 重载完成 =====' -ForegroundColor Green
Write-Host ('  pid=' + $after.pid + '  uptime=' + [int]$after.uptime + 's')
if ($after.started_at) { Write-Host ('  启动时间(UTC)：' + $after.started_at) }
if ($after.code_stamp) {
  Write-Host ('  进程加载的源码时间：' + ([datetime]::Parse($after.code_stamp.newest_at)).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss') + '（' + $after.code_stamp.files + ' 个文件）')
}

# 与磁盘对比，直接回答「新代码生效了吗」
$newest = $null
try {
  $newest = Get-ChildItem -Path (Join-Path $appDir 'src') -Recurse -Filter *.js -ErrorAction Stop |
    Sort-Object LastWriteTime | Select-Object -Last 1
} catch { }
if ($after.code_stamp -and $newest) {
  $diff = [int]($newest.LastWriteTime.ToUniversalTime() - ([datetime]::Parse($after.code_stamp.newest_at)).ToUniversalTime()).TotalSeconds
  if ([Math]::Abs($diff) -le 2) { Write-Host '✓ 已加载最新代码' -ForegroundColor Green }
  else { Write-Host ('✗ 仍是旧代码（磁盘比进程新 ' + $diff + ' 秒），用 restart-erp.ps1 重启') -ForegroundColor Yellow }
}
