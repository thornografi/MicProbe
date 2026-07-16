param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSCommandPath
$Port = 8080
$Url = "http://localhost:$Port/"

function Test-HttpReady {
  try {
    $response = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Test-PortListening {
  try {
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return [bool]$connection
  } catch {
    $line = netstat -ano | Select-String -Pattern "TCP\s+.*:$Port\s+.*LISTENING"
    return [bool]$line
  }
}

function Open-MicProbe {
  if (-not $NoBrowser) {
    Start-Process $Url
  }
}

Write-Host '========================================'
Write-Host '  MicProbe - Otomatik Baslat'
Write-Host '========================================'
Write-Host ''

if (Test-HttpReady) {
  Write-Host "[OK] $Url zaten yanit veriyor."
  Write-Host '[*] Mevcut localhost kullaniliyor.'
  Open-MicProbe
  exit 0
}

if (Test-PortListening) {
  Write-Host "[OK] Port $Port zaten acik."
  Write-Host '[*] Yeni server baslatilmadi; mevcut localhost aciliyor.'
  Open-MicProbe
  exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error 'Node.js bulunamadi. MicProbe server baslatilamadi.'
  exit 1
}

Write-Host "[*] Port $Port bos. MicProbe server baslatiliyor..."

$oldPort = [Environment]::GetEnvironmentVariable('PORT', 'Process')
$oldStrictPort = [Environment]::GetEnvironmentVariable('MICPROBE_STRICT_PORT', 'Process')

try {
  $env:PORT = [string]$Port
  $env:MICPROBE_STRICT_PORT = '1'
  $process = Start-Process -FilePath $node.Source -ArgumentList 'server.js' -WorkingDirectory $Root -WindowStyle Hidden -PassThru
} finally {
  if ($null -eq $oldPort) {
    Remove-Item Env:PORT -ErrorAction SilentlyContinue
  } else {
    $env:PORT = $oldPort
  }

  if ($null -eq $oldStrictPort) {
    Remove-Item Env:MICPROBE_STRICT_PORT -ErrorAction SilentlyContinue
  } else {
    $env:MICPROBE_STRICT_PORT = $oldStrictPort
  }
}

Write-Host '[*] Server yaniti bekleniyor...'
for ($attempt = 1; $attempt -le 15; $attempt += 1) {
  Start-Sleep -Seconds 1

  if (Test-HttpReady) {
    Write-Host "[OK] MicProbe hazir: $Url"
    Open-MicProbe
    exit 0
  }

  if ($process.HasExited) {
    Write-Error "MicProbe server erken kapandi. ExitCode=$($process.ExitCode)"
    exit 1
  }
}

if (Test-PortListening) {
  Write-Warning "Port $Port acik, fakat HTTP yaniti henuz dogrulanamadi."
  Write-Host "[*] Yeni port denenmedi; $Url aciliyor."
  Open-MicProbe
  exit 0
}

Write-Error "MicProbe $Url uzerinden baslatilamadi. Yeni localhost portu denenmedi."
exit 1
