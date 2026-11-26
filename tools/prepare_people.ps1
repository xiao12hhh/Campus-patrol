# Rebuild optimized crowd assets from the two user-supplied archives.
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
Set-Location $project
Add-Type -AssemblyName System.Drawing
$raw = Join-Path $project '_models_raw/people'
$output = Join-Path $project 'public/models/people'
New-Item -ItemType Directory -Force $raw,$output | Out-Null
$assets = @(
    @('0d84c64aea3136efa1a91aa4129687e2','b415c79d3d9fef5346d964b19df846ae','a','b415c79d3d9fef5346d964b19df846ae:Material'),
    @('73af9d7d2391cf0ff92b6190481039fb','cbbe0154681c379e126e9ba09279a64c','b','Material')
)
foreach ($asset in $assets) {
    $archive = Join-Path $project ($asset[0]+'.rar')
    $entries = & tar -tf $archive
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read archive' }
    foreach ($entry in $entries) {
        if ($entry -notlike ($asset[0]+'*') -or $entry -match '(^|[/\\])\.\.([/\\]|$)') { throw "Unexpected archive path: $entry" }
    }
    & tar -xf $archive -C $raw
    if ($LASTEXITCODE -ne 0) { throw 'Unable to extract archive' }
    $folder = Join-Path $raw $asset[0]
    $source = [System.Drawing.Image]::FromFile((Join-Path $folder 'texture_pbr_20250901.png'))
    $bitmap = New-Object System.Drawing.Bitmap 1024,1024
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($source,0,0,1024,1024)
        $bitmap.Save((Join-Path $folder 'albedo.jpg'),[System.Drawing.Imaging.ImageFormat]::Jpeg)
    } finally { $graphics.Dispose(); $bitmap.Dispose(); $source.Dispose() }
    Get-ChildItem -LiteralPath $folder -Filter *.mtl | ForEach-Object {
        Set-Content -LiteralPath $_.FullName -Encoding ascii -Value "newmtl $($asset[3])`nKd 1 1 1`nd 1`nillum 2`nmap_Kd albedo.jpg"
    }
    & node node_modules/gltfpack/cli.js -i (Join-Path $folder ($asset[1]+'.obj')) -o (Join-Path $output ('person-'+$asset[2]+'.glb')) -si 0.12 -se 0.02 -sp -cc -v
    if ($LASTEXITCODE -ne 0) { throw 'GLB conversion failed' }
}
