<#
.SYNOPSIS
Creates (or replaces) the Azure Bot OAuth connection used for Teams single sign-on
(docs/entra-sso.md, step 3), from the environment file and Key Vault.
#>
param(
  [Parameter(Mandatory)] [ValidateSet('dev', 'test', 'prod')] [string] $Environment,
  [switch] $Yes
)

. (Join-Path $PSScriptRoot 'lib' 'Common.ps1')
trap { Exit-WithError $_ }

Import-EhubEnvironment $Environment
Assert-Azure
Confirm-Production $Yes.IsPresent 'change sign-in for'

$botService = Get-DeploymentOutput $script:AppsDeployment 'botServiceName'
$vault = Get-DeploymentOutput $script:FoundationDeployment 'keyVaultName'
if (-not $botService -or -not $vault) { Stop-Script 'Deploy both stages first.' }
$tenantId = ([string] (az account show --query tenantId -o tsv --only-show-errors)).Trim()
if ($tenantId -notmatch $GuidPattern) { Stop-Script 'Could not read the tenant ID of the signed-in account.' }

# The Entra ID provider's parameter keys are not documented for templates; ask the service.
$providers = az bot authsetting list-providers --provider-name Aadv2 -o json --only-show-errors
$keys = @()
try {
  $keys = @($providers | node (Join-Path $script:ScriptsDir 'lib' 'find-provider-params.mjs'))
} catch {
  $keys = @()
}
# A native command at the end of a pipeline does not always throw on failure: check both.
if ($LASTEXITCODE -ne 0 -or $keys.Count -lt 2) {
  Stop-Script 'Create the connection in the portal instead (docs/entra-sso.md, step 3).'
}
$tenantKey = $keys[0].Trim()
$exchangeKey = $keys[1].Trim()

$secret = ([string] (az keyvault secret show --vault-name $vault --name teams-bot-client-secret --query value -o tsv --only-show-errors)).Trim()
if (-not $secret) { Stop-Script "teams-bot-client-secret is empty in $vault." }

$exists = $true
try {
  az bot authsetting show --resource-group $env:EHUB_RESOURCE_GROUP --name $botService `
    --setting-name $env:EHUB_SSO_CONNECTION_NAME --only-show-errors -o none 2>$null
} catch { $exists = $false }
if ($exists) {
  az bot authsetting delete --resource-group $env:EHUB_RESOURCE_GROUP --name $botService `
    --setting-name $env:EHUB_SSO_CONNECTION_NAME --only-show-errors -o none
}
# The Azure CLI takes the secret only as an argument, so it is briefly visible to other
# processes of this user on this machine. Run this from a trusted workstation.
try {
  az bot authsetting create --resource-group $env:EHUB_RESOURCE_GROUP --name $botService `
    --setting-name $env:EHUB_SSO_CONNECTION_NAME --service Aadv2 `
    --client-id $env:EHUB_BOT_CLIENT_ID --client-secret $secret `
    --provider-scope-string "api://$($env:EHUB_ENTRA_API_CLIENT_ID)/access_as_user" `
    --parameters "$tenantKey=$tenantId" "$exchangeKey=api://botid-$($env:EHUB_BOT_CLIENT_ID)" `
    --only-show-errors -o none
} finally {
  Remove-Variable secret -ErrorAction SilentlyContinue
}

Write-Info "OAuth connection $env:EHUB_SSO_CONNECTION_NAME created on $botService."
Write-Info "Test it in the portal: Azure Bot → Configuration → $env:EHUB_SSO_CONNECTION_NAME → Test connection."
