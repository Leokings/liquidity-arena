param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^0x[0-9a-fA-F]{40}$')]
  [string]$ContractAddress,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, [long]::MaxValue)]
  [long]$EpochEndTimestamp
)

$ErrorActionPreference = 'Stop'
$wagerOpens = [DateTimeOffset]::FromUnixTimeSeconds($EpochEndTimestamp - 2400)
$wagerCloses = [DateTimeOffset]::FromUnixTimeSeconds($EpochEndTimestamp - 1200)
$submitAfter = $wagerOpens.AddSeconds(10)

while ([DateTimeOffset]::UtcNow -lt $submitAfter) {
  $remaining = [Math]::Ceiling(($submitAfter - [DateTimeOffset]::UtcNow).TotalSeconds)
  Start-Sleep -Seconds ([Math]::Max(1, [Math]::Min(30, $remaining)))
}

if ([DateTimeOffset]::UtcNow -ge $wagerCloses) {
  throw 'The V7 canary wagering window closed before the runner started.'
}

$env:V7_CONTRACT_ADDRESS = $ContractAddress
$env:V7_CANARY_EPOCH_END = $EpochEndTimestamp.ToString([Globalization.CultureInfo]::InvariantCulture)

& node scripts/v7-canary-wagers.mjs
if ($LASTEXITCODE -ne 0) {
  throw "The V7 canary wager runner exited with status $LASTEXITCODE."
}
