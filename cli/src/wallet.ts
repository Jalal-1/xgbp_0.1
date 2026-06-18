import { Buffer } from 'node:buffer';
import { nativeToken, type DustSecretKey, type ZswapSecretKeys } from '@midnight-ntwrk/ledger-v8';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles, generateRandomSeed } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { createKeystore, InMemoryTransactionHistoryStorage, PublicKey, UnshieldedWallet, type UnshieldedKeystore } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';
import type { NetworkConfig } from './config.js';

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

export type WalletContext = {
  wallet: WalletFacade;
  shieldedSecretKeys: ZswapSecretKeys;
  dustSecretKey: DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
  seed: string;
};

export type WalletBuildOptions = {
  onProgress?: (message: string) => void | Promise<void>;
  printSeed?: boolean;
};

const formatAmount = (amount: bigint): string => amount.toLocaleString();
const standaloneGenesisSeed = '0000000000000000000000000000000000000000000000000000000000000001';
const walletWaitMs = 120_000;

const report = async (options: WalletBuildOptions | undefined, message: string): Promise<void> => {
  if (options?.onProgress !== undefined) {
    await options.onProgress(message);
    return;
  }

  console.log(message);
};

const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${walletWaitMs / 1000}s`));
    }, walletWaitMs);
  });

  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const deriveKeysFromSeed = (seed: string) => {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') {
    throw new Error('Failed to initialize wallet from seed');
  }

  const derived = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derived.type !== 'keysDerived') {
    throw new Error('Failed to derive Midnight wallet keys');
  }

  hdWallet.hdWallet.clear();
  return derived.keys;
};

const shieldedConfig = (network: NetworkConfig) => ({
  networkId: getNetworkId(),
  indexerClientConnection: {
    indexerHttpUrl: network.indexer,
    indexerWsUrl: network.indexerWs,
  },
  provingServerUrl: new URL(network.proofServer),
  relayURL: new URL(network.node.replace(/^http/, 'ws')),
});

const unshieldedConfig = (network: NetworkConfig) => ({
  networkId: getNetworkId(),
  indexerClientConnection: {
    indexerHttpUrl: network.indexer,
    indexerWsUrl: network.indexerWs,
  },
  txHistoryStorage: new InMemoryTransactionHistoryStorage(),
});

const dustConfig = (network: NetworkConfig) => ({
  networkId: getNetworkId(),
  costParameters: {
    additionalFeeOverhead: 300_000_000_000_000n,
    feeBlocksMargin: 5,
  },
  indexerClientConnection: {
    indexerHttpUrl: network.indexer,
    indexerWsUrl: network.indexerWs,
  },
  provingServerUrl: new URL(network.proofServer),
  relayURL: new URL(network.node.replace(/^http/, 'ws')),
});

const waitForSync = (wallet: WalletFacade) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.filter((state) => state.isSynced),
    ),
  );

const waitForFunds = (wallet: WalletFacade): Promise<bigint> =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(10_000),
      Rx.filter((state) => state.isSynced),
      Rx.map((state) => state.unshielded.balances[nativeToken().raw] ?? 0n),
      Rx.filter((balance) => balance > 0n),
    ),
  );

const waitForDust = (wallet: WalletFacade) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.filter((state) => state.isSynced),
      Rx.filter((state) => state.dust.balance(new Date()) > 0n),
    ),
  );

const ensureDust = async (ctx: WalletContext, options?: WalletBuildOptions): Promise<void> => {
  await report(options, 'Checking DUST coins for transaction fees...');
  const state = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));

  if (state.dust.availableCoins.length > 0) {
    await report(options, `Dust available: ${formatAmount(state.dust.balance(new Date()))}`);
    return;
  }

  const nightUtxos = state.unshielded.availableCoins.filter(
    (coin: { meta?: { registeredForDustGeneration?: boolean } }) => coin.meta?.registeredForDustGeneration !== true,
  );

  if (nightUtxos.length > 0) {
    await report(options, `No DUST found; registering ${nightUtxos.length} NIGHT UTXO(s) for DUST generation...`);
    const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(
      nightUtxos,
      ctx.unshieldedKeystore.getPublicKey(),
      (payload) => ctx.unshieldedKeystore.signData(payload),
    );
    await report(options, 'Submitting DUST registration transaction...');
    const finalized = await ctx.wallet.finalizeRecipe(recipe);
    await ctx.wallet.submitTransaction(finalized);
  }

  await report(options, 'Waiting for DUST generation from registered NIGHT...');
  await withTimeout(waitForDust(ctx.wallet), 'DUST generation');
};

const defaultSeed = (network: NetworkConfig): string =>
  network.networkId === 'undeployed' ? standaloneGenesisSeed : toHex(Buffer.from(generateRandomSeed()));

export const buildWallet = async (
  network: NetworkConfig,
  seed = defaultSeed(network),
  options?: WalletBuildOptions,
): Promise<WalletContext> => {
  await report(options, 'Deriving Midnight wallet keys from seed...');
  const keys = deriveKeysFromSeed(seed);
  const zswap = await import('@midnight-ntwrk/ledger-v8');
  const shieldedSecretKeys = zswap.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = zswap.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

  const shielded = shieldedConfig(network);
  const unshielded = unshieldedConfig(network);
  const dust = dustConfig(network);

  await report(options, 'Initializing wallet services: shielded, unshielded, and DUST...');
  const wallet = await WalletFacade.init({
    configuration: { ...shielded, ...unshielded, ...dust },
    shielded: () => ShieldedWallet(shielded).startWithSecretKeys(shieldedSecretKeys),
    unshielded: () => UnshieldedWallet(unshielded).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: () => DustWallet(dust).startWithSecretKey(dustSecretKey, zswap.LedgerParameters.initialParameters().dust),
  });

  await report(options, 'Starting wallet and connecting to node/indexer...');
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  const ctx = { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, seed };
  const address = unshieldedKeystore.getBech32Address().asString();
  await report(options, `Wallet address: ${address}`);
  if (options?.printSeed !== false) {
    await report(options, `Wallet seed: ${seed}`);
  }

  await report(options, 'Waiting for wallet sync from indexer...');
  const synced = await withTimeout(waitForSync(wallet), 'Wallet sync');
  await report(options, 'Checking unshielded NIGHT balance...');
  const balance = synced.unshielded.balances[nativeToken().raw] ?? 0n;
  if (balance === 0n) {
    await report(options, 'Waiting for NIGHT funding on this wallet address...');
    await withTimeout(waitForFunds(wallet), 'NIGHT funding');
  } else {
    await report(options, `NIGHT balance: ${formatAmount(balance)}`);
  }

  await ensureDust(ctx, options);
  return ctx;
};
