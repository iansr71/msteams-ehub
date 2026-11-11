// E-Hub Teams Knowledge Assistant: one environment (dev, test or prod) in one resource group.
//
// Two stages (infrastructure/scripts/deploy.*, docs/infrastructure.md):
//   1. deployApps = false: monitoring, Key Vault, Search, Storage, registry, identities, roles,
//      network and the Container Apps environment.
//      Then: build the image into the registry and add the Moodle token and bot secret to Key Vault.
//   2. deployApps = true: per-secret access, the API, the bot, the scheduled jobs, the Azure Bot
//      registration and availability tests.
//
// Nothing here creates or deletes the search index, and no secret value is an output.

targetScope = 'resourceGroup'

// ---------------------------------------------------------------- environment and naming

@allowed(['dev', 'test', 'prod'])
param environmentName string

@description('Lower-case letters and digits, 2-8 characters; part of every resource name.')
@minLength(2)
@maxLength(8)
param namePrefix string

param location string = resourceGroup().location

@description('Stage 2: deploy the services. Requires the image and the operator secrets.')
param deployApps bool = false

@description('Image tag in the registry (stage 2), e.g. the short commit hash.')
param imageTag string = ''

param tags object = {}

@description('Person or pipeline that deploys: may add Key Vault secrets and run the search commands. Empty to skip.')
param deployerPrincipalId string = ''

@allowed(['User', 'ServicePrincipal', 'Group'])
param deployerPrincipalType string = 'User'

// ---------------------------------------------------------------- sizing and protection

@minValue(30)
@maxValue(730)
param logRetentionDays int = 30

param logDailyQuotaGb int = -1

@minValue(7)
@maxValue(90)
param keyVaultSoftDeleteDays int = 90

param keyVaultPurgeProtection bool = false

@allowed(['free', 'basic', 'standard', 'standard2', 'standard3', 'storage_optimized_l1', 'storage_optimized_l2'])
param searchSku string = 'basic'

param searchReplicaCount int = 1
param searchPartitionCount int = 1

@allowed(['disabled', 'free', 'standard'])
param searchSemantic string = 'free'

@description('CanNotDelete locks on Search and Storage (production).')
param protectData bool = false

@allowed(['Standard_LRS', 'Standard_ZRS', 'Standard_GRS', 'Standard_RAGRS'])
param storageSku string = 'Standard_LRS'

param stateShareQuotaGb int = 10

@minValue(1)
@maxValue(365)
param storageSoftDeleteDays int = 14

@allowed(['Basic', 'Standard', 'Premium'])
param registrySku string = 'Basic'

param apiCpu string = '0.5'
param apiMemory string = '1Gi'
param botCpu string = '0.25'
param botMemory string = '0.5Gi'
param jobCpu string = '1'
param jobMemory string = '2Gi'

// ---------------------------------------------------------------- network

@description('Put the environment in a virtual network with a NAT gateway (one static outbound IP for a Moodle allowlist).')
param enableVnet bool = false

param vnetAddressPrefix string = '10.40.0.0/24'
param containerAppsSubnetPrefix string = '10.40.0.0/27'

// ---------------------------------------------------------------- Azure OpenAI (managed separately)

@description('Existing Azure OpenAI or Azure AI Foundry account name.')
param openAiAccountName string

@description('Its resource group (same subscription).')
param openAiResourceGroup string

@description('Account endpoint, e.g. https://<name>.openai.azure.com')
param openAiEndpoint string

param openAiChatDeployment string
param openAiEmbeddingDeployment string

@minValue(256)
@maxValue(3072)
param embeddingDimensions int

// ---------------------------------------------------------------- application

@description('Moodle site, e.g. https://ehub.example.com')
param moodleBaseUrl string

@description('Comma-separated Moodle course IDs to index; empty with syncAllCourses = true.')
param syncCourseIds string = ''

param syncAllCourses bool = false

param tenantId string = subscription().tenantId

@description('Answer API app registration (client) ID: tokens must have this audience.')
param entraApiClientId string

