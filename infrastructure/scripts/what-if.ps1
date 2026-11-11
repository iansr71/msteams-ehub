<#
.SYNOPSIS
Shows what a deployment would change, without changing anything.

.DESCRIPTION
For the apps stage the image tag defaults to the image the API runs now, so only template changes
show.
#>
param(
  [Parameter(Mandatory)] [ValidateSet('dev', 'test', 'prod')] [string] $Environment,
  [ValidateSet('foundation', 'apps')] [string] $Stage = 'foundation',
  [ValidatePattern('^$|^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')] [string] $ImageTag = ''
)

. (Join-Path $PSScriptRoot 'lib' 'Common.ps1')
trap { Exit-WithError $_ }

Import-EhubEnvironment $Environment
Assert-Azure

$deployApps = 'false'
$tag = $ImageTag
if ($Stage -eq 'apps') {
  $deployApps = 'true'
  if (-not $tag) {
    $api = ''
    try { $api = Get-DeploymentOutput $script:AppsDeployment 'apiAppName' } catch { $api = '' }
    if (-not $api) { Stop-Script 'No apps deployment yet: pass -ImageTag.' }
    $image = az containerapp show --name $api --resource-group $env:EHUB_RESOURCE_GROUP `
      --query 'properties.template.containers[0].image' -o tsv --only-show-errors
    $tag = ($image.Trim() -split ':')[-1]
  }
}

$env:EHUB_DEPLOY_APPS = $deployApps
$env:EHUB_IMAGE_TAG = $tag
az deployment group what-if --resource-group $env:EHUB_RESOURCE_GROUP --parameters $script:ParamsFile `
  --result-format FullResourcePayloads --only-show-errors
