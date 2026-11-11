// Container Apps environment (workload profiles, Consumption) with the state file share
// registered for mounting.

param location string
param environmentName string
param tags object

param workspaceName string

@description('Container Apps subnet ID; empty for no virtual network.')
param infrastructureSubnetId string

param storageName string
param stateShareName string

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: workspaceName
}

resource storage 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {
  name: storageName
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    vnetConfiguration: empty(infrastructureSubnetId)
      ? null
      : {
          infrastructureSubnetId: infrastructureSubnetId
          internal: false
        }
    zoneRedundant: false
  }
}

resource stateStorage 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: environment
  name: 'state'
  properties: {
    azureFile: {
      accountName: storage.name
      // Container Apps mounts Azure Files only with the account key (no managed identity yet).
      accountKey: storage.listKeys().keys[0].value
      shareName: stateShareName
      accessMode: 'ReadWrite'
    }
  }
}

output environmentId string = environment.id
output environmentName string = environment.name
output defaultDomain string = environment.properties.defaultDomain
output stateStorageName string = stateStorage.name
