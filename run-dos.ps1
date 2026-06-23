param(
  [switch]$Check
)

$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
  chcp 65001 | Out-Null
} catch {
  # ignore console encoding failures
}

$portFile = Join-Path $PSScriptRoot ".dos-server-port"
$runnerPidFile = Join-Path $PSScriptRoot ".dos-server-runner-pid"
$childPidFile = Join-Path $PSScriptRoot ".dos-server-child-pid"
$outLog = Join-Path $PSScriptRoot ".dos-next.out.log"
$errLog = Join-Path $PSScriptRoot ".dos-next.err.log"

function Add-LocalNodeToPath {
  $portableNodeDir = Join-Path $PSScriptRoot ".codex-tools\node20\node-v20.19.5-win-x64"
  $localNodeDir = Join-Path $PSScriptRoot "node_modules\node\bin"
  $codexNodeDir = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"

  if (Test-Path -LiteralPath (Join-Path $portableNodeDir "node.exe")) {
    $env:PATH = "$portableNodeDir;$env:PATH"
    return
  }
  if (Test-Path -LiteralPath (Join-Path $localNodeDir "node.exe")) {
    $env:PATH = "$localNodeDir;$env:PATH"
    return
  }
  if (Test-Path -LiteralPath (Join-Path $codexNodeDir "node.exe")) {
    $env:PATH = "$codexNodeDir;$env:PATH"
  }
}

function Assert-Node20 {
  try {
    $nodeVersion = (& node -v) -replace "^v", ""
    $nodeMajor = [int](($nodeVersion -split "\.")[0])
    if ($nodeMajor -lt 20 -or $nodeMajor -gt 22) {
      Write-Host "Node.js 20-22 is required. Current: v$nodeVersion" -ForegroundColor Red
      Write-Host "Bundled Node 20 was not found. Check that .codex-tools was moved with this folder." -ForegroundColor Yellow
      exit 1
    }
  } catch {
    Write-Host "Node.js was not found. Run this from the same folder as run-local.ps1." -ForegroundColor Red
    exit 1
  }
}

function Find-NpmCommand {
  $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cmd = Get-Command npm -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return ""
}

function Invoke-Npm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $npm = Find-NpmCommand
  if (-not $npm) {
    Write-Host "npm was not found." -ForegroundColor Red
    exit 1
  }
  & $npm @Arguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Test-DependenciesReady {
  $requiredPaths = @(
    "node_modules\next\dist\bin\next",
    "node_modules\react",
    "node_modules\react-dom",
    "node_modules\@google\genai",
    "node_modules\better-sqlite3"
  )
  foreach ($path in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $path)) { return $false }
  }
  return $true
}

function Test-BetterSqliteReady {
  $testScript = "try { require('better-sqlite3'); process.exit(0); } catch (e) { process.exit(1); }"
  & node -e $testScript | Out-Null
  return $LASTEXITCODE -eq 0
}

function Test-PortAvailable {
  param([int]$Port)
  $existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($existing) { return $false }

  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener) { $listener.Stop() }
  }
}

function Test-AppHealth {
  param([int]$Port)
  try {
    $res = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/auth/me" -TimeoutSec 2
    return $res.StatusCode -ge 200 -and $res.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Find-FreePort {
  for ($p = 3000; $p -le 3020; $p++) {
    if (Test-PortAvailable -Port $p) { return $p }
  }
  Write-Host "No free port was found between 3000 and 3020." -ForegroundColor Red
  exit 1
}

function Get-SavedPort {
  if (-not (Test-Path -LiteralPath $portFile)) { return 0 }
  try {
    $raw = (Get-Content -LiteralPath $portFile -TotalCount 1).Trim()
    $port = [int]$raw
    if ($port -gt 0) { return $port }
  } catch {
    return 0
  }
  return 0
}

function Start-DosServer {
  param([int]$Port)
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Write-Host "node was not found, so the internal server cannot start." -ForegroundColor Red
    exit 1
  }

  Write-Host "Starting text-only internal server. Port: $Port" -ForegroundColor Cyan
  $env:PORT = "$Port"
  $runner = Join-Path $PSScriptRoot "dos-client\dos-server.js"
  $args = @($runner, "--port", "$Port", "--parentPid", "$PID", "--out", $outLog, "--err", $errLog)
  $proc = Start-Process -FilePath $nodeCmd.Source `
    -ArgumentList $args `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -PassThru
  Set-Content -LiteralPath $portFile -Value "$Port" -Encoding ASCII
  Set-Content -LiteralPath $runnerPidFile -Value "$($proc.Id)" -Encoding ASCII

  for ($i = 0; $i -lt 90; $i++) {
    if (Test-AppHealth -Port $Port) { return }
    Start-Sleep -Seconds 1
  }

  Write-Host "The internal server did not become ready in time." -ForegroundColor Red
  if (Test-Path -LiteralPath $errLog) {
    Write-Host "Last error log lines:" -ForegroundColor Yellow
    Get-Content -LiteralPath $errLog -Tail 30
  }
  exit 1
}

function Stop-DosServerByPort {
  param([int]$Port)
  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

  $pids = @()
  if ($connections) {
    $pids += $connections | Select-Object -ExpandProperty OwningProcess -Unique
  }
  foreach ($pidFile in @($childPidFile, $runnerPidFile)) {
    if (Test-Path -LiteralPath $pidFile) {
      try {
        $pids += [int]((Get-Content -LiteralPath $pidFile -TotalCount 1).Trim())
      } catch {
        # ignore bad pid file
      }
    }
  }

  foreach ($pidValue in ($pids | Select-Object -Unique)) {
    if (-not $pidValue) { continue }
    try {
      $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
      if ($proc) {
        taskkill /PID $pidValue /T /F 2>$null | Out-Null
      }
    } catch {
      # ignore stop failures during automatic cleanup
    }
  }
  Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $runnerPidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $childPidFile -Force -ErrorAction SilentlyContinue
}

Add-LocalNodeToPath
Assert-Node20

if (-not (Test-Path -LiteralPath ".env.local")) {
  Write-Host ".env.local is missing. Check Vertex AI settings." -ForegroundColor Yellow
}

if (-not (Test-DependenciesReady)) {
  Write-Host "Installing required modules..." -ForegroundColor Cyan
  Invoke-Npm install
}

if (-not (Test-BetterSqliteReady)) {
  Write-Host "Preparing SQLite module for this Node runtime..." -ForegroundColor Cyan
  Invoke-Npm rebuild better-sqlite3
}

$startedByThisScript = $false
$port = Get-SavedPort
if ($port -gt 0 -and (Test-AppHealth -Port $port)) {
  Write-Host "Using existing text-only internal server. Port: $port" -ForegroundColor Green
  $startedByThisScript = $true
} else {
  $port = Find-FreePort
  Start-DosServer -Port $port
  $startedByThisScript = $true
}

try {
  if ($Check) {
    & node (Join-Path $PSScriptRoot "dos-client\dos-chat.js") --port $port --check
    $exitCode = $LASTEXITCODE
  } else {
    & node (Join-Path $PSScriptRoot "dos-client\dos-chat.js") --port $port
    $exitCode = $LASTEXITCODE
  }
} finally {
  if ($startedByThisScript) {
    Stop-DosServerByPort -Port $port
  }
}

exit $exitCode
