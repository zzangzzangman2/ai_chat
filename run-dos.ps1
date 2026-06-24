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
$localPortFile = Join-Path $PSScriptRoot ".local-server-port"
$runnerPidFile = Join-Path $PSScriptRoot ".dos-server-runner-pid"
$childPidFile = Join-Path $PSScriptRoot ".dos-server-child-pid"
$outLog = Join-Path $PSScriptRoot ".dos-next.out.log"
$errLog = Join-Path $PSScriptRoot ".dos-next.err.log"
$nextLockFile = Join-Path $PSScriptRoot ".next\dev\lock"

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

function Get-PortFromFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  try {
    $raw = (Get-Content -LiteralPath $Path -TotalCount 1).Trim()
    $port = [int]$raw
    if ($port -gt 0) { return $port }
  } catch {
    return 0
  }
  return 0
}

function Find-HealthyAppPort {
  $candidates = @()
  $candidates += Get-PortFromFile -Path $portFile
  $candidates += Get-PortFromFile -Path $localPortFile
  if ($env:PORT) {
    try { $candidates += [int]$env:PORT } catch {}
  }
  $candidates += 3000..3020

  foreach ($candidate in ($candidates | Where-Object { $_ -gt 0 } | Select-Object -Unique)) {
    if (Test-AppHealth -Port $candidate) { return $candidate }
  }
  return 0
}

function Wait-HealthyAppPort {
  param([int]$Seconds = 25)
  for ($i = 0; $i -lt $Seconds; $i++) {
    $candidate = Find-HealthyAppPort
    if ($candidate -gt 0) { return $candidate }
    Start-Sleep -Seconds 1
  }
  return 0
}

function Show-ServerLogs {
  if (Test-Path -LiteralPath $errLog) {
    Write-Host "Last error log lines:" -ForegroundColor Yellow
    Get-Content -LiteralPath $errLog -Tail 30
  }
  if (Test-Path -LiteralPath $outLog) {
    Write-Host "Last server log lines:" -ForegroundColor Yellow
    Get-Content -LiteralPath $outLog -Tail 20
  }
}

function Get-ProcessCommandLine {
  param([int]$ProcessId)
  try {
    $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if ($procInfo) { return [string]$procInfo.CommandLine }
  } catch {
    # ignore process lookup races
  }
  return ""
}

function Test-ProjectServerProcess {
  param([int]$ProcessId)
  $cmd = Get-ProcessCommandLine -ProcessId $ProcessId
  if (-not $cmd) { return $false }
  $rootPattern = [regex]::Escape($PSScriptRoot)
  if ($cmd -notmatch $rootPattern) { return $false }
  return $cmd -match "dos-client\\dos-server\.js|dos-client\\dos-chat\.js|next\\dist\\server\\lib\\start-server\.js|npm-cli\.js.*run dev|next dev"
}

function Test-PidFileServerProcess {
  param([int]$ProcessId)
  $cmd = Get-ProcessCommandLine -ProcessId $ProcessId
  if (-not $cmd) { return $false }
  if (Test-ProjectServerProcess -ProcessId $ProcessId) { return $true }
  return $cmd -match "npm\.cmd.*run dev.*--hostname 127\.0\.0\.1.*--port|next dev.*--hostname 127\.0\.0\.1.*--port"
}

