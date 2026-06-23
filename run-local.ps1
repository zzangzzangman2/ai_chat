$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

$portFile = Join-Path $PSScriptRoot ".local-server-port"

function Save-LocalServerPort {
  param([int]$Port)

  Set-Content -LiteralPath $portFile -Value "$Port" -Encoding ASCII
}

if (-not (Test-Path -LiteralPath ".env.local")) {
  Write-Host ".env.local file is missing. Add Vertex AI ADC settings before chatting." -ForegroundColor Yellow
  Write-Host "Required: GOOGLE_GENAI_USE_VERTEXAI=true, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION" -ForegroundColor Yellow
}

$portableNodeDir = Join-Path $PSScriptRoot ".codex-tools\node20\node-v20.19.5-win-x64"
$localNodeDir = Join-Path $PSScriptRoot "node_modules\node\bin"
if (Test-Path -LiteralPath (Join-Path $portableNodeDir "node.exe")) {
  $env:PATH = "$portableNodeDir;$env:PATH"
} elseif (Test-Path -LiteralPath (Join-Path $localNodeDir "node.exe")) {
  $env:PATH = "$localNodeDir;$env:PATH"
} else {
  $codexNodeDir = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
  if (Test-Path -LiteralPath (Join-Path $codexNodeDir "node.exe")) {
    $env:PATH = "$codexNodeDir;$env:PATH"
  }
}

try {
  $nodeVersion = (& node -v) -replace "^v", ""
  $nodeMajor = [int](($nodeVersion -split "\.")[0])
  if ($nodeMajor -lt 20) {
    Write-Host "Node.js 20 or newer is required. Current version: v$nodeVersion" -ForegroundColor Red
    Write-Host "Install Node.js LTS 20+ from https://nodejs.org, then run this file again." -ForegroundColor Yellow
    exit 1
  }
} catch {
  Write-Host "Node.js was not found. Install Node.js LTS 20+ from https://nodejs.org." -ForegroundColor Red
  exit 1
}

function Test-BetterSqliteReady {
  $testScript = "try { require('better-sqlite3'); process.exit(0); } catch (e) { process.exit(1); }"
  & node -e $testScript | Out-Null
  return $LASTEXITCODE -eq 0
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
    if (-not (Test-Path -LiteralPath $path)) {
      return $false
    }
  }

  return $true
}

function Test-PortAvailable {
  param([int]$Port)

  $existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($existing) {
    return $false
  }

  $listeners = @()
  try {
    foreach ($addr in @([System.Net.IPAddress]::Loopback, [System.Net.IPAddress]::IPv6Loopback)) {
      $listener = [System.Net.Sockets.TcpListener]::new($addr, $Port)
      $listener.Start()
      $listeners += $listener
    }
    return $true
  } catch {
    return $false
  } finally {
    foreach ($listener in $listeners) {
      $listener.Stop()
    }
  }
}

function Test-LocalAppRunning {
  param([int]$Port)

  try {
    $res = Invoke-WebRequest -UseBasicParsing "http://localhost:$Port" -TimeoutSec 2
    return $res.StatusCode -ge 200 -and $res.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Get-EnvValue {
  param([string]$Name)

  if (-not (Test-Path -LiteralPath ".env.local")) {
    return ""
  }

  $line = Get-Content -LiteralPath ".env.local" |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
    Select-Object -First 1

  if (-not $line) {
    return ""
  }

  $idx = $line.IndexOf("=")
  if ($idx -lt 0) {
    return ""
  }

  return $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
}

function Test-Truthy {
  param([string]$Value)

  $raw = ""
  if ($null -ne $Value) {
    $raw = $Value
  }
  $v = $raw.Trim().ToLowerInvariant()
  return $v -eq "1" -or $v -eq "true" -or $v -eq "yes" -or $v -eq "on"
}

function Find-NpmCommand {
  $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  $cmd = Get-Command npm -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  return ""
}

function Find-GcloudCommand {
  $cmd = Get-Command gcloud -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"),
    (Join-Path $env:ProgramFiles "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd")
  )

  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      return $path
    }
  }

  return ""
}

