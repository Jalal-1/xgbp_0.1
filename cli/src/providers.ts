import * as ledger from '@midnight-ntwrk/ledger-v8';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import type { MidnightProvider, UnboundTransaction, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';
import { privateStatePassword, privateStateStoreName, sampleContractName } from './branding.js';
import type { NetworkConfig } from './config.js';
import type { XgbpCircuitId, XgbpPrivateStateId, XgbpProviders } from './types.js';
import type { WalletContext } from './wallet.js';

// Apollo subscriptions used by the indexer provider need a WebSocket in Node.
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

export const artifactPath = new URL(`../../contract/dist/artifacts/${sampleContractName}/`, import.meta.url).pathname;

const createWalletAndMidnightProvider = async (
  ctx: WalletContext,
): Promise<WalletProvider & MidnightProvider> => {
  await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((state) => state.isSynced)));

  return {
    getCoinPublicKey(): ledger.CoinPublicKey {
      return ctx.shieldedSecretKeys.coinPublicKey;
    },
    getEncryptionPublicKey(): ledger.EncPublicKey {
      return ctx.shieldedSecretKeys.encryptionPublicKey;
    },

    // midnight-js asks for an unbound transaction; wallet-sdk adds fees/DUST,
    // proves what must be proved, and returns a finalized ledger transaction.
    async balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<ledger.FinalizedTransaction> {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return await ctx.wallet.finalizeRecipe(recipe);
    },

    async submitTx(tx: ledger.FinalizedTransaction): Promise<ledger.TransactionId> {
      return await ctx.wallet.submitTransaction(tx);
    },
  };
};

export const configureProviders = async (ctx: WalletContext, network: NetworkConfig): Promise<XgbpProviders> => {
  const walletAndMidnightProvider = await createWalletAndMidnightProvider(ctx);
  const zkConfigProvider = new NodeZkConfigProvider<XgbpCircuitId>(artifactPath);

  return {
    privateStateProvider: levelPrivateStateProvider<XgbpPrivateStateId>({
      privateStateStoreName,
      privateStoragePasswordProvider: () => privateStatePassword,
      accountId: ctx.unshieldedKeystore.getBech32Address().asString(),
    }),
    publicDataProvider: indexerPublicDataProvider(network.indexer, network.indexerWs),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(network.proofServer, zkConfigProvider),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
};