@description('Bot app registration (client) ID.')
param botClientId string

@description('Administration page (SPA) app registration ID; empty disables the admin page.')
param adminSpaClientId string = ''

param ssoConnectionName string = 'ehub-sso'

@allowed(['F0', 'S1'])
param botSku string = 'F0'

param botDisplayName string = 'E-Hub Knowledge Assistant'

@description('Match Entra users to Moodle accounts by email (docs/authorization.md).')
param identityEmailMatching bool = true

@description('Cron (UTC) for incremental sync. Default 01:15 UTC (03:15 SAST).')
param incrementalSyncCron string = '15 1 * * *'

@description('Cron (UTC) for the enrolment refresh. Default every 4 hours at :40.')
param enrolmentSyncCron string = '40 */4 * * *'

@description('Cron (UTC) for full reconciliation. Default Sundays 02:45 UTC.')
param reconcileCron string = '45 2 * * 0'

@description('Email addresses for availability alerts; empty for none.')
param alertEmails array = []

// ---------------------------------------------------------------- names

var suffix = take(uniqueString(subscription().id, resourceGroup().id, namePrefix, environmentName), 6)
var base = '${namePrefix}-${environmentName}'
var compact = toLower('${namePrefix}${environmentName}${suffix}')
var names = {
  workspace: 'log-${base}'
  appInsights: 'appi-${base}'
  keyVault: 'kv-${base}-${suffix}'
  search: 'srch-${base}-${suffix}'
  storage: 'st${compact}'
  registry: 'cr${compact}'
  environment: 'cae-${base}'
  api: 'ca-${base}-api'
  bot: 'ca-${base}-bot'
  botService: 'bot-${base}-${suffix}'
  apiIdentity: 'id-${base}-api'
  botIdentity: 'id-${base}-bot'
  jobsIdentity: 'id-${base}-jobs'
  vnet: 'vnet-${base}'
  nat: 'ng-${base}'
  natIp: 'pip-${base}-egress'
}
var allTags = union(tags, { application: 'ehub-knowledge-assistant', environment: environmentName })
var adminEnabled = !empty(adminSpaClientId)

// ---------------------------------------------------------------- stage 1

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    location: location
    workspaceName: names.workspace
    appInsightsName: names.appInsights
    retentionInDays: logRetentionDays
    dailyQuotaGb: logDailyQuotaGb
    tags: allTags
  }
}

module identities 'modules/identities.bicep' = {
  name: 'identities'
  params: {
    location: location
    apiIdentityName: names.apiIdentity
    botIdentityName: names.botIdentity
    jobsIdentityName: names.jobsIdentity
    tags: allTags
  }
}

module keyVault 'modules/keyVault.bicep' = {
  name: 'key-vault'
  params: {
    location: location
    vaultName: names.keyVault
    tags: allTags
    softDeleteRetentionInDays: keyVaultSoftDeleteDays
    enablePurgeProtection: keyVaultPurgeProtection
    appInsightsName: monitoring.outputs.appInsightsName
    workspaceId: monitoring.outputs.workspaceId
    deployerPrincipalId: deployerPrincipalId
    deployerPrincipalType: deployerPrincipalType
  }
}

module search 'modules/search.bicep' = {
  name: 'search'
  params: {
    location: location
    searchName: names.search
    tags: allTags
    sku: searchSku
    replicaCount: searchReplicaCount
    partitionCount: searchPartitionCount
    semanticSearch: searchSemantic
    protectFromDeletion: protectData
    workspaceId: monitoring.outputs.workspaceId
    // The administration page runs sync jobs inside the API, so with it enabled the API needs
    // the indexer's write roles too (docs/infrastructure.md, "Identities and roles").
    readerPrincipalIds: adminEnabled ? [] : [identities.outputs.apiPrincipalId]
    writerPrincipalIds: adminEnabled
      ? [identities.outputs.jobsPrincipalId, identities.outputs.apiPrincipalId]
      : [identities.outputs.jobsPrincipalId]
    operatorPrincipalId: deployerPrincipalId
    operatorPrincipalType: deployerPrincipalType
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    storageName: names.storage
    tags: allTags
    skuName: storageSku
    stateShareQuotaGb: stateShareQuotaGb
    softDeleteRetentionDays: storageSoftDeleteDays
    protectFromDeletion: protectData
    workspaceId: monitoring.outputs.workspaceId
    // The deployer uploads Teams packages (package-teams-app --upload).
    releaseWriterPrincipalIds: empty(deployerPrincipalId) ? [] : [deployerPrincipalId]
  }
}

