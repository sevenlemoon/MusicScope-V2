param(
    [switch]$Setup,
    [switch]$Status,
    [switch]$NoOpen,
    [switch]$LegacyDocker,
    [string]$StopFile
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logs = Join-Path $root '.logs'
$setupLog = Join-Path $logs 'setup-windows.log'
$workerHealth = Join-Path $logs 'audio-worker-health-windows.json'
$apiPython = Join-Path $root 'apps\api\.venv\Scripts\python.exe'
$workerPython = Join-Path $root 'apps\audio-worker\.venv\Scripts\python.exe'
$started = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
. (Join-Path $PSScriptRoot 'windows-tools.ps1')
. (Join-Path $PSScriptRoot 'windows-postgres.ps1')

function Say([string]$message) { Write-Host "[MusicScope] $message" }
function Fail([string]$message) { throw $message }
function Require-Command([string]$name, [string]$instruction) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { Fail "$name is required. $instruction" }
}
function Env-Values {
    $values = @{}
    $path = Join-Path $root '.env'
    if (Test-Path $path) {
        foreach ($line in [IO.File]::ReadAllLines($path)) {
            if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $values[$matches[1]] = $matches[2] }
        }
    }
    return $values
}
function Env-Value($values, [string]$key, [string]$fallback) {
    if ($values.ContainsKey($key) -and $values[$key]) { return $values[$key] }
    return $fallback
}
function Protect-Environment {
    $path = Join-Path $root '.env'
    $acl = Get-Acl $path
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $identity, [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    Set-Acl -Path $path -AclObject $acl
}
function Port-Open([int]$port) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(300)) { return $false }
        $client.EndConnect($pending)
        return $client.Connected
    } catch { return $false }
    finally { $client.Close() }
}
function Http-Ready([string]$url) {
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
    } catch { return $false }
}
function Docker-Ready {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
    try {
        & docker info *> $null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}
function Compose([string[]]$arguments) {
    & docker compose -f (Join-Path $root 'docker-compose.yml') @arguments
    if ($LASTEXITCODE -ne 0) { Fail "Docker Compose failed: $($arguments -join ' ')" }
}
function Check-Prerequisites {
    Require-Command 'uv' 'Install uv from https://docs.astral.sh/uv/getting-started/installation/.'
    Require-Command 'node' 'Install the Node.js version in .node-version (24.21.0 or later 24.x).'
    Require-Command 'npm' 'Install npm with Node.js.'
    $nodeVersion = (& node --version).Trim()
    if ($nodeVersion -notmatch '^v24\.(\d+)\.(\d+)$' -or
        [int]$matches[1] -lt 21 -or
        ([int]$matches[1] -eq 21 -and [int]$matches[2] -lt 0)) {
        Fail "Node.js 24.21.0+ (24.x) is required; found $nodeVersion."
    }
    Say "READY system prerequisites (Node $nodeVersion, uv)"
}
function Ensure-FFmpeg {
    if ((Get-Command ffmpeg -ErrorAction SilentlyContinue) -and
        (Get-Command ffprobe -ErrorAction SilentlyContinue)) {
        Say 'READY FFmpeg and ffprobe from PATH'
        return
    }
    $bin = (& (Join-Path $PSScriptRoot 'ensure_ffmpeg.ps1') | Select-Object -Last 1)
    if (-not $bin -or -not (Test-Path (Join-Path $bin 'ffmpeg.exe') -PathType Leaf) -or
        -not (Test-Path (Join-Path $bin 'ffprobe.exe') -PathType Leaf)) {
        Fail 'Local FFmpeg setup did not produce ffmpeg.exe and ffprobe.exe.'
    }
    $env:PATH = "$bin$([IO.Path]::PathSeparator)$env:PATH"
    Say 'READY project-local FFmpeg and ffprobe'
}
function Ensure-Environment {
    $envPath = Join-Path $root '.env'
    $values = Env-Values
    if ($values.ContainsKey('POSTGRES_PASSWORD') -and $values['POSTGRES_PASSWORD']) { return }
    $volumeExists = $false
    if ($LegacyDocker) { try {
        & docker volume inspect musicscope_v2_postgres_data *> $null
        $volumeExists = $LASTEXITCODE -eq 0
    } catch { } }
    if ($volumeExists) {
        Fail 'The PostgreSQL volume exists but .env has no password. Restore the original ignored .env; no credential was changed.'
    }
    Invoke-SetupCommand 'uv' @('python', 'install', '3.12')
    $python = (& uv python find 3.12).Trim()
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $python)) { Fail 'Python 3.12 is unavailable.' }
    $arguments = @((Join-Path $root 'scripts\configure_local_env.py'))
    if (Test-Path $envPath) { $arguments += '--allow-existing-empty' }
    if ((Invoke-StartupProcess $python $arguments $setupLog) -ne 0) { Fail "Local environment initialization failed; see $setupLog." }
    Protect-Environment
    Say 'READY unique local database password and encryption key in ignored .env'
}
function Ensure-Postgres($values) {
    $port = [int](Env-Value $values 'POSTGRES_PORT' '55432')
    $container = [string](& docker compose -f (Join-Path $root 'docker-compose.yml') ps -q postgres)
    $container = $container.Trim()
    if (-not $container -and (Port-Open $port)) {
        Fail "Port $port is already occupied. MusicScope did not change the other process."
    }
    Compose -arguments @('up', '-d', 'postgres') | Out-Null
    $user = Env-Value $values 'POSTGRES_USER' 'musicscope_v2'
    $database = Env-Value $values 'POSTGRES_DB' 'musicscope_v2'
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        & docker compose -f (Join-Path $root 'docker-compose.yml') exec -T postgres pg_isready -U $user -d $database *> $null
        if ($LASTEXITCODE -eq 0) { Say 'READY PostgreSQL'; return }
        Start-Sleep -Seconds 2
    }
    Fail 'PostgreSQL did not become ready; inspect Docker Desktop.'
}
function Ensure-Dependencies {
    Say 'Preparing Python 3.12 and API dependencies (first launch takes longer)...'
    Invoke-SetupCommand 'uv' @('sync', '--project', (Join-Path $root 'apps\api'), '--extra', 'dev', '--python', '3.12', '--locked')
    $env:UV_HTTP_TIMEOUT = '300'
    Say 'Preparing audio engine (PyTorch download can take several minutes)...'
    Invoke-SetupCommand 'uv' @('sync', '--project', (Join-Path $root 'apps\audio-worker'), '--extra', 'dev', '--python', '3.12', '--locked')
    foreach ($project in @('apps\web', 'services\netease-api')) {
        Push-Location (Join-Path $root $project)
        try {
            $marker = Join-Path $logs (($project -replace '[\\/]', '-') + '-dependencies.txt')
            $fingerprint = (Get-FileHash 'package-lock.json').Hash + (Get-FileHash 'package.json').Hash + (& node --version)
            if ((Test-Path 'node_modules/.package-lock.json') -and (Test-Path $marker) -and
                (Get-Content $marker -Raw).Trim() -eq $fingerprint) {
                Say "READY $project (installed dependencies reused)"
                continue
            }
            Say "Installing $project dependencies..."
            Invoke-SetupCommand 'npm.cmd' @('ci', '--no-audit', '--no-fund', '--fetch-retries=3')
            Set-Content -Path $marker -Value $fingerprint
        } finally { Pop-Location }
    }
    Say 'READY API, worker, web, and NetEase dependencies'
}
function Invoke-SetupCommand([string]$executable, [string[]]$arguments) {
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        if ((Invoke-StartupProcess $executable $arguments $setupLog) -eq 0) { return }
        if ($attempt -lt 2) { Say 'Dependency installation interrupted; retrying with cached downloads...' }
    }
    Fail "Dependency setup failed. Run MusicScope.cmd again to resume; details: $setupLog"
}
function Ensure-Encryption-Key($values) {
    if ($values.ContainsKey('SECRET_ENCRYPTION_KEY') -and $values['SECRET_ENCRYPTION_KEY']) { return }
    $user = Env-Value $values 'POSTGRES_USER' 'musicscope_v2'
    $database = Env-Value $values 'POSTGRES_DB' 'musicscope_v2'
    $query = "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name <> 'alembic_version'"
    $countText = (& docker compose -f (Join-Path $root 'docker-compose.yml') exec -T postgres psql -U $user -d $database -tAc $query).Trim()
    $count = 0
    if ($LASTEXITCODE -ne 0 -or -not [int]::TryParse($countText, [ref]$count)) {
        Fail 'Could not verify the existing database before key generation.'
    }
    if ($count -ne 0) { Fail 'Database contains MusicScope tables but the encryption key is missing. Restore the original .env.' }
    if ((Invoke-StartupProcess $apiPython @((Join-Path $root 'scripts\configure_local_env.py'), '--allow-existing-empty') $setupLog) -ne 0) { Fail "Encryption key setup failed; see $setupLog." }
    Protect-Environment
}
function Ensure-Migrations {
    Push-Location (Join-Path $root 'apps\api')
    try {
        if ((Invoke-StartupProcess $apiPython @('-m', 'alembic', 'current') $setupLog) -ne 0) { Fail "Could not inspect migration state; see $setupLog." }
        if ((Invoke-StartupProcess $apiPython @('-m', 'alembic', 'upgrade', 'head') $setupLog) -ne 0) { Fail "Migration failed; no database was reset. See $setupLog." }
    } finally { Pop-Location }
    Say 'READY database migrations'
}
function Start-AppService([string]$name, [int]$port, [string]$url, [string]$executable,
                       [string[]]$arguments, [string]$directory, [string]$logName) {
    if (Http-Ready $url) { Say "SKIPPED $name (already healthy)"; return }
    if (Port-Open $port) { Fail "Port $port is occupied by an unhealthy or unrelated service. Inspect it before retrying." }
    $outLog = Join-Path $logs "$logName.out.log"
    $errLog = Join-Path $logs "$logName.err.log"
    $process = Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $directory `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
    $started.Add($process)
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        if (Http-Ready $url) { Say "READY $name"; return }
        $process.Refresh()
        if ($process.HasExited) { Fail "$name exited during startup; see $errLog." }
        Start-Sleep -Seconds 1
    }
    Fail "$name did not become ready; see $errLog."
}
function Worker-Ready {
    if (-not (Test-Path $workerHealth)) { return $false }
    try {
        $health = Get-Content $workerHealth -Raw | ConvertFrom-Json
        if ($health.state -eq 'stopped') { return $false }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($health.pid)"
        return $null -ne $process -and $process.CommandLine -like '*-m audio_worker*' -and
            $process.CommandLine -like "*$root*"
    } catch { return $false }
}
function Start-Worker {
    if (Worker-Ready) { Say 'SKIPPED audio worker (already healthy)'; return }
    $existing = Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -like '*-m audio_worker*' -and $_.CommandLine -like "*$root*"
    } | Select-Object -First 1
    if ($existing) { Fail 'An untracked MusicScope audio worker is running. Inspect it before retrying.' }
    if (Test-Path $workerHealth) { Remove-Item $workerHealth }
    $outLog = Join-Path $logs 'audio-worker.out.log'
    $errLog = Join-Path $logs 'audio-worker.err.log'
    $process = Start-Process -FilePath $workerPython `
        -ArgumentList @('-m', 'audio_worker', '--health-file', "`"$workerHealth`"") `
        -WorkingDirectory (Join-Path $root 'apps\audio-worker') `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
    $started.Add($process)
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Worker-Ready) { Say 'READY audio worker'; return }
        $process.Refresh()
        if ($process.HasExited) { Fail "Audio worker exited during startup; see $errLog." }
        Start-Sleep -Seconds 1
    }
    Fail "Audio worker did not become ready; see $errLog."
}
function Show-Status {
    $values = Env-Values
    $apiPort = [int](Env-Value $values 'API_PORT' '8100')
    $webPort = [int](Env-Value $values 'MUSICSCOPE_WEB_PORT' '3100')
    $neteasePort = [int](Env-Value $values 'MUSICSCOPE_NETEASE_PORT' '36531')
    Say "Environment: $(if (Test-Path (Join-Path $root '.env')) { 'PRESENT' } else { 'ABSENT' })"
    Say "Database port: $(if (Port-Open ([int](Env-Value $values 'POSTGRES_PORT' '55432'))) { 'OPEN' } else { 'CLOSED' })"
    if ($LegacyDocker) { Say "Docker: $(if (Docker-Ready) { 'READY' } else { 'UNAVAILABLE' })" }
    Say "NetEase sidecar: $(if (Http-Ready "http://127.0.0.1:$neteasePort/health") { 'READY' } else { 'NOT_READY' })"
    Say "FastAPI: $(if (Http-Ready "http://127.0.0.1:$apiPort/health") { 'READY' } else { 'NOT_READY' })"
    Say "Audio worker: $(if (Worker-Ready) { 'READY' } else { 'NOT_READY' })"
    Say "Web: $(if (Http-Ready "http://127.0.0.1:$webPort/") { 'READY' } else { 'NOT_READY' })"
}

try {
    if ($Status) { Show-Status; exit 0 }
    New-Item -ItemType Directory -Force -Path $logs | Out-Null
    New-Item -ItemType File -Force -Path $setupLog | Out-Null
    Say 'Starting native Windows MusicScope'
    if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
        Fail 'This launcher supports Windows x64. Use a 64-bit Windows x64 machine.'
    }
    Ensure-WindowsRuntimes $root
    if ($LegacyDocker) { Ensure-WindowsDocker $root }
    Check-Prerequisites
    Ensure-FFmpeg
    Ensure-Environment
    Protect-Environment
    $values = Env-Values
    Ensure-Dependencies
    if ($LegacyDocker) {
        Ensure-Postgres $values
        Ensure-Encryption-Key $values
    } else {
        Ensure-NativePostgres $root $apiPython $setupLog
    }
    $values = Env-Values
    $env:MUSICSCOPE_NETEASE_PORT = Env-Value $values 'MUSICSCOPE_NETEASE_PORT' '36531'
    $env:NEXT_PUBLIC_API_URL = Env-Value $values 'NEXT_PUBLIC_API_URL' 'http://localhost:8100'
    Ensure-Migrations
    if ($Setup) { Say 'SETUP complete; application processes were not started'; exit 0 }
    $apiPort = [int](Env-Value $values 'API_PORT' '8100')
    $webPort = [int](Env-Value $values 'MUSICSCOPE_WEB_PORT' '3100')
    $neteasePort = [int]$env:MUSICSCOPE_NETEASE_PORT
    $node = (Get-Command node).Source
    Start-AppService 'NetEase sidecar' $neteasePort "http://127.0.0.1:$neteasePort/health" $node @('server.cjs') `
        (Join-Path $root 'services\netease-api') 'netease'
    Start-AppService 'FastAPI' $apiPort "http://127.0.0.1:$apiPort/health" $apiPython `
        @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', "$apiPort") `
        (Join-Path $root 'apps\api') 'api'
    Start-Worker
    $next = Join-Path $root 'apps\web\node_modules\next\dist\bin\next'
    Start-AppService 'Web' $webPort "http://127.0.0.1:$webPort/" $node `
        @("`"$next`"", 'dev', '--hostname', '127.0.0.1', '--port', "$webPort") `
        (Join-Path $root 'apps\web') 'web'
    Say "APPLICATION READY: http://127.0.0.1:$webPort"
    if (-not $NoOpen) { Start-Process "http://127.0.0.1:$webPort" }
    if ($started.Count -eq 0) { Say 'All services were already running.'; exit 0 }
    Say 'Press Ctrl+C to stop services started by this launcher. PostgreSQL remains running.'
    while ($true) {
        if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { break }
        foreach ($process in $started) {
            $process.Refresh()
            if ($process.HasExited) { Fail 'A launched service stopped unexpectedly. Inspect .logs.' }
        }
        Start-Sleep -Seconds 2
    }
} catch {
    Write-Host "`n[MusicScope] Startup could not finish: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "[MusicScope] Setup log: $setupLog"
    exit 1
} finally {
    foreach ($process in $started) {
        try {
            $process.Refresh()
            if (-not $process.HasExited) { & taskkill /PID $process.Id /T /F *> $null }
        } catch { }
    }
}
