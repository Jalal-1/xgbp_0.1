import {
  actorNames,
  cachePlaintextForActor,
  createXgbpPrivateState,
  describeActor,
  normalizeXgbpPrivateState,
  setActiveActor,
  setActorBalance,
  setActorFrozen,
  setActorKycApproved,
  setActorRegistered,
  setKycRequiredFlag,
  setTotalSupply,
  type ActorName,
  type XgbpPrivateState,
} from '@xgbp/xgbp-contract';
import type { FinalizedTxData } from '@midnight-ntwrk/midnight-js-types';
import { XgbpPrivateStateId, type DeployedXgbpContract, type XgbpProviders } from './types.js';

export type ActorStatus = {
  actor: ActorName;
  accountId: Uint8Array;
  knownBalance: bigint;
  registered: boolean;
  kycApproved: boolean;
  frozen: boolean;
};

export type ContractSnapshot = {
  kycRequired: boolean;
  totalSupply: bigint;
  actors: ActorStatus[];
};

export type TxReference = {
  operation: string;
  txId: string;
  txHash: string;
  blockHash: string;
  blockHeight: number;
  status: string;
};

export type OperationResult = {
  onchain: TxReference[];
  local: string[];
};

type RefreshResult = {
  state: XgbpPrivateState;
  result: OperationResult;
};

export const txReference = (operation: string, tx: FinalizedTxData): TxReference => ({
  operation,
  txId: String(tx.txId),
  txHash: String(tx.txHash),
  blockHash: String(tx.blockHash),
  blockHeight: tx.blockHeight,
  status: tx.status,
});

const actorLabel = (actor: ActorName): string => {
  switch (actor) {
    case 'issuer':
      return 'Issuer';
    case 'alice':
      return 'Alice';
    case 'bob':
      return 'Bob';
  }
};

const local = (...messages: string[]): OperationResult => ({ onchain: [], local: messages });

const mergeResults = (...results: OperationResult[]): OperationResult => ({
  onchain: results.flatMap((result) => result.onchain),
  local: results.flatMap((result) => result.local),
});

const getPrivateState = async (providers: XgbpProviders): Promise<XgbpPrivateState> => {
  const existing = await providers.privateStateProvider.get(XgbpPrivateStateId);
  return existing === null || existing === undefined
    ? createXgbpPrivateState()
    : normalizeXgbpPrivateState(existing);
};

const savePrivateState = async (providers: XgbpProviders, state: XgbpPrivateState): Promise<void> => {
  await providers.privateStateProvider.set(XgbpPrivateStateId, normalizeXgbpPrivateState(state));
};

const activateActor = async (providers: XgbpProviders, actor: ActorName): Promise<XgbpPrivateState> => {
  const state = setActiveActor(await getPrivateState(providers), actor);
  await savePrivateState(providers, state);
  return state;
};

const readBalanceCiphertext = async (
  contract: DeployedXgbpContract,
  accountId: Uint8Array,
  operation: string,
) => {
  const tx = await contract.callTx.balanceOf(accountId);
  return {
    ciphertext: tx.private.result,
    result: {
      onchain: [txReference(operation, tx.public)],
      local: [],
    },
  };
};

const refreshActorCache = async (
  contract: DeployedXgbpContract,
  state: XgbpPrivateState,
  actor: ActorName,
  plaintextBalance: bigint,
): Promise<RefreshResult> => {
  const account = describeActor(state, actor);
  const { ciphertext, result } = await readBalanceCiphertext(contract, account.accountId, `balanceOf(${actor})`);
  const cached = cachePlaintextForActor(state, actor, ciphertext, plaintextBalance);
  return {
    state: setActorBalance(cached, actor, plaintextBalance),
    result: mergeResults(
      result,
      local(`Cached ${actorLabel(actor)} plaintext balance = ${plaintextBalance.toString()} base units`),
    ),
  };
};

export const snapshot = async (providers: XgbpProviders): Promise<ContractSnapshot> => {
  const state = await getPrivateState(providers);
  return {
    kycRequired: state.kycRequired,
    totalSupply: state.totalSupply,
    actors: actorNames.map((actor) => {
      const account = describeActor(state, actor);
      return {
        actor,
        accountId: account.accountId,
        knownBalance: account.knownBalance,
        registered: account.registered,
        kycApproved: account.kycApproved,
        frozen: account.frozen,
      };
    }),
  };
};

export const setKycRequired = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  required: boolean,
): Promise<OperationResult> => {
  await activateActor(providers, 'issuer');
  const tx = await contract.callTx.setKycRequired(required);
  await savePrivateState(providers, setKycRequiredFlag(await getPrivateState(providers), required));
  return mergeResults(
    { onchain: [txReference(`setKycRequired(${String(required)})`, tx.public)], local: [] },
    local('Selected Issuer private-state/witness context', `Cached KYC required = ${String(required)}`),
  );
};

