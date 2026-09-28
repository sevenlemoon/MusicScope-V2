# Shared bootstrap functions; dot-sourcing this file performs no installation.
function Invoke-StartupProcess([string]$Executable, [string[]]$Arguments, [string]$LogPath) {
    Get-Command $Executable -ErrorAction Stop | Out-Null
    $savedAction = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 represents redirected stderr as ErrorRecords,
        # including successful uv/alembic progress. The exit code is authoritative.
        $ErrorActionPreference = 'Continue'
        & $Executable @Arguments *>> $LogPath
        return $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedAction }
}

function Get-StartupDownload([string]$Uri, [string]$Destination) {
    # Windows ships curl.exe. Keep partial downloads so a second launch resumes
    # large runtimes instead of repeatedly starting them from zero.
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            & curl.exe --fail --location --continue-at - --connect-timeout 30 `
                --speed-time 120 --speed-limit 1024 --output $Destination $Uri
            if ($LASTEXITCODE -eq 0) { return }
            # A server without range support must restart this download.
            if ($LASTEXITCODE -eq 33 -and (Test-Path -LiteralPath $Destination)) {
                Remove-Item -LiteralPath $Destination -Force
            }
            Write-Host "[MusicScope] Download interrupted; retrying ($attempt/3)..."
        }
        throw "Download interrupted: $Uri. Run MusicScope.cmd again to resume."
    }
    $savedProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            try {
                Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing -TimeoutSec 600
                return
            } catch {
                if ($attempt -eq 3) { throw "Download failed after 3 attempts: $Uri. Run MusicScope.cmd again to retry. $($_.Exception.Message)" }
                Write-Host "[MusicScope] Network interrupted; retrying download ($attempt/3)..."
                Start-Sleep -Seconds 2
            }
        }
    } finally { $ProgressPreference = $savedProgress }
}

function Install-StartupArchive([string]$Uri, [string]$Sha256, [string]$Destination,
                                [string]$ArchiveRoot, [string[]]$RequiredFiles) {
    $complete = Test-Path $Destination -PathType Container
    foreach ($file in $RequiredFiles) {
        $complete = $complete -and (Test-Path (Join-Path $Destination $file) -PathType Leaf)
    }
    if ($complete) { return $Destination }
    $parent = Split-Path $Destination -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    if (Test-Path $Destination) {
        # Keep an incomplete previous install recoverable while replacing it.
        Move-Item -LiteralPath $Destination -Destination ($Destination + '.incomplete-' + [guid]::NewGuid().ToString('N'))
    }
    $stage = Join-Path $parent ('.download-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        $cache = Join-Path $parent '.downloads'
        New-Item -ItemType Directory -Force -Path $cache | Out-Null
        $zip = Join-Path $cache ($Sha256 + '.zip')
        $verified = (Test-Path -LiteralPath $zip) -and
            ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -eq $Sha256)
        if (-not $verified) { Get-StartupDownload $Uri $zip }
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $Sha256) {
            Remove-Item -LiteralPath $zip -Force
            throw "Download checksum failed: $Uri. The file was not installed."
        }
        $expanded = Join-Path $stage 'expanded'
        Expand-Archive -LiteralPath $zip -DestinationPath $expanded
        $source = if ($ArchiveRoot) { Join-Path $expanded $ArchiveRoot } else { $expanded }
        foreach ($file in $RequiredFiles) {
            if (-not (Test-Path (Join-Path $source $file) -PathType Leaf)) {
                throw "Downloaded archive is missing $file."
            }
        }
        Move-Item -LiteralPath $source -Destination $Destination
        return $Destination
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-WindowsRuntimes([string]$ProjectRoot, [switch]$ForceLocal) {
    $tools = Join-Path $ProjectRoot '.tools'
    $nodeVersion = '24.21.0'
    $currentNode = if (Get-Command node -ErrorAction SilentlyContinue) { (& node --version) } else { '' }
    if ($ForceLocal -or $currentNode -notmatch '^v24\.(2[1-9]|[3-9][0-9]|[1-9][0-9]{2,})\.' -or
        -not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Host "[MusicScope] Preparing Node.js $nodeVersion..."
        $nodeDir = Install-StartupArchive `
            "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" `
            '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541' `
            (Join-Path $tools "node-v$nodeVersion") "node-v$nodeVersion-win-x64" @('node.exe', 'npm.cmd')
        $env:PATH = "$nodeDir;$env:PATH"
    }
    if ($ForceLocal -or -not (Get-Command uv -ErrorAction SilentlyContinue)) {
        Write-Host '[MusicScope] Preparing Python environment manager...'
        $uvDir = Install-StartupArchive `
            'https://github.com/astral-sh/uv/releases/download/0.7.6/uv-x86_64-pc-windows-msvc.zip' `
            '4c81818cc89d75ca54762e2641deebad69c0af6594212a9fb24b9849df8ac413' `
            (Join-Path $tools 'uv-0.7.6') '' @('uv.exe')
        $env:PATH = "$uvDir;$env:PATH"
    }
    & node --version
    if ($LASTEXITCODE -ne 0) { throw 'Node.js could not start.' }
    & uv --version
    if ($LASTEXITCODE -ne 0) { throw 'uv could not start.' }
}

function Test-DockerEngine {
    try {
        & docker info *> $null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}

function Find-DockerDesktop {
    foreach ($directory in @((Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop'),
                             (Join-Path $env:ProgramFiles 'Docker\Docker'))) {
        $candidate = Join-Path $directory 'Docker Desktop.exe'
        if (Test-Path $candidate) {
            $env:PATH = (Join-Path $directory 'resources\bin') + ';' + $env:PATH
            return $candidate
        }
    }
}

function Ensure-WindowsDocker([string]$ProjectRoot) {
    $desktop = Find-DockerDesktop
    if (Test-DockerEngine) { return }
    if (-not $desktop) {
        Write-Host '[MusicScope] Installing Docker Desktop. Windows may ask for administrator permission.'
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            & winget install --id Docker.DockerDesktop --exact --source winget --accept-source-agreements --accept-package-agreements
            $installerExit = $LASTEXITCODE
        } else {
            $downloadDir = Join-Path $ProjectRoot '.tools\docker-installer'
            New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
            $installer = Join-Path $downloadDir 'Docker Desktop Installer.exe'
            Get-StartupDownload 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe' $installer
            $signature = Get-AuthenticodeSignature -LiteralPath $installer
            if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Docker Inc\.?(,|$)') {
                throw 'Docker installer signature could not be verified.'
            }
            $process = Start-Process -FilePath $installer -ArgumentList @('install', '--user') -Wait -PassThru
            $installerExit = $process.ExitCode
        }
        if ($installerExit -eq 3010) { throw 'Docker installation needs a Windows restart. Restart, then double-click MusicScope.cmd to continue.' }
        if ($installerExit -ne 0) { throw 'Docker installation did not finish. Run MusicScope.cmd again after completing the Windows installer.' }
        $desktop = Find-DockerDesktop
        if (-not $desktop) { throw 'Docker installation finished but its executable was not found. Restart Windows and launch MusicScope.cmd again.' }
    }
    if (Test-DockerEngine) { return }
    if ($desktop) { Start-Process -FilePath $desktop }
    Write-Host '[MusicScope] Starting Docker. Complete any first-run Docker/WSL prompts in its window.'
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        if (Test-DockerEngine) { return }
        if ($attempt % 10 -eq 0) { Write-Host '[MusicScope] Waiting for Docker engine...' }
        Start-Sleep -Seconds 2
    }
    throw 'Docker is not ready. Complete its first-run setup (virtualization/WSL may require a restart), then double-click MusicScope.cmd again. Downloads are retained.'
}
