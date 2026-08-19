param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^0x[0-9a-fA-F]{40}$')]
  [string]$ContractAddress,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, [long]::MaxValue)]
  [long]$EpochEndTimestamp
)

$ErrorActionPreference = 'Stop'
$submitAfter = [DateTimeOffset]::FromUnixTimeSeconds($EpochEndTimestamp + 125)

while ([DateTimeOffset]::UtcNow -lt $submitAfter) {
  $remaining = [Math]::Ceiling(($submitAfter - [DateTimeOffset]::UtcNow).TotalSeconds)
  Start-Sleep -Seconds ([Math]::Max(1, [Math]::Min(30, $remaining)))
}

$env:V7_CONTRACT_ADDRESS = $ContractAddress
$env:V7_CANARY_EPOCH_END = $EpochEndTimestamp.ToString([Globalization.CultureInfo]::InvariantCulture)

& node scripts/v7-canary-settle.mjs
if ($LASTEXITCODE -ne 0) {
  throw "The V7 settlement canary exited with status $LASTEXITCODE."
}
