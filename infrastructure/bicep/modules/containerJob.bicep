// A scheduled Container Apps job from the shared image (sync, enrolment refresh, reconciliation).
// Overlapping runs are safe: sync jobs take a lease per course in the state store.

param location string
param jobName string
param tags object
param environmentId string
param identityId string
param registryServer string
param image string
param command array
param env array
param secretEnv array
param vaultUri string

@description('Five-field cron expression, evaluated in UTC.')
param cronExpression string

@description('Seconds before a run is stopped.')
param replicaTimeoutSeconds int

param cpu string
param memory string
param stateStorageName string

var secrets = [
  for item in secretEnv: {
    name: item.secretName
    keyVaultUrl: '${vaultUri}secrets/${item.secretName}'
    identity: identityId
  }
]
var secretRefs = [for item in secretEnv: { name: item.name, secretRef: item.secretName }]

resource job 'Microsoft.App/jobs@2025-01-01' = {
  name: jobName
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
      triggerType: 'Schedule'
      scheduleTriggerConfig: {
        cronExpression: cronExpression
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: replicaTimeoutSeconds
      // The sync jobs retry failed resources themselves (with backoff and dead-lettering); a
      // platform retry of the whole run would only repeat that work.
      replicaRetryLimit: 0
      registries: [{ server: registryServer, identity: identityId }]
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: jobName
          image: image
          command: command
          env: concat(env, secretRefs)
          resources: { cpu: json(cpu), memory: memory }
          volumeMounts: [{ volumeName: 'state', mountPath: '/mnt/state' }]
        }
      ]
      volumes: [
        {
          name: 'state'
          storageType: 'AzureFile'
          storageName: stateStorageName
          mountOptions: 'uid=1000,gid=1000,dir_mode=0700,file_mode=0600'
        }
      ]
    }
  }
}

output jobName string = job.name
