param(
  [string]$Repository = 'Leokings/liquidity-arena',
  [string]$AccountName = 'liquidity-arena-v7-keeper'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$genlayer = Join-Path $projectRoot 'node_modules/.bin/genlayer.cmd'
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temporaryDirectory = [IO.Path]::GetFullPath((Join-Path $temporaryRoot (
  'liquidity-arena-v7-keeper-' + [Guid]::NewGuid().ToString('N')
)))
if (-not $temporaryDirectory.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Temporary keystore directory escaped the Windows temporary directory.'
}
$null = New-Item -ItemType Directory -Path $temporaryDirectory
$temporaryPath = Join-Path $temporaryDirectory 'keeper.json'

function Assert-NativeSuccess {
  param([string]$Operation)

  if ($LASTEXITCODE -ne 0) {
    throw "$Operation failed with exit code $LASTEXITCODE."
  }
}

try {
  Write-Host 'Create a dedicated scheduler password. It is hidden while you type.' -ForegroundColor Cyan
  $first = Read-Host 'Keeper password' -AsSecureString
  $second = Read-Host 'Confirm keeper password' -AsSecureString
  $password = ConvertFrom-SecureString $first -AsPlainText
  $confirmation = ConvertFrom-SecureString $second -AsPlainText
  if ($password.Length -lt 16) { throw 'Use at least 16 characters.' }
  if ($password -cne $confirmation) { throw 'The passwords did not match.' }

  & $genlayer account create --name $AccountName --password $password --no-set-active | Out-Null
  Assert-NativeSuccess 'Creating the keeper account'
  & $genlayer account export --account $AccountName --output $temporaryPath `
    --password $password --source-password $password | Out-Null
  Assert-NativeSuccess 'Exporting the encrypted keeper keystore'
  if (-not (Test-Path -LiteralPath $temporaryPath) -or (Get-Item -LiteralPath $temporaryPath).Length -eq 0) {
    throw 'The exported keeper keystore is missing or empty.'
  }
  $keystore = Get-Content -LiteralPath $temporaryPath -Raw | ConvertFrom-Json
  if ($null -eq $keystore.crypto -and $null -eq $keystore.Crypto) {
    throw 'The exported keeper file is not an encrypted keystore.'
  }
  & $genlayer account unlock --account $AccountName --password $password | Out-Null
  Assert-NativeSuccess 'Unlocking the keeper account'

  $accountOutput = (& $genlayer account show --account $AccountName 2>&1 | Out-String)
  Assert-NativeSuccess 'Reading the keeper address'
  $match = [regex]::Match($accountOutput, '0x[0-9a-fA-F]{40}')
  if (-not $match.Success) { throw 'The new keeper address could not be read.' }
  $keeperAddress = $match.Value.ToLowerInvariant()
  $keystoreBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($temporaryPath))

  $password | gh secret set V7_KEEPER_KEYSTORE_PASSWORD --repo $Repository `
    --env 'studionet-keeper'
  Assert-NativeSuccess 'Uploading the encrypted-keystore password secret'
  $keystoreBase64 | gh secret set V7_KEEPER_KEYSTORE_B64 --repo $Repository `
    --env 'studionet-keeper'
  Assert-NativeSuccess 'Uploading the encrypted keeper keystore secret'
  gh variable set V7_CONTRACT_ADDRESS --repo $Repository `
    --body '0xb2ae59aE641f571726Ae81E30080f8c2192b15EF' | Out-Null
  Assert-NativeSuccess 'Setting the V7 contract variable'
  gh variable set V7_OWNER_ADDRESS --repo $Repository `
    --body '0x797d3b25fb2cca0ff93f60df1910267f3822d655' | Out-Null
  Assert-NativeSuccess 'Setting the V7 owner variable'
  gh variable set V7_KEEPER_ADDRESS --repo $Repository --body $keeperAddress | Out-Null
  Assert-NativeSuccess 'Setting the V7 keeper variable'
  gh variable set V7_TREASURY_ADDRESS --repo $Repository `
    --body '0x797d3b25fb2cca0ff93f60df1910267f3822d655' | Out-Null
  Assert-NativeSuccess 'Setting the V7 treasury variable'

  Write-Host "Keeper ready: $keeperAddress" -ForegroundColor Green
  Write-Host 'Return to Codex; the owner will rotate V7 to this limited address.' -ForegroundColor Green
} finally {
  $password = $null
  $confirmation = $null
  $keystore = $null
  $keystoreBase64 = $null
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}

Read-Host 'Press Enter to close this window'
