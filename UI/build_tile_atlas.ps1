# Run from PowerShell after changing pictures/*.png. No runtime image processing.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$assetDirectory = Join-Path $PSScriptRoot 'static/assets'
$references = @(
    (Join-Path $PSScriptRoot 'static/index.html'),
    (Join-Path $PSScriptRoot 'static/styles.css'),
    (Join-Path $projectRoot 'multiplayer/web.py')
)
$pattern = 'tiles-[0-9a-f]{12}\.png'
foreach ($reference in $references) {
    if (-not [regex]::IsMatch([System.IO.File]::ReadAllText($reference), $pattern)) {
        throw "Missing atlas reference: $reference"
    }
}

$names = @(0..20 | ForEach-Object { "$_.png" }) + @('24.png', 'plus.png', 'mult.png')
$cellWidth = 210
$cellHeight = 300
$atlas = New-Object System.Drawing.Bitmap (6 * $cellWidth), (4 * $cellHeight)
$graphics = [System.Drawing.Graphics]::FromImage($atlas)
$attributes = New-Object System.Drawing.Imaging.ImageAttributes
$stream = New-Object System.IO.MemoryStream
$sourceBytes = 0
try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    for ($index = 0; $index -lt $names.Count; $index++) {
        $sourcePath = Join-Path $projectRoot ('pictures/' + $names[$index])
        $sourceBytes += (Get-Item -LiteralPath $sourcePath).Length
        $source = [System.Drawing.Image]::FromFile($sourcePath)
        try {
            $rectangle = New-Object System.Drawing.Rectangle (($index % 6) * $cellWidth), ([math]::Floor($index / 6) * $cellHeight), $cellWidth, $cellHeight
            $graphics.DrawImage($source, $rectangle, 0, 0, $source.Width, $source.Height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
        } finally {
            $source.Dispose()
        }
    }
    $atlas.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()
} finally {
    $stream.Dispose()
    $attributes.Dispose()
    $graphics.Dispose()
    $atlas.Dispose()
}

$hasher = [System.Security.Cryptography.SHA256]::Create()
try {
    $digest = ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant().Substring(0, 12)
} finally {
    $hasher.Dispose()
}
$filename = "tiles-$digest.png"
[System.IO.File]::WriteAllBytes((Join-Path $assetDirectory $filename), $bytes)
$encoding = New-Object System.Text.UTF8Encoding $false
foreach ($reference in $references) {
    $text = [System.IO.File]::ReadAllText($reference)
    [System.IO.File]::WriteAllText($reference, [regex]::Replace($text, $pattern, $filename), $encoding)
}
[PSCustomObject]@{ Atlas=$filename; SourceBytes=$sourceBytes; AtlasBytes=$bytes.Length; Width=1260; Height=1200 } | ConvertTo-Json
