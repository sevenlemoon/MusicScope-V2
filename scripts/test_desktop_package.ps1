# Exercise the extracted release, not the builder's source or virtualenvs.
param([switch]$Separate)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This isolated package acceptance is CI-only.' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content (Join-Path $root 'apps\desktop\package.json') -Raw | ConvertFrom-Json).version
$zip = Join-Path $root "dist\MusicScope-$version-windows-x64.zip"
$testRoot = Join-Path $env:RUNNER_TEMP ('MusicScope relocation ' + [guid]::NewGuid().ToString('N'))
$unicodeDirectory = ([string][char]0x7528) + ([string][char]0x6237) + ' with spaces'
$package = Join-Path $testRoot $unicodeDirectory
Expand-Archive -LiteralPath $zip -DestinationPath $package
$profile = Join-Path $testRoot 'isolated profile'
$env:MUSICSCOPE_SMOKE_DATA_DIR = $profile
$logs = Join-Path $profile 'workspace\.logs'
$proof = Join-Path $logs 'desktop-smoke-passed'
$environment = Join-Path $profile 'workspace\.env'
$database = Join-Path $profile 'workspace\storage\library.sqlite3'
$originalPath = $env:PATH
try {
    # No setup-python/setup-node/uv/npm/Git in PATH during the acceptance launch.
    $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        if (Test-Path $proof) { Remove-Item -LiteralPath $proof }
        $process = Start-Process (Join-Path $package 'MusicScope.exe') -ArgumentList '--smoke-test' -PassThru
        if (-not $process.WaitForExit(180000)) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F
            throw 'Packaged desktop startup exceeded three minutes'
        }
        if ($process.ExitCode -ne 0 -or -not (Test-Path $proof)) { throw 'Packaged Studio/API smoke test failed' }
        $keyHash = (Get-FileHash $environment).Hash
        $dbCreated = (Get-Item $database).CreationTimeUtc.Ticks
        if ($attempt -eq 1) { $firstKey = $keyHash; $firstDatabase = $dbCreated }
        elseif ($keyHash -ne $firstKey -or $dbCreated -ne $firstDatabase) { throw 'Restart replaced user data' }
    }
    if ($Separate) {
        $project = Join-Path $package 'resources\project'
        $workspace = Join-Path $profile 'workspace'
        $stopFile = Join-Path $logs 'desktop-stop'
        if (Test-Path $stopFile) { Remove-Item -LiteralPath $stopFile }
        $savedDevice = $env:AUDIO_WORKER_DEVICE
        $savedModelCache = $env:MUSICSCOPE_MODEL_CACHE
        $env:AUDIO_WORKER_DEVICE = 'cpu'
        $env:MUSICSCOPE_MODEL_CACHE = Join-Path $testRoot 'isolated-model-cache'
        $supervisor = $null
        try {
            $supervisor = Start-Process (Join-Path $project 'runtime\node\node.exe') -ArgumentList @(
                "`"$(Join-Path $package 'resources\app\runtime.cjs')`"", "`"$project`"", "`"$workspace`""
            ) -PassThru -RedirectStandardOutput (Join-Path $logs 'acceptance-supervisor.log') `
                -RedirectStandardError (Join-Path $logs 'acceptance-supervisor-error.log')
            & (Join-Path $project 'runtime\python-api\python.exe') `
                (Join-Path $PSScriptRoot 'desktop_audio_acceptance.py') --isolated-test-instance `
                --api-url 'http://127.0.0.1:8100' --output (Join-Path $testRoot 'synthetic-audio') `
                --ffmpeg (Join-Path $project 'runtime\ffmpeg\bin\ffmpeg.exe')
            if ($LASTEXITCODE -ne 0) { throw 'Real CPU six-stem acceptance failed' }
            Copy-Item (Join-Path $testRoot 'synthetic-audio\audio-acceptance.json') $logs
        } finally {
            $env:AUDIO_WORKER_DEVICE = $savedDevice
            $env:MUSICSCOPE_MODEL_CACHE = $savedModelCache
            Set-Content -Path $stopFile -Value 'stop'
            if ($supervisor -and -not $supervisor.WaitForExit(10000)) {
                & "$env:SystemRoot\System32\taskkill.exe" /PID $supervisor.Id /T /F
            }
        }
    }
} finally {
    $env:PATH = $originalPath
    Remove-Item Env:MUSICSCOPE_SMOKE_DATA_DIR -ErrorAction SilentlyContinue
    $diagnostics = Join-Path $root 'dist\desktop-acceptance'
    New-Item -ItemType Directory -Force -Path $diagnostics | Out-Null
    if (Test-Path $logs) {
        Get-ChildItem $logs -File | Where-Object { $_.Extension -in @('.log', '.png') -or $_.Name -eq 'audio-acceptance.json' } |
            Copy-Item -Destination $diagnostics
    }
}
