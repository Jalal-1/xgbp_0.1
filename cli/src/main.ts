import { deployXgbp } from './deploy.js';
import { isNetworkName, networks, selectNetwork } from './config.js';
import { localNetworkDown, localNetworkStatus, localNetworkUp } from './docker.js';
import { configureProviders } from './providers.js';
import { runTui } from './tui.js';
import { buildWallet, type WalletContext } from './wallet.js';

type CliOptions = Record<string, string | boolean>;

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;

    const key = arg.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      options[key] = true;
      continue;
    }

    options[key] = value;
    i += 1;
  }
  return options;
}

function optionString(options: CliOptions, key: string, fallback: string): string {
  const value = options[key];
  return typeof value === 'string' ? value : fallback;
}

function optionInteger(options: CliOptions, key: string, fallback: number): number {
  const raw = options[key];
  if (typeof raw !== 'string') return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${key} must be a positive integer`);
  }
  return value;
}

function usage(): void {
  console.log(`
XGBP CLI

Usage:
  npm run cli -- deploy [--network local] [--name XGBP] [--symbol XGBP] [--decimals 2] [--vk-chunk-size 8] [--seed <hex>]
  npm run cli -- tui [--network local]
  npm run cli -- network up
  npm run cli -- network down
  npm run cli -- network status
  npm run cli -- networks

Configured networks:
  local    ${networks.local.node}
  preview  ${networks.preview.node}
  preprod  ${networks.preprod.node}
`);
}

async function main(argv: string[]): Promise<void> {
  const [command, subcommand, ...rest] = argv;

  if (command === 'networks') {
    for (const network of Object.values(networks)) {
      console.log(`${network.name.padEnd(8)} node=${network.node} indexer=${network.indexer}`);
    }
    return;
  }

  if (command === 'network') {
    switch (subcommand) {
      case 'up':
        await localNetworkUp();
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

  if (command === 'tui') {
    const options = parseOptions([subcommand, ...rest].filter((value): value is string => value !== undefined));
    const networkName = optionString(options, 'network', 'local');
    if (!isNetworkName(networkName)) {
      throw new Error(`Unknown network: ${networkName}`);
    }

    await runTui(networkName, selectNetwork(networkName));
    return;
  }

  if (command === 'deploy') {
    const options = parseOptions([subcommand, ...rest].filter((value): value is string => value !== undefined));
    const networkName = optionString(options, 'network', 'local');
    if (!isNetworkName(networkName)) {
      throw new Error(`Unknown network: ${networkName}`);
    }

    const network = selectNetwork(networkName);
    const deployOptions = {
      name: optionString(options, 'name', 'XGBP'),
      symbol: optionString(options, 'symbol', 'XGBP'),
      decimals: BigInt(optionInteger(options, 'decimals', 2)),
      verifierKeyChunkSize: optionInteger(options, 'vk-chunk-size', 8),
    };
    const seed = typeof options.seed === 'string' ? options.seed : undefined;
    let wallet: WalletContext | undefined;

    try {
      wallet = await buildWallet(network, seed);
      const providers = await configureProviders(wallet, network);
      const contract = await deployXgbp(providers, wallet, networkName, deployOptions);

      console.log(`XGBP deployed: ${contract.deployTxData.public.contractAddress}`);
    } finally {
      await wallet?.wallet.stop();
    }
    return;
  }

  usage();
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
