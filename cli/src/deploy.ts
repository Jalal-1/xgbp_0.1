import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CompiledContract, ContractExecutable } from '@midnight-ntwrk/compact-js';
import type { ContractAddress } from '@midnight-ntwrk/compact-runtime';
import { findDeployedContract, submitTx } from '@midnight-ntwrk/midnight-js-contracts';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { assertIsContractAddress } from '@midnight-ntwrk/midnight-js-utils';
import {
  ContractDeploy,
  ContractOperationVersionedVerifierKey,
  ContractState as LedgerContractState,
  Intent,
  MaintenanceUpdate,
  Transaction,
  VerifierKeyInsert,
  sampleSigningKey,
  signData,
} from '@midnight-ntwrk/ledger-v8';
import { exitResultOrError, makeContractExecutableRuntime, SucceedEntirely, type FinalizedTxData } from '@midnight-ntwrk/midnight-js-types';
import {
  XGBP,
  createXgbpPrivateState,
  createXgbpWitnesses,
  custodyInstanceSalt,
  initialIssuerAccountId,
  custodySignerCommitmentsForActor,
  type XgbpPrivateState,
} from '@shielded-template/contract';
import { deploymentDirName, deploymentSubdirName, sampleContractName } from './branding.js';
import { artifactPath } from './providers.js';
import { XgbpPrivateStateId, type DeployedXgbpContract, type XgbpCircuitId, type XgbpProviders } from './types.js';
import type { WalletContext } from './wallet.js';

export type DeployOptions = {
  name: string;
  symbol: string;
  decimals: bigint;
  verifierKeyChunkSize: number;
  onProgress?: (message: string, tx?: FinalizedTxData) => void | Promise<void>;
};

const witnesses = createXgbpWitnesses();

const compiledContract = CompiledContract.make<XGBP.Contract<XgbpPrivateState>>(sampleContractName, XGBP.Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(artifactPath),
);

const circuitIds = Object.keys(new XGBP.Contract<XgbpPrivateState>(witnesses).provableCircuits) as XgbpCircuitId[];

const projectRoot = path.resolve(new URL(import.meta.url).pathname, '..', '..', '..');
const ttl = (): Date => new Date(Date.now() + 30 * 60 * 1000);

const report = async (options: DeployOptions, message: string, tx?: FinalizedTxData): Promise<void> => {
  if (options.onProgress !== undefined) {
    await options.onProgress(message, tx);
    return;
  }

  console.log(message);
};

