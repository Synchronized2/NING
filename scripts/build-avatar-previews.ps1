param(
  [string]$MiraDir = 'D:\gitlab\OpenAIQ\Mira-Companion'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$repo = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $repo 'miniprogram\packages\avatars\previews'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$characters = Get-Content -LiteralPath (Join-Path $MiraDir 'shared\characters.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg' | Select-Object -First 1
$quality = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)
$parameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
$parameters.Param[0] = $quality
$size = 384
$count = 0
foreach ($character in $characters) {
  if ($character.generation -ne 3) { continue }
  if ($character.id -notmatch '^[a-z0-9-]+$') { throw "Invalid character ID: $($character.id)" }
  $relative = [Uri]::UnescapeDataString($character.preview).TrimStart('/').Replace('/', '\')
  $source = Join-Path (Join-Path $MiraDir 'public') $relative
  $target = Join-Path $destination "$($character.id).jpg"
  $image = [System.Drawing.Image]::FromFile($source)
  $canvas = New-Object System.Drawing.Bitmap($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($canvas)
  try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $scale = [Math]::Min($size / $image.Width, $size / $image.Height)
    $width = [int][Math]::Round($image.Width * $scale)
    $height = [int][Math]::Round($image.Height * $scale)
    $graphics.DrawImage($image, [int](($size - $width) / 2), [int](($size - $height) / 2), $width, $height)
    $canvas.Save($target, $encoder, $parameters)
    $count++
  } finally {
    $graphics.Dispose()
    $canvas.Dispose()
    $image.Dispose()
  }
}
$parameters.Dispose()
Write-Output "Generated $count avatar previews in $destination"
