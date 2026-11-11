# Shared helpers for the PowerShell deployment scripts. Dot-sourced, not run.
#
# Settings come from infrastructure/environments/<env>.env (KEY=value lines, not committed).
# The file is parsed line by line, never dot-sourced or evaluated, so a value cannot run code.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# A failing az command (non-zero exit) stops the script, as `set -e` does in the shell versions.
$PSNativeCommandUseErrorActionPreference = $true

# Each script starts with `trap { Exit-WithError $_ }` so errors print as one plain line (no
# colour codes or wrapping) and exit 1. A trap only covers the block that defines it, so it cannot
# live in this dot-sourced file.
function Exit-WithError([System.Management.Automation.ErrorRecord] $Record) {
  [Console]::Error.WriteLine($Record.Exception.Message)
  exit 1
}

$script:ScriptsDir = Split-Path -Parent $PSScriptRoot
$script:RepoRoot = (Resolve-Path (Join-Path $script:ScriptsDir '..' '..')).Path
$script:BicepDir = Join-Path $script:RepoRoot 'infrastructure' 'bicep'

$GuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$NilGuid = '00000000-0000-0000-0000-000000000000'

function Write-Info([string] $Message) { [Console]::Error.WriteLine($Message) }
function Write-Warn([string] $Message) { [Console]::Error.WriteLine("WARNING: $Message") }
function Stop-Script([string] $Message) { throw "ERROR: $Message" }

function Get-Setting([string] $Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($null -eq $value) { return '' }
  return $value
}

function Assert-Guid([string] $Name) {
  $value = Get-Setting $Name
  if ($value -notmatch $GuidPattern) { Stop-Script "$Name must be a GUID." }
  if ($value -eq $NilGuid) { Stop-Script "$Name is still the placeholder value." }
}

function Assert-HttpsUrl([string] $Name) {
  $value = Get-Setting $Name
  if ($value -notmatch '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^?#\s]*)?$') {
    Stop-Script "$Name must be an https URL without a query string."
  }
  if ($value -like '*example.com*' -or $value -like '*example.test*') { Stop-Script "$Name is still the placeholder value." }
}

function Assert-Value([string] $Name) {
  if ([string]::IsNullOrEmpty((Get-Setting $Name))) { Stop-Script "$Name is required in the environment file." }
}

function Import-EhubEnvironment([string] $Environment) {
  if ($Environment -cnotmatch '^(dev|test|prod)$') { Stop-Script 'Environment must be dev, test or prod.' }
  $script:EhubEnv = $Environment
  $file = Get-Setting 'EHUB_ENV_FILE'
  if ([string]::IsNullOrEmpty($file)) { $file = Join-Path $script:RepoRoot 'infrastructure' 'environments' "$Environment.env" }
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Stop-Script "Missing $file. Copy $Environment.env.example and fill it in." }

  $number = 0
  foreach ($raw in [IO.File]::ReadAllLines($file)) {
    $number++
    $line = $raw.TrimEnd("`r")
    if ($line -match '^\s*(#|$)') { continue }
    if ($line -cnotmatch '^(EHUB_[A-Z0-9_]+)=(.*)$') { Stop-Script "${file}:${number}: expected EHUB_NAME=value." }
    $key = $Matches[1]
    $value = $Matches[2]
    if ($value -match '^"(.*)"$' -or $value -match "^'(.*)'$") { $value = $Matches[1] }
    [Environment]::SetEnvironmentVariable($key, $value)
  }

  if ([string]::IsNullOrEmpty((Get-Setting 'EHUB_NAME_PREFIX'))) { $env:EHUB_NAME_PREFIX = 'ehub' }
  if ($env:EHUB_NAME_PREFIX -cnotmatch '^[a-z][a-z0-9]{1,7}$') {
    Stop-Script 'EHUB_NAME_PREFIX: 2-8 lower-case letters or digits, starting with a letter.'
  }
  Assert-Guid 'EHUB_SUBSCRIPTION_ID'
  Assert-Value 'EHUB_RESOURCE_GROUP'
  Assert-Value 'EHUB_LOCATION'
  Assert-Guid 'EHUB_ENTRA_API_CLIENT_ID'
  Assert-Guid 'EHUB_BOT_CLIENT_ID'
  if (Get-Setting 'EHUB_ADMIN_SPA_CLIENT_ID') { Assert-Guid 'EHUB_ADMIN_SPA_CLIENT_ID' }
  if (Get-Setting 'EHUB_DEPLOYER_OBJECT_ID') { Assert-Guid 'EHUB_DEPLOYER_OBJECT_ID' }
  Assert-HttpsUrl 'EHUB_MOODLE_BASE_URL'
  Assert-HttpsUrl 'EHUB_OPENAI_ENDPOINT'
  foreach ($name in 'EHUB_OPENAI_ACCOUNT_NAME', 'EHUB_OPENAI_RESOURCE_GROUP', 'EHUB_OPENAI_CHAT_DEPLOYMENT', 'EHUB_OPENAI_EMBEDDING_DEPLOYMENT') {
    Assert-Value $name
  }
  if ((Get-Setting 'EHUB_EMBEDDING_DIMENSIONS') -notmatch '^[0-9]+$') { Stop-Script 'EHUB_EMBEDDING_DIMENSIONS must be a whole number.' }
  $courses = Get-Setting 'EHUB_SYNC_COURSE_IDS'
  if (-not $courses) { Write-Warn 'EHUB_SYNC_COURSE_IDS is empty: the sync jobs will index nothing until it is set.' }
  elseif ($courses -notmatch '^[0-9]+(,[0-9]+)*$') { Stop-Script 'EHUB_SYNC_COURSE_IDS must be comma-separated course IDs, e.g. 12,15.' }
  if (-not (Get-Setting 'EHUB_SSO_CONNECTION_NAME')) { $env:EHUB_SSO_CONNECTION_NAME = 'ehub-sso' }

  $script:ParamsFile = Join-Path $script:BicepDir 'parameters' "$Environment.bicepparam"
  $script:FoundationDeployment = "ehub-$Environment-foundation"
  $script:AppsDeployment = "ehub-$Environment-apps"
}

