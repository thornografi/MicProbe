$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
$outDir = Join-Path $repoRoot '.tmp\cloudflare-dev-assets'
$resolvedRepo = [System.IO.Path]::GetFullPath($repoRoot)
$resolvedOut = [System.IO.Path]::GetFullPath($outDir)

if (-not $resolvedOut.StartsWith($resolvedRepo + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside repository: $resolvedOut"
}

if (Test-Path -LiteralPath $resolvedOut) {
  Remove-Item -LiteralPath $resolvedOut -Recurse -Force
}

New-Item -ItemType Directory -Path $resolvedOut | Out-Null

$rootFiles = @(
  'index.html',
  'micprobe.html',
  'privacy.html',
  'terms.html'
)

foreach ($file in $rootFiles) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $resolvedOut $file)
}

$directories = @(
  'css',
  'js'
)

foreach ($directory in $directories) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $directory) -Destination (Join-Path $resolvedOut $directory) -Recurse
}

Write-Host "Cloudflare dev assets written to $resolvedOut"
