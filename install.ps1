# DeskDock one-line installer for Windows 10/11.
#   irm https://raw.githubusercontent.com/Reverie0123/deskdock/main/install.ps1 | iex
# Finds Node.js; if missing, downloads a portable Node (no admin, no system changes) into %LOCALAPPDATA%\deskdock\node,
# then installs the deskdock package there and runs `deskdock setup`. Chinese mirrors are used when they answer faster.
$ErrorActionPreference = "Stop"
$zh = (Get-Culture).Name -like "zh*"
function Say($en, $cn) { Write-Host ($(if ($zh) { $cn } else { $en })) }

$home_ = Join-Path $env:LOCALAPPDATA "deskdock"
$nodeDir = Join-Path $home_ "node"
New-Item -ItemType Directory -Force $home_ | Out-Null

function NodeOk($exe) { try { $v = & $exe -v 2>$null; return ($v -match "^v(\d+)" -and [int]$Matches[1] -ge 20) } catch { return $false } }

$node = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($sys -and (NodeOk $sys.Source)) { $node = $sys.Source; Say "Using Node.js $(& $node -v) from PATH" "使用系统已装的 Node.js $(& $node -v)" }
elseif (Test-Path (Join-Path $nodeDir "node.exe")) { $node = Join-Path $nodeDir "node.exe"; Say "Using portable Node.js in $nodeDir" "使用 $nodeDir 里的便携版 Node.js" }
else {
  Say "Node.js 20+ not found; downloading a portable copy (about 30 MB)..." "没有找到 Node.js 20 以上版本，下载便携版（约 30 MB）..."
  $ver = "v22.12.0"
  $mirrors = @("https://npmmirror.com/mirrors/node/$ver/node-$ver-win-x64.zip", "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip")
  $zip = Join-Path $env:TEMP "node-$ver-win-x64.zip"
  $got = $false
  foreach ($u in $mirrors) { try { Invoke-WebRequest $u -OutFile $zip -TimeoutSec 120; $got = $true; break } catch { Say "  $u failed, trying next" "  $u 失败，换下一个" } }
  if (-not $got) { throw "download failed" }
  Expand-Archive $zip -DestinationPath $env:TEMP -Force
  Move-Item (Join-Path $env:TEMP "node-$ver-win-x64") $nodeDir -Force
  Remove-Item $zip -Force
  $node = Join-Path $nodeDir "node.exe"
}

$npm = Join-Path (Split-Path $node) "npm.cmd"
if (-not (Test-Path $npm)) { $npm = "npm" }
$registry = "https://registry.npmjs.org"
try { $t = Measure-Command { Invoke-WebRequest "https://registry.npmmirror.com/deskdock" -TimeoutSec 5 | Out-Null }; if ($t.TotalSeconds -lt 3) { $registry = "https://registry.npmmirror.com" } } catch {}
Say "Installing deskdock from $registry ..." "从 $registry 安装 deskdock ..."
$pkgDir = Join-Path $home_ "app"
New-Item -ItemType Directory -Force $pkgDir | Out-Null
Push-Location $pkgDir
try {
  if (-not (Test-Path "package.json")) { '{"name":"deskdock-install","private":true}' | Set-Content package.json }
  & $npm install deskdock@latest --registry $registry --no-audit --no-fund --loglevel error
} finally { Pop-Location }

$entry = Join-Path $pkgDir "node_modules\deskdock\dist\index.js"
if (-not (Test-Path $entry)) { throw "install failed: $entry missing" }
# a tiny launcher so `deskdock` works from any shell of this user
$bin = Join-Path $home_ "bin"; New-Item -ItemType Directory -Force $bin | Out-Null
"@echo off`r`n""$node"" ""$entry"" %*" | Set-Content (Join-Path $bin "deskdock.cmd") -Encoding ASCII
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$bin*") { [Environment]::SetEnvironmentVariable("Path", "$userPath;$bin", "User"); Say "Added $bin to your user PATH (new terminals only)" "已把 $bin 加进你的用户 PATH（新开的终端才生效）" }

Say "Writing DeskDock into your AI clients..." "把 DeskDock 写进你的 AI 客户端配置..."
& $node $entry setup
Say "`nDone. Restart your AI client, then try: 'list my windows'. Control panel: deskdock panel" "`n完成。重启你的 AI 客户端，试试说「列出我的窗口」。控制面板：deskdock panel"
