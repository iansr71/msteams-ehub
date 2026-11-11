// Key Vault Secrets User on individual secrets, so each identity reads only what it needs.
// Stage 2 only: the secrets must already exist (the deploy scripts check first).

param vaultName string

@description('Pairs of { principalId, secretName }.')
param grants array

var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: vaultName
}

resource secrets 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = [
  for grant in grants: {
    parent: vault
    name: grant.secretName
  }
]

resource access 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (grant, i) in grants: {
    name: guid(secrets[i].id, grant.principalId, keyVaultSecretsUser)
    scope: secrets[i]
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
      principalId: grant.principalId
      principalType: 'ServicePrincipal'
    }
  }
]
