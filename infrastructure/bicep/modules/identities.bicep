// One user-assigned managed identity per workload, so each gets only the roles it needs.

param location string
param apiIdentityName string
param botIdentityName string
param jobsIdentityName string
param tags object

resource api 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: apiIdentityName
  location: location
  tags: tags
}

resource bot 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: botIdentityName
  location: location
  tags: tags
}

resource jobs 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: jobsIdentityName
  location: location
  tags: tags
}

output apiId string = api.id
output apiPrincipalId string = api.properties.principalId
output apiClientId string = api.properties.clientId
output botId string = bot.id
output botPrincipalId string = bot.properties.principalId
output botClientId string = bot.properties.clientId
output jobsId string = jobs.id
output jobsPrincipalId string = jobs.properties.principalId
output jobsClientId string = jobs.properties.clientId
