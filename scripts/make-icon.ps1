# Draws the DeskDock icon (a dock: a base with three ports) with System.Drawing and writes
# resources/deskdock.ico (PNG-compressed entries: 256/48/32/16) and resources/icon.png (256).
param([string]$OutDir = (Join-Path $PSScriptRoot "..\resources"))
Add-Type -AssemblyName System.Drawing
$OutDir = (Resolve-Path $OutDir).Path

function Draw-Icon([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"; $g.Clear([System.Drawing.Color]::Transparent)
  $pad = [int]($size * 0.06); $r = [int]($size * 0.22)
  # rounded square background
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $w = $size - 2 * $pad; $x = $pad; $y = $pad
  $path.AddArc($x, $y, $r, $r, 180, 90); $path.AddArc($x + $w - $r, $y, $r, $r, 270, 90)
  $path.AddArc($x + $w - $r, $y + $w - $r, $r, $r, 0, 90); $path.AddArc($x, $y + $w - $r, $r, $r, 90, 90); $path.CloseFigure()
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 30, 64, 175))
  $g.FillPath($bg, $path)
  # dock base
  $white = [System.Drawing.Brushes]::White
  $baseH = [int]($size * 0.14); $baseY = [int]($size * 0.62); $baseX = [int]($size * 0.2); $baseW = $size - 2 * $baseX
  $g.FillRectangle($white, $baseX, $baseY, $baseW, $baseH)
  # three ports standing on the base
  $portW = [int]($size * 0.12); $portH = [int]($size * 0.24); $gap = [int](($baseW - 3 * $portW) / 2)
  for ($i = 0; $i -lt 3; $i++) { $px = $baseX + $i * ($portW + $gap); $g.FillRectangle($white, $px, $baseY - $portH, $portW, $portH) }
  # a plug above the middle port (the AI connecting)
  $plugW = [int]($size * 0.2); $plugH = [int]($size * 0.1); $plugX = [int](($size - $plugW) / 2); $plugY = [int]($size * 0.2)
  $accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 125, 211, 252))
  $g.FillRectangle($accent, $plugX, $plugY, $plugW, $plugH)
  $g.Dispose()
  return $bmp
}
function PngBytes($bmp) { $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); return ,[byte[]]$ms.ToArray() }

$sizes = 256, 48, 32, 16
$entries = New-Object System.Collections.ArrayList
foreach ($s in $sizes) { $b = Draw-Icon $s; [void]$entries.Add(@{ size = $s; png = [byte[]](PngBytes $b) }); $b.Dispose() }
$big = Draw-Icon 512; $big.Save((Join-Path $OutDir "icon.png"), [System.Drawing.Imaging.ImageFormat]::Png); $big.Dispose()

# ICO container with PNG-compressed images
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
  $dim = if ($e.size -ge 256) { 0 } else { $e.size }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$e.png.Length); $bw.Write([uint32]$offset)
  $offset += $e.png.Length
}
foreach ($e in $entries) { $bw.Write([byte[]]$e.png) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $OutDir "deskdock.ico"), $ms.ToArray())
"wrote " + (Join-Path $OutDir "deskdock.ico") + " (" + $ms.Length + " bytes) and icon.png"
