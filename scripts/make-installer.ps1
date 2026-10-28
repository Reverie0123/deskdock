# Builds DeskDock-Setup-<version>.exe: stages dist + production node_modules + resources + a portable node.exe,
# then compiles installer/deskdock.iss with Inno Setup 6. Run from the repo root after `npm run build` and `npm run build:native`.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$stage = Join-Path $root "build\stage"
$nodeExe = Join-Path $root "build\node\node.exe"
if (-not (Test-Path $nodeExe)) { throw "build\node\node.exe missing: download node-v22-win-x64.zip and copy node.exe there" }
if (-not (Test-Path "build\lang\ChineseSimplified.isl")) { throw "build\lang\ChineseSimplified.isl missing" }

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null

# production dependencies only
Copy-Item package.json, package-lock.json $stage
Push-Location $stage
try { npm ci --omit=dev --no-audit --no-fund --loglevel error --ignore-scripts } finally { Pop-Location }
Remove-Item (Join-Path $stage "package-lock.json") -Force

Copy-Item dist $stage\dist -Recurse
Copy-Item skills $stage\skills -Recurse
New-Item -ItemType Directory -Force $stage\resources | Out-Null
Copy-Item resources\deskdock-native.exe, resources\deskdock.ico, resources\icon.png, resources\panel.html, resources\ocr.ps1 $stage\resources
Copy-Item README.md, README.zh.md, LICENSE, PRIVACY.md, CHANGELOG.md, manifest.json $stage
Copy-Item $nodeExe $stage\node.exe

# launcher used by shortcuts, the installer and the user: "deskdock panel", "deskdock setup --remove"
"@echo off`r`n""%~dp0node.exe"" ""%~dp0dist\index.js"" %*" | Set-Content (Join-Path $stage "deskdock.cmd") -Encoding ASCII

$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 not found (winget install JRSoftware.InnoSetup --scope user)" }
# compile into a non-synced folder: OneDrive/Desktop sync locks the output while Inno updates its resources
$tmpOut = Join-Path $env:LOCALAPPDATA "deskdock\installer-out"
New-Item -ItemType Directory -Force $tmpOut | Out-Null
& $iscc /Q "/O$tmpOut" "installer\deskdock.iss"
if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }
New-Item -ItemType Directory -Force dist-installer | Out-Null
Copy-Item "$tmpOut\*.exe" dist-installer -Force
Get-ChildItem dist-installer\*.exe | Select-Object Name, @{n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } }
Get-FileHash dist-installer\*.exe -Algorithm SHA256 | Select-Object Hash
