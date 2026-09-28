$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-tools.ps1')
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('MusicScope bootstrap test ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $sandbox | Out-Null
try {
    $processLog = Join-Path $sandbox 'native.log'
    $code = Invoke-StartupProcess 'cmd.exe' @('/d', '/c', 'echo harmless-progress 1>&2 & exit /b 0') $processLog
    if ($code -ne 0 -or -not ((Get-Content $processLog -Raw) -match 'harmless-progress')) { throw 'Successful stderr output stopped startup' }
    $code = Invoke-StartupProcess 'cmd.exe' @('/d', '/c', 'exit /b 7') $processLog
    if ($code -ne 7) { throw 'Native failure exit code was lost' }
    $fixture = Join-Path $sandbox 'fixture'
    New-Item -ItemType Directory -Path (Join-Path $fixture 'runtime\bin') -Force | Out-Null
    Set-Content (Join-Path $fixture 'runtime\bin\tool.exe') 'test fixture, not executable'
    $script:fixtureZip = Join-Path $sandbox 'fixture.zip'
    Compress-Archive -Path (Join-Path $fixture 'runtime') -DestinationPath $script:fixtureZip
    $hash = (Get-FileHash $script:fixtureZip).Hash
    $script:downloads = 0
    function Get-StartupDownload([string]$Uri, [string]$Destination) {
        $script:downloads++
        Copy-Item -LiteralPath $script:fixtureZip -Destination $Destination
    }
    $destination = Join-Path $sandbox 'project with spaces\.tools\runtime'
    $result = Install-StartupArchive 'https://example.invalid/test.zip' $hash $destination 'runtime' @('bin\tool.exe')
    if ($result -ne $destination -or -not (Test-Path (Join-Path $result 'bin\tool.exe'))) { throw 'Install failed' }
    $again = Install-StartupArchive 'https://example.invalid/test.zip' $hash $destination 'runtime' @('bin\tool.exe')
    if ($again -ne $destination -or $script:downloads -ne 1) { throw 'Cached install downloaded again' }
    $rejected = Join-Path $sandbox 'rejected'
    $caught = $false
    try { Install-StartupArchive 'https://example.invalid/test.zip' ('0' * 64) $rejected 'runtime' @('bin\tool.exe') | Out-Null }
    catch { $caught = $_.Exception.Message -like '*checksum*' }
    if (-not $caught -or (Test-Path $rejected)) { throw 'Bad checksum was not rejected' }
    $incomplete = Join-Path $sandbox 'incomplete'
    New-Item -ItemType Directory -Path $incomplete | Out-Null
    Install-StartupArchive 'https://example.invalid/test.zip' $hash $incomplete 'runtime' @('bin\tool.exe') | Out-Null
    if (-not (Test-Path (Join-Path $incomplete 'bin\tool.exe'))) { throw 'Incomplete install did not recover' }
    if (@(Get-ChildItem $sandbox -Filter '*.incomplete-*').Count -ne 1) { throw 'Incomplete install was not preserved' }
    if (@(Get-ChildItem $sandbox -Recurse -Directory -Filter '.download-*').Count -ne 0) { throw 'Temporary downloads were left behind' }
    Write-Host 'PASS Windows bootstrap: spaces, checksum rejection, cached reuse, incomplete-install recovery, cleanup'
} finally {
    Remove-Item -LiteralPath $sandbox -Recurse -Force
}
