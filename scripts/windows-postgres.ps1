# Native PostgreSQL: no Windows service, Docker, WSL, or administrator required.
function Ensure-NativePostgres([string]$ProjectRoot, [string]$Python, [string]$LogPath) {
    Write-Host '[MusicScope] Preparing project-local PostgreSQL (no Docker / WSL)...'
    # Vendor checksum: EnterpriseDB/edb-installers issue 696.
    $directory = Install-StartupArchive `
        'https://get.enterprisedb.com/postgresql/postgresql-16.15-1-windows-x64-binaries.zip' `
        '25e6fcdfb8caec38691bf461125e7564508760666f7b8e5dc6a5f0818f58f81e' `
        (Join-Path $ProjectRoot '.tools\postgresql-16.15') 'pgsql' `
        @('bin\postgres.exe', 'bin\initdb.exe', 'bin\pg_ctl.exe')
    $storage = Join-Path $ProjectRoot 'storage\postgres'
    New-Item -ItemType Directory -Force -Path $storage | Out-Null
    $acl = Get-Acl $storage
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -Path $storage -AclObject $acl
    $arguments = @((Join-Path $ProjectRoot 'scripts\native_postgres.py'), '--root', $ProjectRoot,
        '--bin', (Join-Path $directory 'bin'))
    if ((Invoke-StartupProcess $Python $arguments $LogPath) -ne 0) {
        throw "Local database startup failed; details: $LogPath. Your database files were preserved."
    }
    Write-Host '[MusicScope] READY native PostgreSQL'
}
