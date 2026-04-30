$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$logDir = Join-Path $scriptDir "logs"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

$time = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = Join-Path $logDir "charola-$time.log"

$nodePath = (Get-Command node -ErrorAction Stop).Source
& $nodePath ".\charola-auto.js" *>&1 | Tee-Object -FilePath $logFile -Encoding utf8
