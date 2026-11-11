// Grants Cognitive Services OpenAI User on an Azure OpenAI (or Azure AI Foundry) account that is
// deployed and managed separately, possibly in another resource group. Deployed at that
// resource group's scope by main.bicep.

param accountName string

@description('Identities that call the chat and embedding deployments.')
param principalIds array

var cognitiveServicesOpenAiUser = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: accountName
}

resource access 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in principalIds: {
    name: guid(account.id, principalId, cognitiveServicesOpenAiUser)
    scope: account
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAiUser)
      principalId: principalId
      principalType: 'ServicePrincipal'
    }
  }
]

output endpoint string = account.properties.endpoint
