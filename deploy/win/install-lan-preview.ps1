# Run elevated once to install unattended boot startup and LAN-only access.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$resultPath = Join-Path $PSScriptRoot 'preview-install.local.json'
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator rights required.' }
    $scriptPath = Join-Path $PSScriptRoot 'preview-service.ps1'
    foreach ($service in @('backend','frontend')) {
        $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
            -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $scriptPath + '" -Service ' + $service)
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
        $account = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        Register-ScheduledTask -TaskName ('ERP-LAN-' + $service) -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) `
            -Settings $settings -Principal $account -Description 'ERP LAN preview: unattended boot startup and process recovery' -Force | Out-Null
    }
    # Current NIC is Public. Limit incoming access to the local subnet on every profile.
    $ruleName = 'ERP-LAN-Preview-5173-LocalSubnet'
    $rule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
    if ($rule) { Remove-NetFirewallRule -Name $ruleName }
    New-NetFirewallRule -Name $ruleName -DisplayName 'ERP LAN Preview 5173 (LocalSubnet)' -Direction Inbound `
        -Action Allow -Protocol TCP -LocalPort 5173 -RemoteAddress LocalSubnet -Profile Any | Out-Null
    foreach ($service in @('backend','frontend')) { Start-ScheduledTask -TaskName ('ERP-LAN-' + $service) }
    @{ ok = $true; timestamp = (Get-Date -Format o) } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
} catch {
    @{ ok = $false; error = $_.Exception.Message; timestamp = (Get-Date -Format o) } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit 1
}
