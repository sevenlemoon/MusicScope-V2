# Integration test against the actual launcher, PostgreSQL, API, worker and web.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcher = Join-Path $PSScriptRoot 'dev.ps1'
& $launcher -Setup
if ($LASTEXITCODE -ne 0) { throw 'Native setup failed' }
# Repeated setup must preserve the same cluster and complete migrations safely.
$data = Join-Path $root 'storage\postgres\data'
$version = Get-Content (Join-Path $data 'PG_VERSION') -Raw
& $launcher -Setup
if ($LASTEXITCODE -ne 0) { throw 'Repeated native setup failed' }
if ((Get-Content (Join-Path $data 'PG_VERSION') -Raw) -ne $version) { throw 'Cluster changed' }
$process = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$launcher`"", '-NoOpen') -PassThru `
    -RedirectStandardOutput (Join-Path $root '.logs\startup-test.out.log') `
    -RedirectStandardError (Join-Path $root '.logs\startup-test.err.log')
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 180; $attempt++) {
        $process.Refresh()
        if ($process.HasExited) { throw 'Launcher exited before readiness' }
        try {
            $api = Invoke-WebRequest 'http://127.0.0.1:8100/health' -UseBasicParsing -TimeoutSec 2
            $web = Invoke-WebRequest 'http://127.0.0.1:3100/studio' -UseBasicParsing -TimeoutSec 5
            $sidecar = Invoke-WebRequest 'http://127.0.0.1:36531/health' -UseBasicParsing -TimeoutSec 2
            $health = Get-Content (Join-Path $root '.logs\audio-worker-health-windows.json') -Raw | ConvertFrom-Json
            if ($api.StatusCode -eq 200 -and $web.StatusCode -eq 200 -and
                $sidecar.StatusCode -eq 200 -and $health.state -ne 'stopped') {
                $ready = $true
                break
            }
        } catch { }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) { throw 'Full native application did not become ready' }
    Write-Host 'PASS: Windows setup, repeated setup, API, worker, NetEase and Studio without Docker.'
} finally {
    & taskkill /PID $process.Id /T /F *> $null
}
