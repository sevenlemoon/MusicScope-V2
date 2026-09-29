# Native PostgreSQL: no Windows service, Docker, WSL, or administrator required.
function Ensure-NativePostgres([string]$ProjectRoot, [string]$Python, [string]$LogPath) {
    Write-Host '[MusicScope] Preparing project-local PostgreSQL (no Docker / WSL)...'
    # PostgreSQL drops the Administrators group when launching its children.
    # Grant the actual user access, even in admin-owned CI/extracted directories.
    $toolsDirectory = Join-Path $ProjectRoot '.tools'
    New-Item -ItemType Directory -Force -Path $toolsDirectory | Out-Null
    $toolsAcl = Get-Acl $toolsDirectory
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $toolsAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $userSid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    Set-Acl -Path $toolsDirectory -AclObject $toolsAcl
    # Zonky's reduced EDB distribution: same PostgreSQL, without pgAdmin/docs.
    $package = Install-StartupArchive `
        'https://repo.maven.apache.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-windows-amd64/16.15.0/embedded-postgres-binaries-windows-amd64-16.15.0.jar' `
        '51c7812dc1af47c9a2ccb64fe74efb88c515cff2da347ce72aab92b4cc8e1191' `
        (Join-Path $ProjectRoot '.tools\postgresql-package-16.15') '' `
        @('postgres-windows-x86_64.txz')
    $runtime = Install-StartupArchive `
        'https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx' `
        'b56a9101f706f9d95f815f5b7fa6efbac972e86573d378b96a07cff5540c5961' `
        (Join-Path $ProjectRoot '.tools\vclibs-14-desktop') '' @('vcruntime140.dll', 'msvcp140.dll')
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
        '--archive', (Join-Path $package 'postgres-windows-x86_64.txz'), '--runtime', $runtime)
    if ((Invoke-StartupProcess $Python $arguments $LogPath) -ne 0) {
        throw "Local database startup failed; details: $LogPath. Your database files were preserved."
    }
    Write-Host '[MusicScope] READY native PostgreSQL'
}
