export type NetworkName = 'local' | 'preview' | 'preprod';

export type NetworkConfig = {
  name: NetworkName;
  networkId: 'undeployed' | 'preview' | 'preprod';
  node: string;
  indexer: string;
  indexerWs: string;
  proofServer: string;
};

export const networks: Record<NetworkName, NetworkConfig> = {
  local: {
    name: 'local',
    networkId: 'undeployed',
    node: 'http://127.0.0.1:9944',
    indexer: 'http://127.0.0.1:8088/api/v4/graphql',
    indexerWs: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
    proofServer: 'http://127.0.0.1:6300',
  },
  preview: {
    name: 'preview',
    networkId: 'preview',
    node: 'https://rpc.preview.midnight.network',
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    proofServer: 'http://127.0.0.1:6300',
  },
  preprod: {
    name: 'preprod',
    networkId: 'preprod',
    node: 'https://rpc.preprod.midnight.network',
    indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    proofServer: 'http://127.0.0.1:6300',
  },
};