module registry 'modules/registry.bicep' = {
  name: 'registry'
  params: {
    location: location
    registryName: names.registry
    tags: allTags
    sku: registrySku
    workspaceId: monitoring.outputs.workspaceId
    pullPrincipalIds: [
      identities.outputs.apiPrincipalId
      identities.outputs.botPrincipalId
      identities.outputs.jobsPrincipalId
    ]
  }
}

module network 'modules/network.bicep' = if (enableVnet) {
  name: 'network'
  params: {
    location: location
    vnetName: names.vnet
    natGatewayName: names.nat
    publicIpName: names.natIp
    tags: allTags
    addressPrefix: vnetAddressPrefix
    subnetPrefix: containerAppsSubnetPrefix
  }
}

module environment 'modules/containerEnvironment.bicep' = {
  name: 'container-environment'
  params: {
    location: location
    environmentName: names.environment
    tags: allTags
    workspaceName: monitoring.outputs.workspaceName
    infrastructureSubnetId: enableVnet ? network!.outputs.subnetId : ''
    storageName: storage.outputs.storageName
    stateShareName: storage.outputs.stateShareName
  }
}

module openAi 'modules/openAiAccess.bicep' = {
  name: 'openai-access'
  scope: resourceGroup(openAiResourceGroup)
  params: {
    accountName: openAiAccountName
    principalIds: [identities.outputs.apiPrincipalId, identities.outputs.jobsPrincipalId]
  }
}

// ---------------------------------------------------------------- stage 2: settings

var image = '${registry.outputs.loginServer}/ehub:${imageTag}'
var apiFqdn = '${names.api}.${environment.outputs.defaultDomain}'
var botFqdn = '${names.bot}.${environment.outputs.defaultDomain}'
var semanticEnabled = searchSemantic != 'disabled' && searchSku != 'free'

