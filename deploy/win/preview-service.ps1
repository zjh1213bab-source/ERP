# LAN development service. No database or credentials are copied here.
[CmdletBinding()]
param([ValidateSet('backend','frontend')][string]$Service = 'backend')
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$config = Get-Content (Join-Path $PSScriptRoot 'preview.local.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$nodeExe = $config.nodeExe
$appDir = Join-Path $projectDir $Service
$port = if ($Service -eq 'backend') { 3100 } else { 5173 }
$logDir = Join-Path $projectDir 'backend/data/logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$mutex = New-Object System.Threading.Mutex($false, ('Local\ERP-LAN-' + $Service))
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); exit 0 }
$child = $null
try {
    if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'Configured Node executable is missing.' }
    # Ports are fixed: never silently start a second instance on a different port.
    if ($Service -eq 'backend') {
        $env:PORT = '3100'
        $env:DB_PATH = './data/lan-preview.db'
        $env:ERP_SCHEDULER = '0'
        $env:CUSTOMER_CYCLE_SCHEDULER = '1'
        if (-not (Test-Path -LiteralPath (Join-Path $appDir 'data/lan-preview.db'))) {
            throw 'Preview database is missing; refusing to create an empty replacement.'
        }
        $nodeArgs = @('src/server.js')
    } else {
        $env:VITE_API_PROXY_TARGET = 'http://127.0.0.1:3100'
        $nodeArgs = @('node_modules/vite/bin/vite.js','--host','0.0.0.0','--port','5173','--strictPort')
    }
    $failures = 0
    while ($true) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener) {
            # Do not terminate/adopt unrelated processes occupying this port.
            Add-Content (Join-Path $logDir ('preview-' + $Service + '.log')) ((Get-Date -Format o) + ' Port occupied; retrying in 15 seconds.')
            Start-Sleep -Seconds 15
            continue
        }
        # Rotate per-process output to keep repeated restarts from growing logs indefinitely.
        foreach ($stream in @('out','err')) {
            $outputFile = Join-Path $logDir ('preview-' + $Service + '.' + $stream + '.log')
            if (Test-Path -LiteralPath $outputFile) { Move-Item -LiteralPath $outputFile -Destination ($outputFile + '.previous') -Force }
        }
        $started = Get-Date
        $child = Start-Process -FilePath $nodeExe -ArgumentList $nodeArgs -WorkingDirectory $appDir -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logDir ('preview-' + $Service + '.out.log')) `
            -RedirectStandardError (Join-Path $logDir ('preview-' + $Service + '.err.log'))
        Add-Content (Join-Path $logDir ('preview-' + $Service + '.log')) ((Get-Date -Format o) + ' Started PID=' + $child.Id)
        $child.WaitForExit()
        $failures = if (((Get-Date) - $started).TotalSeconds -ge 60) { 0 } else { [Math]::Min($failures + 1, 5) }
        $delay = [Math]::Min(60, 3 * [Math]::Pow(2, $failures))
        Add-Content (Join-Path $logDir ('preview-' + $Service + '.log')) ((Get-Date -Format o) + ' Exited; restart in ' + $delay + 's')
        Start-Sleep -Seconds $delay
    }
} finally {
    if ($child -and -not $child.HasExited) { $child.Kill() }
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
