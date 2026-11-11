// Log Analytics workspace and workspace-based Application Insights.

@description('Azure region.')
param location string

@description('Log Analytics workspace name.')
param workspaceName string

@description('Application Insights component name.')
param appInsightsName string

@description('Days to keep logs and telemetry (30-730).')
@minValue(30)
@maxValue(730)
param retentionInDays int

@description('Daily ingestion cap in GB; -1 for no cap.')
param dailyQuotaGb int

param tags object

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: retentionInDays
    workspaceCapping: { dailyQuotaGb: dailyQuotaGb }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    RetentionInDays: retentionInDays
    IngestionMode: 'LogAnalytics'
    // The services authenticate with the connection string (kept in Key Vault). Entra-only
    // ingestion would need the exporter credential wired into startTelemetry: not done yet.
    DisableLocalAuth: false
  }
}

output workspaceId string = workspace.id
output workspaceName string = workspace.name
output appInsightsName string = appInsights.name
