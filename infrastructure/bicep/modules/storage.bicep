// Storage for the services' state and for release artifacts.
// - File share `state`: the file-based state stores (sync state, identity mappings, admin audit
//   and usage, embedding cache), mounted at /mnt/state. Container Apps can mount Azure Files only
//   with the account key, so shared-key access must stay enabled.
// - Blob container `releases`: Teams app packages and release reports (infrastructure/scripts).

param location string
param storageName string
param tags object

@allowed(['Standard_LRS', 'Standard_ZRS', 'Standard_GRS', 'Standard_RAGRS'])
param skuName string

@minValue(1)
@maxValue(5120)
param stateShareQuotaGb int

@description('Days deleted blobs, containers and file shares can be recovered (1-365).')
@minValue(1)
@maxValue(365)
param softDeleteRetentionDays int

@description('Add a CanNotDelete lock (production): the account holds the sync and identity state.')
param protectFromDeletion bool

param workspaceId string

@description('Identities allowed to read and write release artifacts.')
param releaseWriterPrincipalIds array

var storageBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource account 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: storageName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: skuName }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    // Required by the Container Apps Azure Files mount (account key). Blob access from the
    // scripts uses Entra ID.
    allowSharedKeyAccess: true
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
    networkAcls: { bypass: 'AzureServices', defaultAction: 'Allow' }
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
      }
    }
  }
}

resource fileServices 'Microsoft.Storage/storageAccounts/fileServices@2024-01-01' = {
  parent: account
  name: 'default'
  properties: {
    shareDeleteRetentionPolicy: { enabled: true, days: softDeleteRetentionDays }
  }
}

resource stateShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  parent: fileServices
  name: 'state'
  properties: {
    shareQuota: stateShareQuotaGb
    enabledProtocols: 'SMB'
    accessTier: 'TransactionOptimized'
  }
}

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2024-01-01' = {
  parent: account
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: softDeleteRetentionDays }
    containerDeleteRetentionPolicy: { enabled: true, days: softDeleteRetentionDays }
    isVersioningEnabled: true
  }
}

resource releases 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobServices
  name: 'releases'
  properties: { publicAccess: 'None' }
}

resource releaseAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in releaseWriterPrincipalIds: {
    name: guid(releases.id, principalId, storageBlobDataContributor)
    scope: releases
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributor)
      principalId: principalId
    }
  }
]

resource lock 'Microsoft.Authorization/locks@2020-05-01' = if (protectFromDeletion) {
  name: 'protect-state'
  scope: account
  properties: {
    level: 'CanNotDelete'
    notes: 'Holds the sync state, identity mappings and audit records.'
  }
}

resource fileDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: fileServices
  properties: {
    workspaceId: workspaceId
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'Transaction', enabled: true }]
  }
}

resource blobDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: blobServices
  properties: {
    workspaceId: workspaceId
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'Transaction', enabled: true }]
  }
}

output storageName string = account.name
output stateShareName string = stateShare.name
output releasesContainerName string = releases.name
