$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
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
foreach ($file in @('package.json', 'main.cjs', 'preload.cjs', 'loading.html', 'loading.css', 'loading.js')) {
    Copy-Item (Join-Path $root "apps\desktop\$file") $app
}
$sourceZip = Join-Path $stage 'source.zip'
Push-Location $root
try {
    & git archive --format=zip "--output=$sourceZip" HEAD apps/api apps/audio-worker apps/web services scripts contracts .env.example .node-version docker-compose.yml
    if ($LASTEXITCODE -ne 0) { throw 'Could not export release source' }
} finally { Pop-Location }
Expand-Archive -LiteralPath $sourceZip -DestinationPath (Join-Path $resources 'project')
$output = Join-Path $root "dist\MusicScope-$version-windows-x64.zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($application, $output)
$hash = (Get-FileHash $output -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($output + '.sha256'), "$hash  $([IO.Path]::GetFileName($output))`n")
Write-Host "Created $output"
