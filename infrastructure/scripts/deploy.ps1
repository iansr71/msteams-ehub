<#
.SYNOPSIS
Deploys one environment in two stages (docs/infrastructure.md).

.DESCRIPTION
Stage 1 (foundation): monitoring, Key Vault, Search, Storage, registry, identities, roles,
network and the Container Apps environment. Stage 2 (apps): builds the image in the registry,
checks the operator secrets, then deploys the API, bot, jobs, Azure Bot registration and
availability tests.

.EXAMPLE
./deploy.ps1 test
./deploy.ps1 prod -Stage apps -ImageTag 3d373741f7bb -Yes
#>
param(
  [Parameter(Mandatory)] [ValidateSet('dev', 'test', 'prod')] [string] $Environment,
  [ValidateSet('all', 'foundation', 'apps')] [string] $Stage = 'all',
  [ValidatePattern('^$|^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')] [string] $ImageTag = '',
  [switch] $SkipBuild,
  [switch] $AllowDirty,
  [switch] $Yes
)

. (Join-Path $PSScriptRoot 'lib' 'Common.ps1')
trap { Exit-WithError $_ }

Import-EhubEnvironment $Environment
Assert-Azure
Confirm-Production $Yes.IsPresent 'deploy to'

function Invoke-Foundation {
  Write-Info "Stage 1: foundation ($env:EHUB_RESOURCE_GROUP, $env:EHUB_LOCATION)."
  az group create --name $env:EHUB_RESOURCE_GROUP --location $env:EHUB_LOCATION `
    --tags application=ehub-knowledge-assistant "environment=$script:EhubEnv" --only-show-errors -o none
  $env:EHUB_DEPLOY_APPS = 'false'
  $env:EHUB_IMAGE_TAG = ''
  az deployment group create --resource-group $env:EHUB_RESOURCE_GROUP --name $script:FoundationDeployment `
    --parameters $script:ParamsFile --only-show-errors -o none
  Write-Info 'Foundation deployed.'
}

function Get-MissingSecrets([string] $Vault) {
  try {
    $names = @(az keyvault secret list --vault-name $Vault --query '[].name' -o tsv --only-show-errors)
  } catch {
    Stop-Script "Cannot list secrets in $Vault. If stage 1 just granted you access, wait a few minutes and run -Stage apps."
  }
  return @('moodle-token', 'teams-bot-client-secret' | Where-Object { $names -notcontains $_ })
}

function Invoke-Apps {
  $registry = Get-DeploymentOutput $script:FoundationDeployment 'registryName'
  $vault = Get-DeploymentOutput $script:FoundationDeployment 'keyVaultName'
  if (-not $registry -or -not $vault) { Stop-Script 'Stage 1 outputs not found: run -Stage foundation first.' }

  # @() keeps an empty result an array: PowerShell returns an empty array from a function as $null.
  $missing = @(Get-MissingSecrets $vault)
  if ($missing.Count -gt 0) {
    Write-Info "Key Vault $vault is missing: $($missing -join ' ')"
    Write-Info 'Add each from a file so the value stays out of shell history, then delete the file:'
    Write-Info "  az keyvault secret set --vault-name $vault --name moodle-token --file moodle-token.txt"
    Write-Info "  az keyvault secret set --vault-name $vault --name teams-bot-client-secret --file bot-secret.txt"
    Stop-Script 'Secrets missing; nothing was deployed in stage 2.'
  }

  $tag = $ImageTag
  if (-not $tag) { $tag = Get-ImageTag $AllowDirty.IsPresent }
  if ($SkipBuild) {
    $tags = @(az acr repository show-tags --name $registry --repository ehub -o tsv --only-show-errors)
    if ($tags -notcontains $tag) { Stop-Script "Image ehub:$tag is not in $registry; build it or drop -SkipBuild." }
  } else {
    $nodeImage = Get-Setting 'EHUB_NODE_IMAGE'
    if (-not $nodeImage) { $nodeImage = 'node:22-bookworm-slim' }
    Write-Info "Building ehub:$tag in $registry (az acr build)."
    az acr build --registry $registry --image "ehub:$tag" --build-arg "NODE_IMAGE=$nodeImage" `
      --file (Join-Path $script:RepoRoot 'Dockerfile') $script:RepoRoot --only-show-errors -o none
  }

  Write-Info "Stage 2: services with image ehub:$tag."
  $env:EHUB_DEPLOY_APPS = 'true'
  $env:EHUB_IMAGE_TAG = $tag
  foreach ($attempt in 1, 2) {
    try {
      az deployment group create --resource-group $env:EHUB_RESOURCE_GROUP --name $script:AppsDeployment `
        --parameters $script:ParamsFile --only-show-errors -o none
      break
    } catch {
      # The per-secret role assignments are created in this same deployment; the services can
      # fail to read their Key Vault references until the assignments propagate.
      if ($attempt -eq 2) { Stop-Script "Stage 2 failed twice. See the deployment in the portal: $script:AppsDeployment." }
      Write-Warn 'Stage 2 failed; retrying in 90 seconds (role assignments can take time to apply).'
      $delay = Get-Setting 'EHUB_RETRY_DELAY_SECONDS'
      Start-Sleep -Seconds ($(if ($delay) { [int] $delay } else { 90 }))
    }
  }

  Write-Info 'Deployed.'
  Write-Info "  API:              $(Get-DeploymentOutput $script:AppsDeployment 'apiUrl')"
  Write-Info "  Bot endpoint:     $(Get-DeploymentOutput $script:AppsDeployment 'botMessagingEndpoint')"
  Write-Info "  Outbound IP:      $(Get-DeploymentOutput $script:AppsDeployment 'outboundIp')"
  Write-Info "Next: configure-bot-sso.ps1 $script:EhubEnv, create the search index, run the first sync (docs/infrastructure.md)."
}

switch ($Stage) {
  'foundation' { Invoke-Foundation }
  'apps' { Invoke-Apps }
  'all' { Invoke-Foundation; Invoke-Apps }
}
