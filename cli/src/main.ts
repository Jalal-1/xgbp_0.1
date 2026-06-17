import { networks } from './config.js';
import { localNetworkDown, localNetworkStatus, localNetworkUp } from './docker.js';

function usage(): void {
  console.log(`
MGBP CLI

Usage:
  npm run cli -- network up
  npm run cli -- network down
  npm run cli -- network status
  npm run cli -- networks

Networks configured for future deploys:
  local    ${networks.local.node}
  preview  ${networks.preview.node}
  preprod  ${networks.preprod.node}
`);
}

async function main(argv: string[]): Promise<void> {
  const [command, subcommand] = argv;

  if (command === 'networks') {
    for (const network of Object.values(networks)) {
      console.log(`${network.name.padEnd(8)} node=${network.node} indexer=${network.indexer}`);
    }
    return;
  }

  if (command === 'network') {
    switch (subcommand) {
      case 'up':
        localNetworkUp();
        return;
      case 'down':
        localNetworkDown();
        return;
      case 'status':
        localNetworkStatus();
        return;
      default:
        usage();
        return;
    }
  }

  usage();
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
