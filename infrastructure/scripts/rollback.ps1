<#
.SYNOPSIS
Rolls the API, the bot and the scheduled jobs back to an earlier image.

.DESCRIPTION
Without -ToTag it uses the most recent image in the API's revision history that differs from the
current one. Only the image changes: settings, secrets and the state on the file share stay as
they are (docs/infrastructure.md, "Rollback"). Deploy with -ImageTag set to the rolled-back tag
until the fix is released.
#>
param(
  [Parameter(Mandatory)] [ValidateSet('dev', 'test', 'prod')] [string] $Environment,
  [ValidatePattern('^$|^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')] [string] $ToTag = '',
  [switch] $Yes
)

. (Join-Path $PSScriptRoot 'lib' 'Common.ps1')
trap { Exit-WithError $_ }

Import-EhubEnvironment $Environment
Assert-Azure

$registryServer = Get-DeploymentOutput $script:FoundationDeployment 'registryLoginServer'
$registry = Get-DeploymentOutput $script:FoundationDeployment 'registryName'
$api = Get-DeploymentOutput $script:AppsDeployment 'apiAppName'
$bot = Get-DeploymentOutput $script:AppsDeployment 'botAppName'
if (-not $registryServer -or -not $api -or -not $bot) { Stop-Script "Deployment outputs not found for $Environment." }

$current = ([string] (az containerapp show --name $api --resource-group $env:EHUB_RESOURCE_GROUP `
    --query 'properties.template.containers[0].image' -o tsv --only-show-errors)).Trim()

if ($ToTag) {
  $tags = @(az acr repository show-tags --name $registry --repository ehub -o tsv --only-show-errors)
  if ($tags -notcontains $ToTag) { Stop-Script "Tag $ToTag is not in $registry." }
  $target = "$registryServer/ehub:$ToTag"
} else {
  # Newest first, without de-duplication: earlier rollbacks make the history A, B, A.
  $images = @(az containerapp revision list --name $api --resource-group $env:EHUB_RESOURCE_GROUP --all `
      --query 'reverse(sort_by(@, &properties.createdTime))[].properties.template.containers[0].image' `
      -o tsv --only-show-errors)
  $target = $images | Where-Object { $_ -and $_.Trim() -ne $current } | Select-Object -First 1
  if (-not $target) { Stop-Script "No earlier image in the API's revision history; pass -ToTag." }
  $target = $target.Trim()
}
if ($target -eq $current) { Stop-Script "The API already runs $target." }

Write-Info "Current: $current"
Write-Info "Target:  $target"
Confirm-Production $Yes.IsPresent 'roll back'

foreach ($app in $api, $bot) {
  az containerapp update --name $app --resource-group $env:EHUB_RESOURCE_GROUP --image $target --only-show-errors -o none
  Write-Info "Rolled back $app."
}
$jobs = @(az containerapp job list --resource-group $env:EHUB_RESOURCE_GROUP `
    --query "[?starts_with(name, 'caj-$($env:EHUB_NAME_PREFIX)-$Environment-')].name" -o tsv --only-show-errors)
foreach ($job in $jobs | Where-Object { $_ }) {
  az containerapp job update --name $job.Trim() --resource-group $env:EHUB_RESOURCE_GROUP --image $target --only-show-errors -o none
  Write-Info "Rolled back $($job.Trim())."
}

Write-Info "Done. Check: curl -fsS $(Get-DeploymentOutput $script:AppsDeployment 'apiUrl')/health/ready"
Write-Info "Deploy with -ImageTag $(($target -split ':')[-1]) until the fix is released."
