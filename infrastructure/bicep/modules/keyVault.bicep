// Key Vault (RBAC permission model). Bicep writes only the Application Insights connection
// string; the Moodle token and the bot client secret are added by an operator between the two
// deployment stages (docs/infrastructure.md), so they never pass through deployment history.

param location string
param vaultName string
param tags object

@description('Days a deleted vault or secret can be recovered (7-90).')
@minValue(7)
@maxValue(90)
param softDeleteRetentionInDays int

@description('Purge protection cannot be turned off once on; enable it for production.')
param enablePurgeProtection bool

@description('Application Insights component whose connection string is stored as a secret.')
param appInsightsName string

param workspaceId string

@description('Object ID of the person or pipeline that deploys, given Key Vault Secrets Officer so it can add the operator secrets. Empty to skip.')
param deployerPrincipalId string

@allowed(['User', 'ServicePrincipal', 'Group'])
param deployerPrincipalType string

var keyVaultSecretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    // Azure rejects `false`: omit the property to leave purge protection off.
    enablePurgeProtection: enablePurgeProtection ? true : null
    // Container Apps without a virtual network have no fixed outbound address, so the vault
    // stays reachable publicly and access is by RBAC only.
    publicNetworkAccess: 'Enabled'
    networkAcls: { bypass: 'AzureServices', defaultAction: 'Allow' }
  }
}

resource appInsightsConnectionString 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: vault
  name: 'appinsights-connection-string'
  properties: {
    value: appInsights.properties.ConnectionString
    contentType: 'Application Insights connection string'
  }
}

resource deployerSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployerPrincipalId)) {
  name: guid(vault.id, deployerPrincipalId, keyVaultSecretsOfficer)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficer)
    principalId: deployerPrincipalId
    principalType: deployerPrincipalType
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: vault
  properties: {
    workspaceId: workspaceId
    logs: [{ categoryGroup: 'audit', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
