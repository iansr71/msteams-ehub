// Development environment: the smallest sizes, a free search tier without semantic ranking,
// no locks. Tenant-specific values come from environment variables
// (infrastructure/environments/dev.env, not committed; see dev.env.example).
using '../main.bicep'

param environmentName = 'dev'
param namePrefix = readEnvironmentVariable('EHUB_NAME_PREFIX', 'ehub')
param deployApps = bool(readEnvironmentVariable('EHUB_DEPLOY_APPS', 'false'))
param imageTag = readEnvironmentVariable('EHUB_IMAGE_TAG', '')
param deployerPrincipalId = readEnvironmentVariable('EHUB_DEPLOYER_OBJECT_ID', '')
param deployerPrincipalType = readEnvironmentVariable('EHUB_DEPLOYER_PRINCIPAL_TYPE', 'User')

param logRetentionDays = 30
param logDailyQuotaGb = 1
param keyVaultSoftDeleteDays = 7
param keyVaultPurgeProtection = false
param searchSku = 'free'
param searchReplicaCount = 1
param searchPartitionCount = 1
param searchSemantic = 'disabled'
param protectData = false
param storageSku = 'Standard_LRS'
param stateShareQuotaGb = 1
param storageSoftDeleteDays = 7
param registrySku = 'Basic'
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
