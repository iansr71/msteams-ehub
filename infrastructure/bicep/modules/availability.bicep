// Availability tests from three European locations, and an alert when two or more fail.
// The API's /health/ready reports Moodle, Search, the model and the state store, so this catches
// a broken dependency even when nobody is asking questions (docs/observability.md).

param location string
param tags object
param appInsightsName string
param environmentName string

@description('https://<API FQDN>/health/ready')
param apiReadyUrl string

@description('https://<bot FQDN>/health/live')
param botLiveUrl string

@description('Email addresses for availability alerts; empty for no alert.')
param alertEmails array

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

var tests = [
  { key: 'api-ready', title: 'E-Hub API ready (${environmentName})', url: apiReadyUrl }
  { key: 'bot-live', title: 'E-Hub bot live (${environmentName})', url: botLiveUrl }
]
var testLocations = [
  { Id: 'emea-nl-ams-azr' }
  { Id: 'emea-gb-db3-azr' }
  { Id: 'emea-ru-msa-edge' }
]

resource webTests 'Microsoft.Insights/webtests@2022-06-15' = [
  for test in tests: {
    name: 'ehub-${environmentName}-${test.key}'
    location: location
    tags: union(tags, { 'hidden-link:${appInsights.id}': 'Resource' })
    kind: 'standard'
    properties: {
      SyntheticMonitorId: 'ehub-${environmentName}-${test.key}'
      Name: test.title
      Kind: 'standard'
      Enabled: true
      Frequency: 300
      Timeout: 30
      RetryEnabled: true
      Locations: testLocations
      Request: {
        RequestUrl: test.url
        HttpVerb: 'GET'
        ParseDependentRequests: false
      }
      ValidationRules: {
        ExpectedHttpStatusCode: 200
        SSLCheck: true
        SSLCertRemainingLifetimeCheck: 7
      }
    }
  }
]

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (!empty(alertEmails)) {
  name: 'ehub-${environmentName}-ops'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: take('ehub${environmentName}', 12)
    enabled: true
    emailReceivers: [
      for (email, i) in alertEmails: {
        name: 'ops-${i}'
        emailAddress: email
        useCommonAlertSchema: true
      }
    ]
  }
}

resource alerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [
  for (test, i) in tests: if (!empty(alertEmails)) {
    name: 'ehub-${environmentName}-${test.key}-unavailable'
    location: 'global'
    tags: tags
    properties: {
      description: '${test.title} failed from two or more locations.'
      severity: 1
      enabled: true
      scopes: [webTests[i].id, appInsights.id]
      evaluationFrequency: 'PT5M'
      windowSize: 'PT15M'
      criteria: {
        'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
        webTestId: webTests[i].id
        componentId: appInsights.id
        failedLocationCount: 2
      }
      actions: [{ actionGroupId: actionGroup.id }]
    }
  }
]
