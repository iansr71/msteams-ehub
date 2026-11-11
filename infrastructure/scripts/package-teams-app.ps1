<#
.SYNOPSIS
Validates and builds the Teams app package for an environment, optionally uploading it to the
environment's `releases` container.

.DESCRIPTION
Needs in the .env file: EHUB_TEAMS_APP_ID, EHUB_TEAMS_DEVELOPER_NAME, EHUB_TEAMS_WEBSITE_URL,
EHUB_TEAMS_PRIVACY_URL, EHUB_TEAMS_TERMS_URL (and EHUB_BOT_CLIENT_ID).
#>
param(
  [Parameter(Mandatory)] [ValidateSet('dev', 'test', 'prod')] [string] $Environment,
  [switch] $Upload
)

. (Join-Path $PSScriptRoot 'lib' 'Common.ps1')
trap { Exit-WithError $_ }

Import-EhubEnvironment $Environment
Assert-Guid 'EHUB_TEAMS_APP_ID'
foreach ($name in 'EHUB_TEAMS_WEBSITE_URL', 'EHUB_TEAMS_PRIVACY_URL', 'EHUB_TEAMS_TERMS_URL') { Assert-HttpsUrl $name }
Assert-Value 'EHUB_TEAMS_DEVELOPER_NAME'

# Every environment deployed here uses real Entra sign-in: production manifest rules.
$env:TEAMS_APP_ID = $env:EHUB_TEAMS_APP_ID
$env:TEAMS_BOT_CLIENT_ID = $env:EHUB_BOT_CLIENT_ID
$env:TEAMS_DEVELOPER_NAME = $env:EHUB_TEAMS_DEVELOPER_NAME
$env:TEAMS_WEBSITE_URL = $env:EHUB_TEAMS_WEBSITE_URL
$env:TEAMS_PRIVACY_URL = $env:EHUB_TEAMS_PRIVACY_URL
$env:TEAMS_TERMS_URL = $env:EHUB_TEAMS_TERMS_URL
if (Get-Setting 'EHUB_TEAMS_SSO_RESOURCE') { $env:TEAMS_SSO_RESOURCE = $env:EHUB_TEAMS_SSO_RESOURCE }

Push-Location $script:RepoRoot
try {
  pnpm --silent teams:validate --env production
  $output = @(pnpm --silent teams:package --env production)
} finally {
  Pop-Location
}
$output | ForEach-Object { Write-Output $_ }
$line = $output | Where-Object { $_ -like 'Package written: *' } | Select-Object -Last 1
if (-not $line) { Stop-Script 'The package was not written.' }
$package = $line.Substring('Package written: '.Length)
if (-not (Test-Path -LiteralPath $package -PathType Leaf)) { Stop-Script 'The package was not written.' }
Write-Info "SHA-256: $((Get-FileHash -Algorithm SHA256 -LiteralPath $package).Hash.ToLowerInvariant())"

if ($Upload) {
  Assert-Azure
  $storage = Get-DeploymentOutput $script:FoundationDeployment 'storageAccountName'
  if (-not $storage) { Stop-Script 'Stage 1 outputs not found.' }
  $blob = "teams/$Environment/$(Split-Path -Leaf $package)"
  # No --overwrite: a published version number is never replaced.
  az storage blob upload --account-name $storage --container-name releases --name $blob `
    --file $package --auth-mode login --only-show-errors -o none
  Write-Info "Uploaded to $storage/releases/$blob"
}
