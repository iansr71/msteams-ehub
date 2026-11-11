// Production: two search replicas (Azure AI Search's read SLA needs two), deletion locks on
// Search and Storage, Key Vault purge protection, geo-redundant storage, 90-day log retention.
// Tenant-specific values come from environment variables
// (infrastructure/environments/prod.env, not committed; see prod.env.example).
using '../main.bicep'

param environmentName = 'prod'
param namePrefix = readEnvironmentVariable('EHUB_NAME_PREFIX', 'ehub')
param deployApps = bool(readEnvironmentVariable('EHUB_DEPLOY_APPS', 'false'))
param imageTag = readEnvironmentVariable('EHUB_IMAGE_TAG', '')
param deployerPrincipalId = readEnvironmentVariable('EHUB_DEPLOYER_OBJECT_ID', '')
param deployerPrincipalType = readEnvironmentVariable('EHUB_DEPLOYER_PRINCIPAL_TYPE', 'User')

param logRetentionDays = 90
param logDailyQuotaGb = 5
param keyVaultSoftDeleteDays = 90
param keyVaultPurgeProtection = true
param searchSku = 'basic'
param searchReplicaCount = 2
param searchPartitionCount = 1
param searchSemantic = 'free'
param protectData = true
param storageSku = 'Standard_GRS'
param stateShareQuotaGb = 20
param storageSoftDeleteDays = 30
param registrySku = 'Standard'
param enableVnet = bool(readEnvironmentVariable('EHUB_ENABLE_VNET', 'false'))

param openAiAccountName = readEnvironmentVariable('EHUB_OPENAI_ACCOUNT_NAME')
param openAiResourceGroup = readEnvironmentVariable('EHUB_OPENAI_RESOURCE_GROUP')
param openAiEndpoint = readEnvironmentVariable('EHUB_OPENAI_ENDPOINT')
param openAiChatDeployment = readEnvironmentVariable('EHUB_OPENAI_CHAT_DEPLOYMENT')
param openAiEmbeddingDeployment = readEnvironmentVariable('EHUB_OPENAI_EMBEDDING_DEPLOYMENT')
param embeddingDimensions = int(readEnvironmentVariable('EHUB_EMBEDDING_DIMENSIONS'))

param moodleBaseUrl = readEnvironmentVariable('EHUB_MOODLE_BASE_URL')
param syncCourseIds = readEnvironmentVariable('EHUB_SYNC_COURSE_IDS', '')
param entraApiClientId = readEnvironmentVariable('EHUB_ENTRA_API_CLIENT_ID')
param botClientId = readEnvironmentVariable('EHUB_BOT_CLIENT_ID')
param adminSpaClientId = readEnvironmentVariable('EHUB_ADMIN_SPA_CLIENT_ID', '')
param botSku = 'F0'
param alertEmails = empty(readEnvironmentVariable('EHUB_ALERT_EMAILS', ''))
  ? []
  : split(readEnvironmentVariable('EHUB_ALERT_EMAILS', ''), ',')
