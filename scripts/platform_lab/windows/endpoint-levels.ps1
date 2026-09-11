param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    $levelConfig = Get-Content -LiteralPath $ConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
    Add-Type -Path (Join-Path $PSScriptRoot 'EndpointLevels.cs')
    switch ($levelConfig.action) {
        'list' { [MicProbeLab.EndpointLevels]::List() }
        'self-test' { [MicProbeLab.EndpointLevels]::SelfTest() }
        'watch' {
            if (-not $levelConfig.runId -or -not $levelConfig.endpointId -or $levelConfig.maxSeconds -lt 1 -or $levelConfig.maxSeconds -gt 180) { throw 'Invalid observer configuration' }
            [MicProbeLab.EndpointLevels]::Watch($levelConfig.runId, $levelConfig.endpointId, $levelConfig.maxSeconds)
        }
        default { throw 'Unknown observer action' }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
