$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-tools.ps1')

# FFmpeg recommends this Windows build. Keep the URL versioned and the hash pinned
# so a changed upstream archive cannot silently become executable on the machine.
$version = '9.0.2'
$archiveName = "ffmpeg-$version-essentials_build.zip"
$archiveUrl = "https://www.gyan.dev/ffmpeg/builds/packages/$archiveName"
$expectedSha256 = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
$toolRoot = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '.tools\ffmpeg'
$install = Join-Path $toolRoot "ffmpeg-$version-essentials_build"
$bin = Join-Path $install 'bin'
$ffmpeg = Join-Path $bin 'ffmpeg.exe'
$ffprobe = Join-Path $bin 'ffprobe.exe'

Write-Host "[MusicScope] Preparing FFmpeg $version (first download is about 110 MB)..."
Install-StartupArchive $archiveUrl $expectedSha256 $install "ffmpeg-$version-essentials_build" @('bin\ffmpeg.exe', 'bin\ffprobe.exe') | Out-Null
& $ffmpeg -version *> $null
if ($LASTEXITCODE -ne 0) { throw 'ffmpeg.exe could not start.' }
& $ffprobe -version *> $null
if ($LASTEXITCODE -ne 0) { throw 'ffprobe.exe could not start.' }
Write-Output $bin
