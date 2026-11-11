// Azure Bot registration for the Teams personal app, with the Microsoft Teams channel.
// The SSO OAuth connection is created afterwards by infrastructure/scripts/configure-bot-sso.*:
// it needs the bot's client secret, and the Entra ID provider's identifier is not documented for
// templates, so the script looks it up with `az bot authsetting list-providers`.

param botName string
param tags object

@description('Bot app registration (client) ID: TEAMS_BOT_CLIENT_ID.')
param botClientId string

param tenantId string

@description('https://<bot app FQDN>/api/messages')
param messagingEndpoint string

@allowed(['F0', 'S1'])
param sku string

param displayName string

resource bot 'Microsoft.BotService/botServices@2022-09-15' = {
  name: botName
  // Bot registrations are global resources.
  location: 'global'
  tags: tags
  kind: 'azurebot'
  sku: { name: sku }
  properties: {
    displayName: displayName
    endpoint: messagingEndpoint
    msaAppId: botClientId
    msaAppType: 'SingleTenant'
    msaAppTenantId: tenantId
    publicNetworkAccess: 'Enabled'
  }
}

resource teams 'Microsoft.BotService/botServices/channels@2022-09-15' = {
  parent: bot
  name: 'MsTeamsChannel'
  location: 'global'
  properties: {
    channelName: 'MsTeamsChannel'
    properties: {
      isEnabled: true
    }
  }
}

output botName string = bot.name
