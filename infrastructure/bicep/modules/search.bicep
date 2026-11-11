// Azure AI Search with API keys disabled: every caller uses Microsoft Entra ID (managed identity).
// Bicep never creates, changes or deletes the index itself: `pnpm indexer search:create-index`
// and `search:apply-compatible-changes` do, deliberately (docs/search-index.md).

param location string
param searchName string
param tags object

@allowed(['free', 'basic', 'standard', 'standard2', 'standard3', 'storage_optimized_l1', 'storage_optimized_l2'])
param sku string

@minValue(1)
@maxValue(12)
param replicaCount int

@minValue(1)
@maxValue(12)
param partitionCount int

@allowed(['disabled', 'free', 'standard'])
param semanticSearch string

@description('Add a CanNotDelete lock (production).')
param protectFromDeletion bool

param workspaceId string

@description('Query only (answer API without in-process indexing jobs).')
param readerPrincipalIds array

@description('Create and update the index and load documents (indexer jobs).')
param writerPrincipalIds array

@description('Optional operator principal allowed to run the search commands from a workstation.')
param operatorPrincipalId string

@allowed(['User', 'ServicePrincipal', 'Group'])
param operatorPrincipalType string

var roles = {
  reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
  searchServiceContributor: '7ca78c08-252a-4471-8644-bb5ff32d4ba0'
  searchIndexDataContributor: '8ebe5a00-799e-43f5-93ac-243d3dce84a7'
  searchIndexDataReader: '1407120a-92aa-4202-b7e9-c0e197c71c8f'
}

// Readers query the index (Search Index Data Reader). The health check also reads the index
// definition and statistics, which that role cannot, so readers get the control-plane Reader
// role as well. Writers manage the index schema and load documents.
var readerAssignments = flatten(map(readerPrincipalIds, id => [
  { principalId: id, role: roles.searchIndexDataReader, type: 'ServicePrincipal' }
  { principalId: id, role: roles.reader, type: 'ServicePrincipal' }
]))
var writerAssignments = flatten(map(writerPrincipalIds, id => [
  { principalId: id, role: roles.searchIndexDataContributor, type: 'ServicePrincipal' }
  { principalId: id, role: roles.searchServiceContributor, type: 'ServicePrincipal' }
]))
var operatorAssignments = empty(operatorPrincipalId)
  ? []
  : [
      { principalId: operatorPrincipalId, role: roles.searchIndexDataContributor, type: operatorPrincipalType }
      { principalId: operatorPrincipalId, role: roles.searchServiceContributor, type: operatorPrincipalType }
    ]
var assignments = concat(readerAssignments, writerAssignments, operatorAssignments)

resource search 'Microsoft.Search/searchServices@2025-05-01' = {
  name: searchName
  location: location
  tags: tags
  sku: { name: sku }
  properties: {
    replicaCount: replicaCount
    partitionCount: partitionCount
    hostingMode: 'Default'
    publicNetworkAccess: 'enabled'
    disableLocalAuth: true
    semanticSearch: sku == 'free' ? null : semanticSearch
  }
}

resource access 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for assignment in assignments: {
    name: guid(search.id, assignment.principalId, assignment.role)
    scope: search
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', assignment.role)
      principalId: assignment.principalId
      principalType: assignment.type
    }
  }
]

resource lock 'Microsoft.Authorization/locks@2020-05-01' = if (protectFromDeletion) {
  name: 'protect-search'
  scope: search
  properties: {
    level: 'CanNotDelete'
    notes: 'Holds the E-Hub index. Remove this lock deliberately before deleting the service.'
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: search
  properties: {
    workspaceId: workspaceId
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output searchName string = search.name
output endpoint string = 'https://${search.name}.search.windows.net'
