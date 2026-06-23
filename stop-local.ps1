param(
  [int]$Port = 0,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

$portFile = Join-Path $PSScriptRoot ".local-server-port"

if ($Port -le 0) {
  if (Test-Path -LiteralPath $portFile) {
    $savedPort = (Get-Content -LiteralPath $portFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $parsedPort = 0
    if ([int]::TryParse([string]$savedPort, [ref]$parsedPort) -and $parsedPort -gt 0) {
      $Port = $parsedPort
    }
  }

  if ($Port -le 0) {
    $Port = 3000
  }
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listeners) {
  Write-Host "Arca is not running on port $Port." -ForegroundColor Green
  if (Test-Path -LiteralPath $portFile) {
    Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
  }
  exit 0
}

$projectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([char]"\")
$stopped = 0

foreach ($processId in ($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if (-not $process) {
    continue
  }

  $commandLine = ""
  if ($process.CommandLine) {
    $commandLine = $process.CommandLine
  }

  $ownsThisApp = $commandLine -like "*$projectRoot*"
  if (-not $ownsThisApp -and -not $Force) {
    Write-Host "Port $Port is used by another process, so it was not stopped:" -ForegroundColor Yellow
    Write-Host "PID $processId $($process.Name)" -ForegroundColor Yellow
    Write-Host "Run stop-local.ps1 -Force only if you are sure this is the local chat app." -ForegroundColor Yellow
    continue
  }

  Stop-Process -Id $processId -Force
  $stopped += 1
  Write-Host "Stopped local Arca chat on port $Port. PID: $processId" -ForegroundColor Green
}

if ($stopped -eq 0) {
  exit 1
}

if (Test-Path -LiteralPath $portFile) {
  $savedPort = (Get-Content -LiteralPath $portFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ([string]$savedPort -eq [string]$Port) {
    Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
  }
}