const saveDeployment = async (
  networkName: string,
  contractAddress: ContractAddress,
  options: DeployOptions,
): Promise<void> => {
  const dir = path.join(projectRoot, deploymentDirName, deploymentSubdirName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${networkName}.json`),
    `${JSON.stringify(
      {
        network: networkName,
        contractAddress,
        token: {
          name: options.name,
          symbol: options.symbol,
          decimals: options.decimals.toString(),
        },
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
};

const submitDeployTransaction = async (
  providers: XgbpProviders,
  walletContext: WalletContext,
  initialPrivateState: XgbpPrivateState,
  options: DeployOptions,
): Promise<ContractAddress> => {
  const signingKey = sampleSigningKey();
  const contractExec = ContractExecutable.make(compiledContract);
  const contractRuntime = makeContractExecutableRuntime(providers.zkConfigProvider, {
    coinPublicKey: providers.walletProvider.getCoinPublicKey().toString(),
    signingKey,
  });

  await report(options, `Running ${sampleContractName} constructor locally: token metadata, issuer custody, initial ledger state...`);
  const issuerSignerCommitments = custodySignerCommitmentsForActor(initialPrivateState, 'issuer');
  const exitResult = await contractRuntime.runPromiseExit(
    (contractExec as any).initialize(
      initialPrivateState,
      options.name,
      options.symbol,
      options.decimals,
      initialIssuerAccountId(initialPrivateState),
      custodyInstanceSalt(initialPrivateState),
      issuerSignerCommitments[0],
      issuerSignerCommitments[1],
      issuerSignerCommitments[2],
    ),
  );
  const initResult = exitResultOrError(exitResult as any) as any;

  // The full constructor state includes all verifier keys. For this CFT that
  // can exceed standalone block limits, so the deploy transaction carries the
  // contract data and maintenance authority first. Verifier keys are inserted
  // afterward.
  const fullState = LedgerContractState.deserialize(initResult.public.contractState.serialize());
  const deployState = new LedgerContractState();
  deployState.data = fullState.data;
  deployState.maintenanceAuthority = fullState.maintenanceAuthority;

  const contractDeploy = new ContractDeploy(deployState);
  const contractAddress = contractDeploy.address as unknown as ContractAddress;
  const unprovenTx = Transaction.fromParts(
    getNetworkId(),
    undefined,
    undefined,
    Intent.new(ttl()).addDeploy(contractDeploy),
  );

  await report(options, 'Preparing deploy transaction: contract data now, verifier keys afterward...');
  await report(options, 'Balancing deploy transaction with wallet fees and DUST...');
  const recipe = await walletContext.wallet.balanceUnprovenTransaction(
    unprovenTx as any,
    {
      shieldedSecretKeys: walletContext.shieldedSecretKeys,
      dustSecretKey: walletContext.dustSecretKey,
    },
    { ttl: ttl() },
  );
  await report(options, 'Signing deploy transaction...');
  const signedRecipe = await walletContext.wallet.signRecipe(recipe, (payload) =>
    walletContext.unshieldedKeystore.signData(payload),
  );
  await report(options, 'Finalizing deploy transaction...');
  const finalizedTx = await walletContext.wallet.finalizeRecipe(signedRecipe);
  await report(options, 'Submitting deploy transaction to local node...');
  const txId = await walletContext.wallet.submitTransaction(finalizedTx);
  await report(options, 'Waiting for deploy finality from indexer...');
  const txData = await providers.publicDataProvider.watchForTxData(txId as any);

  if (txData.status !== SucceedEntirely) {
    throw new Error(`Deploy failed with status ${txData.status}`);
  }

  providers.privateStateProvider.setContractAddress(contractAddress);
  await providers.privateStateProvider.set(XgbpPrivateStateId, initResult.private.privateState);
  await providers.privateStateProvider.setSigningKey(contractAddress, initResult.private.signingKey);

  await report(options, `Deploy finalized: ${contractAddress}`, txData);
  return contractAddress;
};

const submitVerifierKeyChunk = async (
  providers: XgbpProviders,
  contractAddress: ContractAddress,
  ids: XgbpCircuitId[],
  options: DeployOptions,
): Promise<FinalizedTxData> => {
  await report(options, 'Reading latest contract maintenance state...');
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (contractState === null || contractState === undefined) {
    throw new Error(`No contract state found for ${contractAddress}`);
  }

  const signingKey = await providers.privateStateProvider.getSigningKey(contractAddress);
  if (signingKey === null || signingKey === undefined) {
    throw new Error(`No maintenance signing key found for ${contractAddress}`);
  }

  const inserts: VerifierKeyInsert[] = [];
  await report(options, `Loading ${ids.length} verifier key(s) from generated artifacts...`);
  for (const circuitId of ids) {
    if (contractState.operation(circuitId) !== undefined) {
      continue;
    }

    const verifierKey = await providers.zkConfigProvider.getVerifierKey(circuitId);
    inserts.push(new VerifierKeyInsert(circuitId, new ContractOperationVersionedVerifierKey('v3', verifierKey)));
  }

  if (inserts.length === 0) {
    throw new Error('Verifier key chunk is already published');
  }

  // Maintenance replay protection is a per-contract counter. Because the
  // signature covers the whole batch, chunks must be submitted sequentially.
  const update = new MaintenanceUpdate(contractAddress, inserts, contractState.maintenanceAuthority.counter);
  const signedUpdate = update.addSignature(0n, signData(signingKey, update.dataToSign));
  const unprovenTx = Transaction.fromParts(
    getNetworkId(),
    undefined,
    undefined,
    Intent.new(ttl()).addMaintenanceUpdate(signedUpdate),
  );

  await report(options, 'Submitting verifier-key maintenance transaction and waiting for finality...');
  const finalized = await submitTx(providers as any, { unprovenTx });
  if (finalized.status !== SucceedEntirely) {
    throw new Error(`Verifier-key chunk failed with status ${finalized.status}`);
  }
  await report(options, `Verifier-key maintenance finalized: block ${finalized.blockHeight}`, finalized);
  return finalized;
};

const publishVerifierKeysAdaptive = async (
  providers: XgbpProviders,
  contractAddress: ContractAddress,
  options: DeployOptions,
): Promise<void> => {
  let index = 0;
  let chunkSizeLimit = options.verifierKeyChunkSize;

  while (index < circuitIds.length) {
    const remaining = circuitIds.slice(index);
    const chunkSize = Math.min(Math.max(1, chunkSizeLimit), remaining.length);
    const chunk = remaining.slice(0, chunkSize);

    try {
      await report(
        options,
        `Publishing verifier keys ${index + 1}-${index + chunk.length}/${circuitIds.length} as one maintenance chunk...`,
      );
      await submitVerifierKeyChunk(providers, contractAddress, chunk, options);
      index += chunk.length;
    } catch (error) {
      if (chunk.length === 1) {
        throw error;
      }

      // Standalone block limits can vary by verifier-key size. If a chunk is
      // too large, halve it and retry without advancing the cursor.
      chunkSizeLimit = Math.max(1, Math.floor(chunk.length / 2));
      await report(options, `Chunk too large; retrying with chunk size ${chunkSizeLimit}`);
    }
  }
};

const joinContract = async (
  providers: XgbpProviders,
  contractAddress: string,
): Promise<DeployedXgbpContract> => {
  assertIsContractAddress(contractAddress);
  const initialPrivateState = createXgbpPrivateState();
  const contract = await findDeployedContract(providers as any, {
    contractAddress,
    compiledContract,
    privateStateId: XgbpPrivateStateId,
    initialPrivateState,
  });
  providers.privateStateProvider.setContractAddress(contract.deployTxData.public.contractAddress as ContractAddress);
  await providers.privateStateProvider.set(XgbpPrivateStateId, initialPrivateState);
  return contract as DeployedXgbpContract;
};

export const deployXgbp = async (
  providers: XgbpProviders,
  walletContext: WalletContext,
  networkName: string,
  options: DeployOptions,
): Promise<DeployedXgbpContract> => {
  const initialPrivateState = createXgbpPrivateState();
  const contractAddress = await submitDeployTransaction(providers, walletContext, initialPrivateState, options);

  await publishVerifierKeysAdaptive(providers, contractAddress, options);
  await report(options, `Binding CLI session to deployed ${sampleContractName} contract...`);
  const contract = await joinContract(providers, contractAddress);
  await report(options, `Saving deployment record under ${deploymentDirName}/${deploymentSubdirName}/...`);
  await saveDeployment(networkName, contract.deployTxData.public.contractAddress as ContractAddress, options);

  return contract;
};