// Shared by the API and the jobs. Values follow .env.example; anything not set uses the
// application default. NODE_ENV=production in every environment, so test behaves like prod.
var coreSettings = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'AZURE_TENANT_ID', value: tenantId }
  { name: 'MOODLE_BASE_URL', value: moodleBaseUrl }
  { name: 'AZURE_SEARCH_ENDPOINT', value: search.outputs.endpoint }
  { name: 'AZURE_SEARCH_VECTOR_DIMENSIONS', value: string(embeddingDimensions) }
  { name: 'AZURE_SEARCH_SEMANTIC_ENABLED', value: string(semanticEnabled) }
  { name: 'RETRIEVAL_SEMANTIC_RANKING', value: string(semanticEnabled) }
  { name: 'AZURE_OPENAI_ENDPOINT', value: openAiEndpoint }
  { name: 'AZURE_OPENAI_CHAT_DEPLOYMENT', value: openAiChatDeployment }
  { name: 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT', value: openAiEmbeddingDeployment }
  { name: 'AZURE_OPENAI_EMBEDDING_DIMENSIONS', value: string(embeddingDimensions) }
  { name: 'SYNC_COURSE_IDS', value: syncAllCourses ? '' : syncCourseIds }
  { name: 'SYNC_ALL_COURSES', value: string(syncAllCourses) }
  { name: 'SYNC_STATE_DIR', value: '/mnt/state/sync' }
  { name: 'IDENTITY_STATE_DIR', value: '/mnt/state/identity' }
  { name: 'ADMIN_STATE_DIR', value: '/mnt/state/admin' }
  { name: 'EMBEDDING_CACHE_DIR', value: '/mnt/state/embedding-cache' }
  { name: 'IDENTITY_EMAIL_MATCHING', value: string(identityEmailMatching) }
  // The Azure SDK otherwise writes plain-text warnings between the services' JSON log lines.
  { name: 'AZURE_LOG_LEVEL', value: 'error' }
]
var coreSecrets = [
  { name: 'MOODLE_TOKEN', secretName: 'moodle-token' }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretName: 'appinsights-connection-string' }
]
var apiSettings = concat(coreSettings, [
  // DefaultAzureCredential picks the user-assigned identity by its client ID.
  { name: 'AZURE_CLIENT_ID', value: identities.outputs.apiClientId }
  { name: 'PORT', value: '3000' }
  { name: 'API_HOST', value: '0.0.0.0' }
  { name: 'ENTRA_API_CLIENT_ID', value: entraApiClientId }
  { name: 'ENTRA_ALLOWED_CLIENT_APP_IDS', value: adminEnabled ? '${botClientId},${adminSpaClientId}' : botClientId }
  { name: 'ADMIN_UI_ENABLED', value: string(adminEnabled) }
  { name: 'ADMIN_SPA_CLIENT_ID', value: adminSpaClientId }
  { name: 'ADMIN_PUBLIC_ORIGIN', value: adminEnabled ? 'https://${apiFqdn}' : '' }
])
var jobSettings = concat(coreSettings, [
  { name: 'AZURE_CLIENT_ID', value: identities.outputs.jobsClientId }
])
var botSettings = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'TEAMS_BOT_PORT', value: '3978' }
  { name: 'TEAMS_BOT_CLIENT_ID', value: botClientId }
  { name: 'TEAMS_BOT_TENANT_ID', value: tenantId }
  { name: 'TEAMS_SSO_CONNECTION_NAME', value: ssoConnectionName }
  { name: 'TEAMS_API_BASE_URL', value: 'https://${apiFqdn}' }
  // The API already allowlists citation hosts; the bot checks again before rendering links.
  { name: 'TEAMS_ALLOWED_LINK_HOSTS', value: parseUri(moodleBaseUrl).host }
]
var botSecrets = [
  { name: 'TEAMS_BOT_CLIENT_SECRET', secretName: 'teams-bot-client-secret' }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretName: 'appinsights-connection-string' }
]
var jobs = [
  {
    key: 'sync'
    command: ['node', 'apps/indexer/dist/cli.js', 'sync:incremental']
    cron: incrementalSyncCron
    timeout: 14400
  }
  {
    key: 'enrolments'
    command: ['node', 'apps/api/dist/authorizationCli.js', 'sync']
    cron: enrolmentSyncCron
    timeout: 3600
  }
  {
    key: 'reconcile'
    command: ['node', 'apps/indexer/dist/cli.js', 'sync:reconcile']
    cron: reconcileCron
    timeout: 14400
  }
]

// ---------------------------------------------------------------- stage 2: services

module secretAccess 'modules/keyVaultSecretAccess.bicep' = if (deployApps) {
  name: 'key-vault-secret-access'
  params: {
    vaultName: keyVault.outputs.vaultName
    grants: [
      { principalId: identities.outputs.apiPrincipalId, secretName: 'moodle-token' }
      { principalId: identities.outputs.apiPrincipalId, secretName: 'appinsights-connection-string' }
      { principalId: identities.outputs.jobsPrincipalId, secretName: 'moodle-token' }
      { principalId: identities.outputs.jobsPrincipalId, secretName: 'appinsights-connection-string' }
      { principalId: identities.outputs.botPrincipalId, secretName: 'teams-bot-client-secret' }
      { principalId: identities.outputs.botPrincipalId, secretName: 'appinsights-connection-string' }
    ]
  }
}