function Stop-ProcessTree {
  param([int]$ProcessId)
  if (-not $ProcessId -or $ProcessId -eq $PID) { return $false }
  try {
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) { return $false }
    taskkill /PID $ProcessId /T /F 2>$null | Out-Null
    return $true
  } catch {
    return $false
  }
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
    if (Test-AppHealth -Port $Port) {
      return [pscustomobject]@{ Port = $Port; Started = $true }
    }
    if ($proc.HasExited) {
      $healthyPort = Wait-HealthyAppPort -Seconds 8
      if ($healthyPort -gt 0) {
        Write-Host "Using existing text-only internal server. Port: $healthyPort" -ForegroundColor Green
        return [pscustomobject]@{ Port = $healthyPort; Started = $false }
      }
      Write-Host "The internal server stopped while starting." -ForegroundColor Red
      Show-ServerLogs
      exit 1
    }
    if ($i -ge 3 -and (Test-Path -LiteralPath $nextLockFile)) {
      $healthyPort = Find-HealthyAppPort
      if ($healthyPort -gt 0 -and $healthyPort -ne $Port) {
        try { taskkill /PID $($proc.Id) /T /F 2>$null | Out-Null } catch {}
        Write-Host "Using existing text-only internal server. Port: $healthyPort" -ForegroundColor Green
        return [pscustomobject]@{ Port = $healthyPort; Started = $false }
      }
    }
    Start-Sleep -Seconds 1
  }

  Write-Host "The internal server did not become ready in time." -ForegroundColor Red
  Show-ServerLogs
  exit 1
}

function Stop-DosServerByPort {
  param([int]$Port)
  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

  $pids = @()
  if ($connections) {
    foreach ($owner in ($connections | Select-Object -ExpandProperty OwningProcess -Unique)) {
      if (Test-ProjectServerProcess -ProcessId $owner) { $pids += $owner }
    }
  }
  foreach ($pidFile in @($childPidFile, $runnerPidFile)) {
    if (Test-Path -LiteralPath $pidFile) {
      try {
        $pidFromFile = [int]((Get-Content -LiteralPath $pidFile -TotalCount 1).Trim())
        if (Test-PidFileServerProcess -ProcessId $pidFromFile) { $pids += $pidFromFile }
      } catch {
        # ignore bad pid file
      }
    }
  }

  foreach ($pidValue in ($pids | Select-Object -Unique)) {
    Stop-ProcessTree -ProcessId $pidValue | Out-Null
  }
  Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $runnerPidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $childPidFile -Force -ErrorAction SilentlyContinue
}

function Stop-ExistingDosInstance {
  $rootPattern = [regex]::Escape($PSScriptRoot)
  $targetPids = @()

  try {
    $targetPids += Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ProcessId -ne $PID -and
        [string]$_.CommandLine -match $rootPattern -and
        [string]$_.CommandLine -match "run-dos\.ps1|dos-client\\dos-server\.js|dos-client\\dos-chat\.js"
      } |
      Select-Object -ExpandProperty ProcessId
  } catch {
    # ignore process lookup races
  }

  $stopped = $false
  foreach ($targetPid in ($targetPids | Select-Object -Unique)) {
    if (Stop-ProcessTree -ProcessId $targetPid) { $stopped = $true }
  }

  foreach ($portCandidate in @(
    (Get-PortFromFile -Path $portFile),
    (Get-PortFromFile -Path $localPortFile),
    3000
  ) | Where-Object { $_ -gt 0 } | Select-Object -Unique) {
    Stop-DosServerByPort -Port $portCandidate
  }

  if ($stopped) {
    Write-Host "Previous ARCA DOS window/server was closed. Starting fresh..." -ForegroundColor Yellow
    Start-Sleep -Seconds 2
  }
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

if (-not $Check) {
  Stop-ExistingDosInstance
}

$startedByThisScript = $false
$port = Find-HealthyAppPort
if ($port -gt 0) {
  Write-Host "Using existing text-only internal server. Port: $port" -ForegroundColor Green
} else {
  if (Test-Path -LiteralPath $nextLockFile) {
    Write-Host "Existing Next dev server is starting. Waiting for it instead of opening another port..." -ForegroundColor Cyan
    $port = Wait-HealthyAppPort -Seconds 30
    if ($port -gt 0) {
      Write-Host "Using existing text-only internal server. Port: $port" -ForegroundColor Green
    } else {
      Write-Host "Next dev lock exists, but no healthy internal server responded." -ForegroundColor Red
      Write-Host "Close the other ARCA DOS/Next window and run this again." -ForegroundColor Yellow
      Show-ServerLogs
      exit 1
    }
  } else {
    $port = Find-FreePort
    $startResult = Start-DosServer -Port $port
    $port = [int]$startResult.Port
    $startedByThisScript = [bool]$startResult.Started
  }
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
