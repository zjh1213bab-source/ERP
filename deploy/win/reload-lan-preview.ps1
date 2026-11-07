# Restart only this checkout's LAN backend; online backup precedes migration.
$ErrorActionPreference='Stop'
$resultPath=Join-Path $PSScriptRoot 'preview-reload.local.json'
try {
  $root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  $backend=Join-Path $root 'backend'
  $cfg=Get-Content (Join-Path $PSScriptRoot 'preview.local.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $task=Get-ScheduledTask -TaskName 'ERP-LAN-backend' -ErrorAction Stop
  if($task.Actions.Arguments -notlike ('*'+(Join-Path $PSScriptRoot 'preview-service.ps1')+'*')){throw 'Task belongs to another checkout.'}
  $connection=Get-NetTCPConnection -LocalPort 3100 -State Listen | Select-Object -First 1
  $nodeProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$connection.OwningProcess)
  if($nodeProcess.ExecutablePath -ne $cfg.nodeExe -or $nodeProcess.CommandLine -notmatch 'src/server.js'){throw 'Refusing to stop an unrelated process.'}
  $database=Join-Path $backend 'data/lan-preview.db'
  $backupDir=Join-Path $backend 'data/backups'
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $backupFile=Join-Path $backupDir ('before-confirmation-'+(Get-Date -Format yyyyMMdd-HHmmss)+'.db')
  @'
const {DatabaseSync,backup}=require('node:sqlite');
(async()=>{const db=new DatabaseSync(process.argv[2],{readOnly:true});await backup(db,process.argv[3]);db.close();})().catch(e=>{console.error(e.message);process.exitCode=1;});
'@ | & $cfg.nodeExe - $database $backupFile
  if($LASTEXITCODE -ne 0){throw 'Online backup failed; backend was not stopped.'}
  $previousPid=$connection.OwningProcess
  Stop-ScheduledTask -TaskName 'ERP-LAN-backend' -ErrorAction Stop
  Stop-Process -Id $previousPid -Force -ErrorAction Stop
  Start-ScheduledTask -TaskName 'ERP-LAN-backend' -ErrorAction Stop
  $health=$null
  for($i=0;$i -lt 45;$i++) {
    Start-Sleep -Seconds 1
    try{$h=Invoke-RestMethod 'http://127.0.0.1:3100/api/health' -TimeoutSec 2;if($h.ok -and $h.pid -ne $previousPid){$health=$h;break;}}catch{}
  }
  if(-not $health){throw 'New backend did not become healthy; inspect preview-backend logs.'}
  $newest=(Get-ChildItem (Join-Path $backend 'src') -Recurse -Filter '*.js' | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
  $loaded=[DateTime]::Parse($health.code_stamp.newest_at).ToUniversalTime()
  if([Math]::Abs(($newest-$loaded).TotalMilliseconds) -gt 2){throw 'Code stamp differs from disk; deployment not verified.'}
  @{ok=$true;health=$health;backup=$backupFile;timestamp=(Get-Date -Format o)} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultPath -Encoding UTF8
}catch{
  @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
  exit 1
}