function Invoke-Npm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  $npm = Find-NpmCommand
  if (-not $npm) {
    Write-Host "npm was not found in PATH." -ForegroundColor Red
    Write-Host "Install Node.js LTS 20+ from https://nodejs.org, then run this file again." -ForegroundColor Yellow
    exit 1
  }

  & $npm @Arguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

function Start-NextDev {
  $npm = Find-NpmCommand
  if ($npm) {
    & $npm run dev
    exit $LASTEXITCODE
  }

  $nextBin = Join-Path $PSScriptRoot "node_modules\next\dist\bin\next"
  if (Test-Path -LiteralPath $nextBin) {
    Write-Host "npm was not found; starting Next.js directly from node_modules." -ForegroundColor Yellow
    & node $nextBin dev --webpack
    exit $LASTEXITCODE
  }

  Write-Host "npm was not found and Next.js is not available in node_modules." -ForegroundColor Red
  Write-Host "Install Node.js LTS 20+ from https://nodejs.org, then run npm install in this folder." -ForegroundColor Yellow
  exit 1
}

function Test-VertexAdcReady {
  $useVertex = Test-Truthy (Get-EnvValue "GOOGLE_GENAI_USE_VERTEXAI")
  if (-not $useVertex) {
    return
  }

  $project = Get-EnvValue "GOOGLE_CLOUD_PROJECT"
  if (-not $project) {
    Write-Host "GOOGLE_GENAI_USE_VERTEXAI=true, but GOOGLE_CLOUD_PROJECT is missing in .env.local." -ForegroundColor Yellow
  }

  $adcPath = $env:GOOGLE_APPLICATION_CREDENTIALS
  if (-not $adcPath) {
    $adcPath = Join-Path $env:APPDATA "gcloud\application_default_credentials.json"
  }

  if (Test-Path -LiteralPath $adcPath) {
    return
  }

  $gcloud = Find-GcloudCommand
  if ($gcloud) {
    Write-Host "Vertex AI is enabled, but ADC credentials were not found yet." -ForegroundColor Yellow
    Write-Host "Run: gcloud auth application-default login" -ForegroundColor Yellow
    if ($project) {
      Write-Host "Then run: gcloud auth application-default set-quota-project $project" -ForegroundColor Yellow
    }
  } else {
    Write-Host "Vertex AI is enabled, but Google Cloud CLI and ADC credentials were not found." -ForegroundColor Yellow
    Write-Host "Install Google Cloud CLI, then run: gcloud auth application-default login" -ForegroundColor Yellow
    if ($project) {
      Write-Host "Then run: gcloud auth application-default set-quota-project $project" -ForegroundColor Yellow
    }
  }
}

if (-not (Test-DependenciesReady)) {
  Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
  Invoke-Npm install
}

if (-not (Test-BetterSqliteReady)) {
  Write-Host "Preparing SQLite native module for this Windows/Node runtime..." -ForegroundColor Cyan
  Invoke-Npm rebuild better-sqlite3
}

Test-VertexAdcReady

$port = 3000
if (-not (Test-PortAvailable -Port $port) -and (Test-LocalAppRunning -Port $port)) {
  $url = "http://localhost:$port"
  Save-LocalServerPort -Port $port
  Write-Host "Arca is already running at $url" -ForegroundColor Green
  Write-Host "To stop it, run stop-local.ps1 in this folder." -ForegroundColor Yellow
  if ($env:ARCA_NO_BROWSER -ne "1") {
    Start-Process $url
  }
  exit 0
}

while (-not (Test-PortAvailable -Port $port)) {
  $port += 1
}

$url = "http://localhost:$port"
Save-LocalServerPort -Port $port
Write-Host "Starting local Arca chat at $url" -ForegroundColor Green
Write-Host "Keep this window open while chatting. To stop it later, close this window or run stop-local.ps1." -ForegroundColor Yellow
if ($env:ARCA_NO_BROWSER -ne "1") {
  Start-Process $url
}

$env:PORT = "$port"
Start-NextDev
