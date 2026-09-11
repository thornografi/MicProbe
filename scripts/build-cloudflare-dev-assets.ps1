# Compatibility entry point for existing local launchers; npm owns the build.
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "MicProbe build failed ($LASTEXITCODE)" }
} finally { Pop-Location }
