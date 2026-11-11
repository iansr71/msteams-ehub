<#
.SYNOPSIS
Validates the Bicep templates without changing anything.

.DESCRIPTION
Without -Environment: lints and builds every template and builds every parameter file with
placeholder values (what the repository checks run). With -Environment: also builds that
environment's parameters from its .env file. With -Azure: also runs `az deployment group validate`.
#>
param(
  [ValidateSet('', 'dev', 'test', 'prod')] [string] $Environment = '',
  [switch] $Azure
)

. (Join-Path $PSScriptRoot 'lib' 'Common.ps1')
trap { Exit-WithError $_ }

node (Join-Path $script:ScriptsDir 'validate-bicep.mjs') --require-bicep

if ($Environment) {
  Import-EhubEnvironment $Environment
  $useAz = -not (Get-Command bicep -ErrorAction SilentlyContinue)
  foreach ($deployApps in 'false', 'true') {
    $env:EHUB_DEPLOY_APPS = $deployApps
    $env:EHUB_IMAGE_TAG = 'validate'
    if ($useAz) { az bicep build-params --file $script:ParamsFile --stdout | Out-Null }
    else { bicep build-params $script:ParamsFile --stdout | Out-Null }
  }
  Write-Info "Parameters for $Environment build from $Environment.env."
  if ($Azure) {
    Assert-Azure
    try { az group show --name $env:EHUB_RESOURCE_GROUP --only-show-errors -o none }
    catch { Stop-Script "Resource group $env:EHUB_RESOURCE_GROUP does not exist yet; deploy stage 1 first or skip -Azure." }
    $env:EHUB_DEPLOY_APPS = 'false'
    $env:EHUB_IMAGE_TAG = ''
    az deployment group validate --resource-group $env:EHUB_RESOURCE_GROUP --parameters $script:ParamsFile --only-show-errors -o none
    Write-Info "Azure accepted the stage 1 deployment for $Environment."
  }
}