export const setKycApproved = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
  approved: boolean,
): Promise<OperationResult> => {
  const state = await activateActor(providers, 'issuer');
  const tx = await contract.callTx.setKycApproved(describeActor(state, actor).accountId, approved);
  await savePrivateState(providers, setActorKycApproved(await getPrivateState(providers), actor, approved));
  return mergeResults(
    { onchain: [txReference(`setKycApproved(${actor}, ${String(approved)})`, tx.public)], local: [] },
    local('Selected Issuer private-state/witness context', `Cached ${actorLabel(actor)} KYC approved = ${String(approved)}`),
  );
};

export const register = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
): Promise<OperationResult> => {
  const state = await activateActor(providers, actor);
  const tx = await contract.callTx.register();
  const registered = setActorRegistered(await getPrivateState(providers), actor, true);
  const refreshed = await refreshActorCache(contract, registered, actor, state.actors[actor].knownBalance);
  await savePrivateState(providers, refreshed.state);
  return mergeResults(
    { onchain: [txReference(`register(${actor})`, tx.public)], local: [] },
    local(`Selected ${actorLabel(actor)} private-state/witness context`, `Cached ${actorLabel(actor)} registered = true`),
    refreshed.result,
  );
};

export const mint = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
  amount: bigint,
): Promise<OperationResult> => {
  const state = await activateActor(providers, 'issuer');
  const recipient = describeActor(state, actor);
  const tx = await contract.callTx.mint(recipient.accountId, amount);

  const current = await getPrivateState(providers);
  const nextBalance = current.actors[actor].knownBalance + amount;
  const withBalance = await refreshActorCache(contract, current, actor, nextBalance);
  const nextTotalSupply = current.totalSupply + amount;
  await savePrivateState(providers, setTotalSupply(withBalance.state, nextTotalSupply));
  return mergeResults(
    { onchain: [txReference(`mint(${actor}, ${amount.toString()})`, tx.public)], local: [] },
    local('Selected Issuer private-state/witness context'),
    withBalance.result,
    local(`Cached total supply = ${nextTotalSupply.toString()} base units`),
  );
};

export const transfer = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  from: ActorName,
  to: ActorName,
  amount: bigint,
): Promise<OperationResult> => {
  const state = await activateActor(providers, from);
  const tx = await contract.callTx.transfer(describeActor(state, to).accountId, amount);

  const current = await getPrivateState(providers);
  const fromBalance = current.actors[from].knownBalance - amount;
  const toBalance = current.actors[to].knownBalance + amount;
  const fromCached = await refreshActorCache(contract, current, from, fromBalance);
  const toCached = await refreshActorCache(contract, fromCached.state, to, toBalance);
  await savePrivateState(providers, toCached.state);
  return mergeResults(
    { onchain: [txReference(`transfer(${from}->${to}, ${amount.toString()})`, tx.public)], local: [] },
    local(`Selected ${actorLabel(from)} private-state/witness context`),
    fromCached.result,
    toCached.result,
  );
};

export const burn = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
  amount: bigint,
): Promise<OperationResult> => {
  await activateActor(providers, actor);
  const tx = await contract.callTx.burn(amount);

  const current = await getPrivateState(providers);
  const nextBalance = current.actors[actor].knownBalance - amount;
  const withBalance = await refreshActorCache(contract, current, actor, nextBalance);
  const nextTotalSupply = current.totalSupply - amount;
  await savePrivateState(providers, setTotalSupply(withBalance.state, nextTotalSupply));
  return mergeResults(
    { onchain: [txReference(`burn(${actor}, ${amount.toString()})`, tx.public)], local: [] },
    local(`Selected ${actorLabel(actor)} private-state/witness context`),
    withBalance.result,
    local(`Cached total supply = ${nextTotalSupply.toString()} base units`),
  );
};

export const freeze = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
): Promise<OperationResult> => {
  const state = await activateActor(providers, 'issuer');
  const tx = await contract.callTx.freeze(describeActor(state, actor).accountId);
  await savePrivateState(providers, setActorFrozen(await getPrivateState(providers), actor, true));
  return mergeResults(
    { onchain: [txReference(`freeze(${actor})`, tx.public)], local: [] },
    local('Selected Issuer private-state/witness context', `Cached ${actorLabel(actor)} frozen = true`),
  );
};

export const unfreeze = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
): Promise<OperationResult> => {
  const state = await activateActor(providers, 'issuer');
  const tx = await contract.callTx.unfreeze(describeActor(state, actor).accountId);
  await savePrivateState(providers, setActorFrozen(await getPrivateState(providers), actor, false));
  return mergeResults(
    { onchain: [txReference(`unfreeze(${actor})`, tx.public)], local: [] },
    local('Selected Issuer private-state/witness context', `Cached ${actorLabel(actor)} frozen = false`),
  );
};
