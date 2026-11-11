// Optional virtual network for the Container Apps environment, with a NAT gateway so every
// outbound call leaves from one static public IP. Use it when the Moodle server only accepts
// listed addresses (docs/infrastructure.md, "Moodle reachability").

param location string
param vnetName string
param natGatewayName string
param publicIpName string
param tags object

@description('Address space, e.g. 10.40.0.0/24.')
param addressPrefix string

@description('Container Apps infrastructure subnet; /27 or larger, inside the address space.')
param subnetPrefix string

resource publicIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: publicIpName
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

resource natGateway 'Microsoft.Network/natGateways@2024-05-01' = {
  name: natGatewayName
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    idleTimeoutInMinutes: 10
    publicIpAddresses: [{ id: publicIp.id }]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
    subnets: [
      {
        name: 'container-apps'
        properties: {
          addressPrefix: subnetPrefix
          natGateway: { id: natGateway.id }
          delegations: [
            {
              name: 'container-apps'
              properties: { serviceName: 'Microsoft.App/environments' }
            }
          ]
        }
      }
    ]
  }
}

output subnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'container-apps')
output outboundIp string = publicIp.properties.ipAddress