function Assert-Azure {
  if (-not (Get-Command az -ErrorAction SilentlyContinue)) { Stop-Script 'The Azure CLI (az) is not installed: https://aka.ms/installazurecli' }
  try { az account show --only-show-errors -o none } catch { Stop-Script 'Not signed in. Run: az login' }
  az account set --subscription $env:EHUB_SUBSCRIPTION_ID --only-show-errors
  if (-not (Get-Setting 'EHUB_DEPLOYER_OBJECT_ID')) {
    try { $env:EHUB_DEPLOYER_OBJECT_ID = (az ad signed-in-user show --query id -o tsv --only-show-errors) } catch { $env:EHUB_DEPLOYER_OBJECT_ID = '' }
    if (-not $env:EHUB_DEPLOYER_OBJECT_ID) {
      Write-Warn 'Could not read your object ID; set EHUB_DEPLOYER_OBJECT_ID (and EHUB_DEPLOYER_PRINCIPAL_TYPE for a pipeline).'
    }
  }
}

function Get-DeploymentOutput([string] $Deployment, [string] $Name) {
  $value = az deployment group show --resource-group $env:EHUB_RESOURCE_GROUP --name $Deployment `
    --query "properties.outputs.$Name.value" -o tsv --only-show-errors
  if ($null -eq $value) { return '' }
  return ([string] $value).Trim()
}

function Confirm-Production([bool] $AssumeYes, [string] $Action) {
  if ($script:EhubEnv -ne 'prod' -or $AssumeYes) { return }
  if ([Console]::IsInputRedirected) { Stop-Script "Refusing to $Action production without -Yes (no terminal to confirm)." }
  $answer = Read-Host "About to $Action PRODUCTION ($env:EHUB_RESOURCE_GROUP). Type the resource group name to continue"
  if ($answer -cne $env:EHUB_RESOURCE_GROUP) { Stop-Script 'Not confirmed.' }
}

function Get-ImageTag([bool] $AllowDirty) {
  try { git -C $script:RepoRoot rev-parse --git-dir *> $null } catch { Stop-Script 'Not a git checkout: pass -ImageTag.' }
  if (-not $AllowDirty -and (git -C $script:RepoRoot status --porcelain)) {
    Stop-Script 'Uncommitted changes: commit first (the image tag must identify the code), or pass -AllowDirty.'
  }
  return (git -C $script:RepoRoot rev-parse --short=12 HEAD).Trim()
}
