param([Parameter(Mandatory = $true)][string]$ResultsPath)

$ErrorActionPreference = 'Stop'
$lines = @('## Atualização das versões publicadas', '')
if (Test-Path -LiteralPath $ResultsPath) {
    $results = @(Get-Content -LiteralPath $ResultsPath -Raw | ConvertFrom-Json)
    $failures = @($results | Where-Object { $_.status -ne 0 })
    $lines += "Versões verificadas: $($results.Count); falhas: $($failures.Count)."
    foreach ($result in $failures) {
        $lines += @('', "### npm $($result.version) → $($result.candidateVersion)")
        $outputLines = @(([string]$result.output -split '\r?\n') | Where-Object { $_.Trim() })
        $errors = @($outputLines | Where-Object { $_ -match '(?i)error|ERR_|EPERM|EACCES|ENOENT|Assertion|timed?\s*out' })
        if ($errors.Count -eq 0) { $errors = $outputLines }
        $detail = ($errors | Select-Object -Last 12) -join "`n"
        if (-not $detail) { $detail = "Processo encerrado sem saída; status: $($result.status)." }
        if ($detail.Length -gt 4000) { $detail = $detail.Substring(0, 4000) + '…' }
        $lines += @('<pre>', [System.Net.WebUtility]::HtmlEncode($detail), '</pre>')
    }
} else {
    $lines += 'Nenhum resultado de versão foi gravado; a execução terminou antes de concluir um cenário.'
}
$lines += @('', 'Os resultados completos e as saídas de cada versão estão no artefato verification deste job.')
$report = ($lines -join "`n") + "`n"
New-Item -ItemType Directory -Path '.test-output' -Force | Out-Null
$report | Set-Content -LiteralPath '.test-output/published-update-summary.md' -Encoding utf8
if ($env:GITHUB_STEP_SUMMARY) { $report | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8 }
