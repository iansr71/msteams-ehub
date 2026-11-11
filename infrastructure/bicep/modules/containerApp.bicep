// One HTTPS service (the answer API or the Teams bot) from the shared image.

param location string
param appName string
param tags object
param environmentId string

@description('User-assigned identity used for image pulls, Key Vault references and Azure calls.')
param identityId string

param registryServer string
param image string

@description('Container command, e.g. ["node", "apps/api/dist/cli.js", "serve"].')
param command array

@description('Plain settings: [{ name, value }].')
param env array

@description('Key Vault-backed settings: [{ name, secretName }] become secret references.')
param secretEnv array

param vaultUri string
param targetPort int

@description('CPU cores, e.g. "0.5".')
param cpu string

@description('Memory, e.g. "1Gi"; must match the CPU (0.5 → 1Gi, 1 → 2Gi).')
param memory string

param minReplicas int
param maxReplicas int

@description('Mount the state share at /mnt/state (environment storage name), or empty.')
param stateStorageName string

var secrets = [
  for item in secretEnv: {
    name: item.secretName
    keyVaultUrl: '${vaultUri}secrets/${item.secretName}'
    identity: identityId
  }
]
var secretRefs = [for item in secretEnv: { name: item.name, secretRef: item.secretName }]

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      // Single: a new revision replaces the old one; rollback redeploys the previous image
      // (infrastructure/scripts/rollback.*).
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 10
      ingress: {
        external: true
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
        traffic: [{ latestRevision: true, weight: 100 }]
      }
      registries: [{ server: registryServer, identity: identityId }]
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: appName
          image: image
          command: command
          env: concat(env, secretRefs)
          resources: { cpu: json(cpu), memory: memory }
          probes: [
            // Platform probes use liveness only. Readiness (/health/ready) depends on Moodle,
            // Search and the model, which every replica shares: failing it would take the
            // only replica out of service, admin page included, without routing anywhere
            // better. It is monitored by an availability test instead.
            {
              type: 'Startup'
              httpGet: { path: '/health/live', port: targetPort }
              initialDelaySeconds: 2
              periodSeconds: 3
              failureThreshold: 20
            }
            {
              type: 'Liveness'
              httpGet: { path: '/health/live', port: targetPort }
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health/live', port: targetPort }
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
          volumeMounts: empty(stateStorageName) ? [] : [{ volumeName: 'state', mountPath: '/mnt/state' }]
        }
      ]
      scale: { minReplicas: minReplicas, maxReplicas: maxReplicas }
      volumes: empty(stateStorageName)
        ? []
        : [
            {
              name: 'state'
              storageType: 'AzureFile'
              storageName: stateStorageName
              // The image runs as `node` (uid 1000); without these the share is root-owned.
              mountOptions: 'uid=1000,gid=1000,dir_mode=0700,file_mode=0600'
            }
          ]
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output latestRevisionName string = app.properties.latestRevisionName
