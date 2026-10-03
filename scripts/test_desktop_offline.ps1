# Run only on the disposable Windows CI runner; rules are scoped to this extracted package.
param([Parameter(Mandatory=$true)][string]$Package,
      [Parameter(Mandatory=$true)][string]$TestRoot,
      [Parameter(Mandatory=$true)][string]$ModelCache,
      [Parameter(Mandatory=$true)][string]$OnlineProfile,
      [Parameter(Mandatory=$true)][string]$OnlineReport)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Firewall acceptance is CI-only.' }
$project = Join-Path $Package 'resources\project'
$python = Join-Path $project 'runtime\python-api\python.exe'
$workerPython = Join-Path $project 'runtime\python-audio-worker\python.exe'
$node = Join-Path $project 'runtime\node\node.exe'
$rules = @()
$savedCache = $env:MUSICSCOPE_MODEL_CACHE
$savedProfile = $env:MUSICSCOPE_SMOKE_DATA_DIR
$savedJob = $env:MUSICSCOPE_SMOKE_JOB_ID
$savedDevice = $env:AUDIO_WORKER_DEVICE
$env:MUSICSCOPE_MODEL_CACHE = $ModelCache
$env:AUDIO_WORKER_DEVICE = 'cpu'
$offline = Join-Path $TestRoot 'offline profile'
$workspace = Join-Path $offline 'workspace'
$logs = Join-Path $workspace '.logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$supervisor = $null
$firewallProfiles = Get-NetFirewallProfile | Select-Object Name, Enabled
try {
    # First prove the external control endpoint is reachable from this executable.
    & $python (Join-Path $PSScriptRoot 'probe_offline.py')
    if ($LASTEXITCODE -ne 0) { throw 'Cannot establish online network control for offline acceptance' }
    Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True
    foreach ($program in @($python, $workerPython, $node, (Join-Path $Package 'MusicScope.exe'),
                          (Join-Path $project 'runtime\ffmpeg\bin\ffmpeg.exe'),
                          (Join-Path $project 'runtime\ffmpeg\bin\ffprobe.exe'))) {
        $name = 'MusicScope acceptance ' + [guid]::NewGuid().ToString('N')
        New-NetFirewallRule -DisplayName $name -Direction Outbound -Action Block -Program $program `
            -Profile Any -RemoteAddress @('0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255',
                '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff') | Out-Null
        $rules += $name
    }
    & $python (Join-Path $PSScriptRoot 'probe_offline.py') --expect-blocked
    if ($LASTEXITCODE -ne 0) { throw 'Offline firewall control failed: outbound connection still works' }
    # Reopen the existing results through Electron and exercise the real player.
    $env:MUSICSCOPE_SMOKE_DATA_DIR = $OnlineProfile
    $env:MUSICSCOPE_SMOKE_JOB_ID = (Get-Content $OnlineReport -Raw | ConvertFrom-Json).job_id
    $playback = Join-Path $OnlineProfile 'workspace\.logs\playback-acceptance.json'
    if (Test-Path $playback) { Remove-Item -LiteralPath $playback }
    $app = Start-Process (Join-Path $Package 'MusicScope.exe') -ArgumentList '--smoke-test' -PassThru
    if (-not $app.WaitForExit(180000)) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $app.Id /T /F
        throw 'Offline desktop playback timed out'
    }
    if ($app.ExitCode -ne 0 -or -not (Test-Path $playback)) { throw 'Offline desktop playback failed' }
    # An empty second profile proves actual new inference, not reuse of a completed job.
    $supervisor = Start-Process $node -ArgumentList @(
        "`"$(Join-Path $Package 'resources\app\runtime.cjs')`"", "`"$project`"", "`"$workspace`""
    ) -PassThru -RedirectStandardOutput (Join-Path $logs 'offline-supervisor.log') `
        -RedirectStandardError (Join-Path $logs 'offline-supervisor-error.log')
    & $python (Join-Path $PSScriptRoot 'desktop_audio_acceptance.py') --isolated-test-instance `
        --api-url 'http://127.0.0.1:8100' --output (Join-Path $TestRoot 'offline-audio') `
        --ffmpeg (Join-Path $project 'runtime\ffmpeg\bin\ffmpeg.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Offline six-stem inference failed' }
    $report = Get-Content (Join-Path $TestRoot 'offline-audio\audio-acceptance.json') -Raw | ConvertFrom-Json
    $report | Add-Member -NotePropertyName outbound_network_blocked -NotePropertyValue $true
    $report | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $OnlineProfile 'workspace\.logs\offline-acceptance.json')
} finally {
    Set-Content (Join-Path $logs 'desktop-stop') 'stop'
    if ($supervisor -and -not $supervisor.WaitForExit(10000)) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $supervisor.Id /T /F
    }
    foreach ($name in $rules) { Remove-NetFirewallRule -DisplayName $name }
    foreach ($item in $firewallProfiles) { Set-NetFirewallProfile -Profile $item.Name -Enabled $item.Enabled }
    $env:MUSICSCOPE_MODEL_CACHE = $savedCache
    $env:MUSICSCOPE_SMOKE_DATA_DIR = $savedProfile
    $env:MUSICSCOPE_SMOKE_JOB_ID = $savedJob
    $env:AUDIO_WORKER_DEVICE = $savedDevice
    Copy-Item (Join-Path $logs '*.log') (Join-Path $OnlineProfile 'workspace\.logs') -ErrorAction SilentlyContinue
}
