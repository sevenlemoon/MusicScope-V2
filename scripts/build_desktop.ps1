$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ($env:OS -ne 'Windows_NT') { throw 'Build this package on Windows x64.' }
. (Join-Path $PSScriptRoot 'windows-tools.ps1')
function Checked([string]$exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { throw "Build command failed: $exe" }
}
& node (Join-Path $root 'apps\desktop\node_modules\electron\install.js')
if ($LASTEXITCODE -ne 0) { throw 'Electron runtime download failed' }
$version = (Get-Content (Join-Path $root 'apps\desktop\package.json') -Raw | ConvertFrom-Json).version
$stage = Join-Path $root ('dist\desktop-' + [guid]::NewGuid().ToString('N'))
$application = Join-Path $stage 'MusicScope'
New-Item -ItemType Directory -Force -Path $application | Out-Null
Copy-Item (Join-Path $root 'apps\desktop\node_modules\electron\dist\*') $application -Recurse
Rename-Item (Join-Path $application 'electron.exe') 'MusicScope.exe'
$resources = Join-Path $application 'resources'
$app = Join-Path $resources 'app'
New-Item -ItemType Directory -Force -Path $app | Out-Null
foreach ($file in @('package.json', 'main.cjs', 'runtime.cjs', 'preload.cjs', 'loading.html', 'loading.css', 'loading.js')) {
    Copy-Item (Join-Path $root "apps\desktop\$file") $app
}
$project = Join-Path $resources 'project'
$runtime = Join-Path $project 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
# An explicit production allowlist. Never archive the checkout or ship .env/data.
foreach ($directory in @('apps\api\app', 'apps\api\alembic', 'apps\audio-worker\audio_worker')) {
    $destination = Join-Path $project $directory
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Get-ChildItem (Join-Path $root $directory) -Recurse -File | Where-Object {
        $_.FullName -notmatch '[\\/]__pycache__[\\/]' -and $_.Extension -ne '.pyc'
    } | ForEach-Object {
        $relative = $_.FullName.Substring((Join-Path $root $directory).Length + 1)
        $target = Join-Path $destination $relative
        New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $target
    }
}
Copy-Item (Join-Path $root 'apps\api\alembic.ini') (Join-Path $project 'apps\api')
New-Item -ItemType Directory -Force -Path (Join-Path $project 'scripts') | Out-Null
foreach ($script in @('desktop_prepare.py', 'prepare_local_database.py', 'configure_local_env.py')) {
    Copy-Item (Join-Path $root "scripts\$script") (Join-Path $project 'scripts')
}

# Standalone web output is compiled on the builder, never on the user's PC.
$env:NEXT_PUBLIC_API_URL = 'http://127.0.0.1:8100'
$env:NEXT_TELEMETRY_DISABLED = '1'
Checked 'npm.cmd' @('--prefix', (Join-Path $root 'apps\web'), 'run', 'build')
$web = Join-Path $project 'apps\web'
Copy-Item (Join-Path $root 'apps\web\.next\standalone') $web -Recurse
if (-not (Test-Path (Join-Path $web 'server.js'))) { throw 'Standalone web entry point missing' }
Copy-Item (Join-Path $root 'apps\web\.next\static') (Join-Path $web '.next\static') -Recurse
if (Test-Path (Join-Path $root 'apps\web\public')) {
    Copy-Item (Join-Path $root 'apps\web\public') (Join-Path $web 'public') -Recurse
}
# Next may trace local environment files. They must never enter a release.
Get-ChildItem $web -Recurse -Force -File -Filter '.env*' | ForEach-Object {
    throw "Unexpected environment file in standalone build: $($_.Name). Build in a clean checkout."
}

$sidecar = Join-Path $project 'services\netease-api'
New-Item -ItemType Directory -Force -Path $sidecar | Out-Null
foreach ($file in @('package.json', 'package-lock.json', '.npmrc', 'server.cjs', 'provider.cjs')) {
    Copy-Item (Join-Path $root "services\netease-api\$file") $sidecar
}
Copy-Item (Join-Path $root 'services\netease-api\compat') (Join-Path $sidecar 'compat') -Recurse
Checked 'npm.cmd' @('--prefix', $sidecar, 'ci', '--omit=dev', '--no-audit', '--no-fund')

# Bundle private, relocatable runtimes. No system PATH or venv references at launch.
Ensure-WindowsRuntimes -ProjectRoot (Join-Path $stage 'build-tools') -ForceLocal
$nodeDirectory = Split-Path (Get-Command node).Source
New-Item -ItemType Directory -Force -Path (Join-Path $runtime 'node') | Out-Null
foreach ($file in @('node.exe', 'LICENSE')) { Copy-Item (Join-Path $nodeDirectory $file) (Join-Path $runtime 'node') }
$ffmpegBin = & (Join-Path $PSScriptRoot 'ensure_ffmpeg.ps1')
Copy-Item (Split-Path $ffmpegBin) (Join-Path $runtime 'ffmpeg') -Recurse
$previousPythonInstall = $env:UV_PYTHON_INSTALL_DIR
try {
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $stage 'build-python'
    Checked 'uv' @('python', 'install', '3.12.10')
    $python = (& uv python find --managed-python '3.12.10').Trim()
    if ($LASTEXITCODE -ne 0 -or -not $python.StartsWith($env:UV_PYTHON_INSTALL_DIR, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Could not locate the private build Python'
    }
    foreach ($name in @('api', 'audio-worker')) {
        Copy-Item (Split-Path $python) (Join-Path $runtime "python-$name") -Recurse
    }
} finally { $env:UV_PYTHON_INSTALL_DIR = $previousPythonInstall }
foreach ($name in @('api', 'audio-worker')) {
    $python = Join-Path $runtime "python-$name\python.exe"
    $requirementsFile = Join-Path $stage "$name-requirements.txt"
    Checked 'uv' @('export', '--project', (Join-Path $root "apps\$name"), '--locked', '--no-dev', '--no-emit-project', '--output-file', $requirementsFile)
    # Keep API/worker locks isolated: they can pin different transitive versions.
    Checked 'uv' @('pip', 'install', '--python', $python, '--break-system-packages', '--require-hashes', '--no-deps', '-r', $requirementsFile)
    # Single quotes inside Python survive Windows PowerShell 5.1 native argv parsing.
    Checked $python @('-c', "import importlib.util; assert importlib.util.find_spec('pytest') is None; assert importlib.util.find_spec('ruff') is None")
    $imports = if ($name -eq 'api') { 'import fastapi, uvicorn, alembic, cryptography' } else { 'import torch, demucs, sphn, numpy' }
    Checked $python @('-c', $imports)
}
# Preserve resolved dependency inventories alongside the native dependency licenses.
New-Item -ItemType Directory -Force -Path (Join-Path $project 'dependency-inventory') | Out-Null
Copy-Item (Join-Path $stage '*-requirements.txt') (Join-Path $project 'dependency-inventory')
$output = Join-Path $root "dist\MusicScope-$version-windows-x64.zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($application, $output)
$hash = (Get-FileHash $output -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($output + '.sha256'), "$hash  $([IO.Path]::GetFileName($output))`n")
Write-Host "Created $output"
