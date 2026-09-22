param(
  [string]$MiraDir = 'D:\gitlab\OpenAIQ\Mira-Companion',
  [int]$Size = 512,
  [ValidateRange(5, 8)]
  [int]$RgbBits = 6,
  [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$repo = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) { $OutputDir = Join-Path $repo 'miniprogram\assets\live2d\hiyori' }
$sourceDir = Join-Path $MiraDir 'public\assets\hiyori\hiyori_pro_zh\runtime\hiyori_pro_t11.2048'
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function Reduce-RgbPrecision([System.Drawing.Bitmap]$Bitmap, [int]$Bits) {
  if ($Bits -ge 8) { return }
  $rect = New-Object System.Drawing.Rectangle(0, 0, $Bitmap.Width, $Bitmap.Height)
  $data = $Bitmap.LockBits(
    $rect,
    [System.Drawing.Imaging.ImageLockMode]::ReadWrite,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  try {
    $stride = [Math]::Abs($data.Stride)
    $bytes = New-Object byte[] ($stride * $Bitmap.Height)
    [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    $mask = 256 - (1 -shl (8 - $Bits))
    for ($row = 0; $row -lt $Bitmap.Height; $row++) {
      $offset = $row * $stride
      for ($column = 0; $column -lt $Bitmap.Width; $column++) {
        $pixel = $offset + $column * 4
        # Format32bppArgb is stored as BGRA; leave alpha untouched.
        $bytes[$pixel] = $bytes[$pixel] -band $mask
        $bytes[$pixel + 1] = $bytes[$pixel + 1] -band $mask
        $bytes[$pixel + 2] = $bytes[$pixel + 2] -band $mask
      }
    }
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
  } finally {
    $Bitmap.UnlockBits($data)
  }
}

foreach ($name in @('texture_00.png', 'texture_01.png')) {
  $source = [System.Drawing.Image]::FromFile((Join-Path $sourceDir $name))
  $texture = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($texture)
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($source, 0, 0, $Size, $Size)
    Reduce-RgbPrecision $texture $RgbBits
    $target = Join-Path $OutputDir ($name -replace '\.png$', "-$Size.png")
    $texture.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
    $transparent = $texture.GetPixel(0, 0).A
    Write-Output "$name $($Size)x$Size RGB$RgbBits $((Get-Item -LiteralPath $target).Length) bytes; corner alpha=$transparent"
  } finally {
    $graphics.Dispose()
    $texture.Dispose()
    $source.Dispose()
  }
}