module api 'modules/containerApp.bicep' = if (deployApps) {
  name: 'app-api'
  dependsOn: [secretAccess, openAi]
  params: {
    location: location
    appName: names.api
    tags: allTags
    environmentId: environment.outputs.environmentId
    identityId: identities.outputs.apiId
    registryServer: registry.outputs.loginServer
    image: image
    command: ['node', 'apps/api/dist/cli.js', 'serve']
    env: apiSettings
    secretEnv: coreSecrets
    vaultUri: keyVault.outputs.vaultUri
    targetPort: 3000
    cpu: apiCpu
    memory: apiMemory
    // One replica: the state stores are files on a shared share and the admin page runs jobs
    // in-process (docs/infrastructure.md, "Limits of the file-based state").
    minReplicas: 1
    maxReplicas: 1
    stateStorageName: environment.outputs.stateStorageName
  }
}

module bot 'modules/containerApp.bicep' = if (deployApps) {
  name: 'app-bot'
  dependsOn: [secretAccess]
  params: {
    location: location
    appName: names.bot
    tags: allTags
    environmentId: environment.outputs.environmentId
    identityId: identities.outputs.botId
    registryServer: registry.outputs.loginServer
    image: image
    command: ['node', 'apps/teams-app/dist/main.js']
    env: botSettings
    secretEnv: botSecrets
    vaultUri: keyVault.outputs.vaultUri
    targetPort: 3978
    cpu: botCpu
    memory: botMemory
    // Always one warm replica: Teams expects a reply within seconds.
    minReplicas: 1
    maxReplicas: 1
    stateStorageName: ''
  }
}

module scheduledJobs 'modules/containerJob.bicep' = [
  for job in jobs: if (deployApps) {
    name: 'job-${job.key}'
    dependsOn: [secretAccess, openAi]
    params: {
      location: location
      jobName: 'caj-${base}-${job.key}'
      tags: allTags
      environmentId: environment.outputs.environmentId
      identityId: identities.outputs.jobsId
      registryServer: registry.outputs.loginServer
      image: image
      command: job.command
      env: jobSettings
      secretEnv: coreSecrets
      vaultUri: keyVault.outputs.vaultUri
      cronExpression: job.cron
      replicaTimeoutSeconds: job.timeout
      cpu: jobCpu
      memory: jobMemory
      stateStorageName: environment.outputs.stateStorageName
    }
  }
]

module botService 'modules/bot.bicep' = if (deployApps) {
  name: 'bot-service'
  params: {
    botName: names.botService
    tags: allTags
    botClientId: botClientId
    tenantId: tenantId
    messagingEndpoint: 'https://${bot!.outputs.fqdn}/api/messages'
    sku: botSku
    displayName: botDisplayName
  }
}

module availability 'modules/availability.bicep' = if (deployApps) {
  name: 'availability'
  params: {
    location: location
    tags: allTags
    appInsightsName: monitoring.outputs.appInsightsName
    environmentName: environmentName
    apiReadyUrl: 'https://${api!.outputs.fqdn}/health/ready'
    botLiveUrl: 'https://${bot!.outputs.fqdn}/health/live'
    alertEmails: alertEmails
  }
}

// ---------------------------------------------------------------- outputs (non-sensitive)

output keyVaultName string = keyVault.outputs.vaultName
output registryName string = registry.outputs.registryName
output registryLoginServer string = registry.outputs.loginServer
output searchEndpoint string = search.outputs.endpoint
output storageAccountName string = storage.outputs.storageName
output containerEnvironmentName string = environment.outputs.environmentName
output apiAppName string = names.api
output botAppName string = names.bot
output botServiceName string = names.botService
output apiUrl string = 'https://${apiFqdn}'
output botMessagingEndpoint string = 'https://${botFqdn}/api/messages'
output outboundIp string = enableVnet ? network!.outputs.outboundIp : 'not fixed (no virtual network)'
output apiIdentityClientId string = identities.outputs.apiClientId
output jobsIdentityClientId string = identities.outputs.jobsClientId
