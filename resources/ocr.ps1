# DeskDock OCR worker (Windows PowerShell 5.1). Reads one PNG path per line from stdin, writes one JSON line per request.
# Uses the Windows.Media.Ocr engine that ships with Windows 10/11 (offline, no install).
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $t) { $m = $asTaskGeneric.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(); $task.Result }

$langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
$engines = @{}
function GetEngine([string]$tag) {
  if ($tag -and $langs -contains $tag) {
    if (-not $engines[$tag]) { $engines[$tag] = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($tag)) }
    return $engines[$tag]
  }
  if (-not $engines["_"]) { $engines["_"] = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  return $engines["_"]
}
$ready = @{ ready = $true; languages = $langs } | ConvertTo-Json -Compress
[Console]::Out.WriteLine($ready); [Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq "") { continue }
  try {
    $req = $line | ConvertFrom-Json
    $engine = GetEngine $req.lang
    if (-not $engine) { throw "no OCR language pack installed" }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($req.path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $stream.Dispose(); $bitmap.Dispose()
    $lines = New-Object System.Collections.ArrayList
    foreach ($l in $result.Lines) {
      $x0 = [double]::MaxValue; $y0 = [double]::MaxValue; $x1 = 0.0; $y1 = 0.0
      $words = New-Object System.Collections.ArrayList
      foreach ($w in $l.Words) {
        $r = $w.BoundingRect
        if ($r.X -lt $x0) { $x0 = $r.X }; if ($r.Y -lt $y0) { $y0 = $r.Y }
        if ($r.X + $r.Width -gt $x1) { $x1 = $r.X + $r.Width }; if ($r.Y + $r.Height -gt $y1) { $y1 = $r.Y + $r.Height }
        [void]$words.Add(@{ t = $w.Text; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height })
      }
      [void]$lines.Add(@{ text = $l.Text; x = [int]$x0; y = [int]$y0; w = [int]($x1 - $x0); h = [int]($y1 - $y0); words = $words })
    }
    $out = @{ id = $req.id; ok = $true; ms = $sw.ElapsedMilliseconds; lang = $engine.RecognizerLanguage.LanguageTag; angle = $result.TextAngle; lines = $lines } | ConvertTo-Json -Compress -Depth 6
  } catch {
    $e = $_.Exception; $msgs = @()
    while ($e) { $msgs += $e.Message; if ($e -is [System.AggregateException] -and $e.InnerExceptions.Count -gt 0) { $e = $e.InnerExceptions[0] } else { $e = $e.InnerException } }
    $out = @{ id = $req.id; ok = $false; error = ($msgs -join " <- "); path = $req.path } | ConvertTo-Json -Compress
  }
  [Console]::Out.WriteLine($out); [Console]::Out.Flush()
}
