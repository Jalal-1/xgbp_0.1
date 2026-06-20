import {
  actorNames,
  cachePlaintextForActor,
  createXgbpPrivateState,
  custodyApprovalForActor,
  custodySignerCommitmentsForActor,
  describeActor,
  normalizeXgbpPrivateState,
  setActiveActor,
  setActorBalance,
  setActorFrozen,
  setActorKycApproved,
  setActorRegistered,
  setKycRequiredFlag,
  setTotalSupply,
  shortHex,
  type ActorName,
  type XgbpPrivateState,
} from '@shielded-template/contract';
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
  indexer: string[];
  custody: string[];
  local: string[];
};

type RefreshResult = {
  state: XgbpPrivateState;
  result: OperationResult;
};

type CustodyApproval = ReturnType<typeof custodyApproval>;
type SubmittedTx = { public: FinalizedTxData };

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

const emptyResult = (): OperationResult => ({ onchain: [], indexer: [], custody: [], local: [] });

const local = (...messages: string[]): OperationResult => ({ ...emptyResult(), local: messages });

const indexer = (...messages: string[]): OperationResult => ({ ...emptyResult(), indexer: messages });

const custody = (...messages: string[]): OperationResult => ({ ...emptyResult(), custody: messages });

const onchain = (...references: TxReference[]): OperationResult => ({ ...emptyResult(), onchain: references });

const mergeResults = (...results: OperationResult[]): OperationResult => ({
  onchain: results.flatMap((result) => result.onchain),
  indexer: results.flatMap((result) => result.indexer),
  custody: results.flatMap((result) => result.custody),
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

const selectedActorContext = (actor: ActorName): OperationResult =>
  local(`Selected ${actorLabel(actor)} private-state/witness context`);

const readBalanceCiphertext = async (
  contract: DeployedXgbpContract,
  accountId: Uint8Array,
  operation: string,
) => {
  // Public state should be read through the indexer. This call is the current
  // CFT demo bridge for wallet cache refresh: it gives the active wallet the
  // latest encrypted balance cell whose plaintext it already tracks locally.
  const tx = await contract.callTx.balanceOf(accountId);
  return {
    ciphertext: tx.private.result,
    result: {
      onchain: [txReference(operation, tx.public)],
      indexer: [],
      custody: [],
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

const custodyApproval = (
  state: XgbpPrivateState,
  actor: ActorName,
  action: string,
): { pubkeys: Uint8Array[]; signatures: Uint8Array[]; result: OperationResult } => {
  const account = describeActor(state, actor);
  const approval = custodyApprovalForActor(state, actor);
  const signerCommitments = custodySignerCommitmentsForActor(state, actor);
  const selectedCommitments = [signerCommitments[0], signerCommitments[2]];
  return {
    pubkeys: approval.pubkeys,
    signatures: approval.signatures,
    result: custody(
      `Custody request created for ${actorLabel(actor)}: ${action}`,
      `Local approvals supplied: ${approval.labels.join(' + ')} (2 of 3)`,
      `Signer commitments supplied: ${selectedCommitments.map(shortHex).join(' + ')}`,
      `On-chain gate: XGBP calls Custody_assertApproval for ${shortHex(account.accountId)}`,
      'On-chain checks: signer membership, duplicate rejection, threshold >= 2, nonce replay protection',
      'Signature verification is the Compact demo stub; threshold and signer checks are contract logic',
    ),
  };
};

const custodyTxLabel = (operation: string): string => `${operation}; custody=2/3`;

const runCustodyGatedTx = async (
  providers: XgbpProviders,
  controlledActor: ActorName,
  action: string,
  operation: string,
  submit: (state: XgbpPrivateState, approval: CustodyApproval) => Promise<SubmittedTx>,
): Promise<{ state: XgbpPrivateState; result: OperationResult }> => {
  const state = await activateActor(providers, controlledActor);
  const approval = custodyApproval(state, controlledActor, action);
  const tx = await submit(state, approval);

  return {
    state,
    result: mergeResults(
      approval.result,
      onchain(txReference(custodyTxLabel(operation), tx.public)),
      selectedActorContext(controlledActor),
    ),
  };
};

const shortAddress = (value: string): string => {
  if (value.length <= 22) return value;
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
};

export const confirmContractIndexed = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
): Promise<OperationResult> => {
  const address = contract.deployTxData.public.contractAddress;
  const state = await providers.publicDataProvider.queryContractState(address);
  if (state === null || state === undefined) {
    throw new Error(`Indexer has no public contract state for ${address}`);
  }

  return indexer(`Public contract state available from indexer for ${shortAddress(address)}`);
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
  const tx = await runCustodyGatedTx(
    providers,
    'issuer',
    `set KYC required = ${String(required)}`,
    `setKycRequired(${String(required)})`,
    (_state, approval) => contract.callTx.setKycRequired(required, approval.pubkeys, approval.signatures),
  );
  await savePrivateState(providers, setKycRequiredFlag(await getPrivateState(providers), required));
  return mergeResults(tx.result, local(`Cached KYC required = ${String(required)}`));
};

export const setKycApproved = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
  approved: boolean,
): Promise<OperationResult> => {
  const tx = await runCustodyGatedTx(
    providers,
    'issuer',
    `set ${actorLabel(actor)} KYC approved = ${String(approved)}`,
    `setKycApproved(${actor}, ${String(approved)})`,
    (state, approval) =>
      contract.callTx.setKycApproved(describeActor(state, actor).accountId, approved, approval.pubkeys, approval.signatures),
  );
  await savePrivateState(providers, setActorKycApproved(await getPrivateState(providers), actor, approved));
  return mergeResults(tx.result, local(`Cached ${actorLabel(actor)} KYC approved = ${String(approved)}`));
};

export const register = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
): Promise<OperationResult> => {
  const state = await activateActor(providers, actor);
  const signerCommitments = custodySignerCommitmentsForActor(state, actor);
  const tx = await contract.callTx.register(signerCommitments[0], signerCommitments[1], signerCommitments[2]);
  const registered = setActorRegistered(await getPrivateState(providers), actor, true);
  const refreshed = await refreshActorCache(contract, registered, actor, state.actors[actor].knownBalance);
  await savePrivateState(providers, refreshed.state);
  return mergeResults(
    custody(
      `Submitted ${actorLabel(actor)} custody signer set`,
      `Registered 3 signer commitments for account ${shortHex(describeActor(state, actor).accountId)}`,
      'Register transaction stores the signer set in the embedded XGBP custody ledger',
    ),
    onchain(txReference(`register(${actor})`, tx.public)),
    selectedActorContext(actor),
    local(`Cached ${actorLabel(actor)} registered = true`),
    refreshed.result,
  );
};

export const mint = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
  amount: bigint,
): Promise<OperationResult> => {
  const tx = await runCustodyGatedTx(
    providers,
    'issuer',
    `mint ${amount.toString()} base units to ${actorLabel(actor)}`,
    `mint(${actor}, ${amount.toString()})`,
    (state, approval) =>
      contract.callTx.mint(describeActor(state, actor).accountId, amount, approval.pubkeys, approval.signatures),
  );

  const current = await getPrivateState(providers);
  const nextBalance = current.actors[actor].knownBalance + amount;
  const withBalance = await refreshActorCache(contract, current, actor, nextBalance);
  const nextTotalSupply = current.totalSupply + amount;
  await savePrivateState(providers, setTotalSupply(withBalance.state, nextTotalSupply));
  return mergeResults(
    tx.result,
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
  const tx = await runCustodyGatedTx(
    providers,
    from,
    `transfer ${amount.toString()} base units to ${actorLabel(to)}`,
    `transfer(${from}->${to}, ${amount.toString()})`,
    (state, approval) => contract.callTx.transfer(describeActor(state, to).accountId, amount, approval.pubkeys, approval.signatures),
  );

  const current = await getPrivateState(providers);
  const fromBalance = current.actors[from].knownBalance - amount;
  const toBalance = current.actors[to].knownBalance + amount;
  const fromCached = await refreshActorCache(contract, current, from, fromBalance);
  const toCached = await refreshActorCache(contract, fromCached.state, to, toBalance);
  await savePrivateState(providers, toCached.state);
  return mergeResults(
    tx.result,
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
  const tx = await runCustodyGatedTx(
    providers,
    actor,
    `burn ${amount.toString()} base units`,
    `burn(${actor}, ${amount.toString()})`,
    (_state, approval) => contract.callTx.burn(amount, approval.pubkeys, approval.signatures),
  );

  const current = await getPrivateState(providers);
  const nextBalance = current.actors[actor].knownBalance - amount;
  const withBalance = await refreshActorCache(contract, current, actor, nextBalance);
  const nextTotalSupply = current.totalSupply - amount;
  await savePrivateState(providers, setTotalSupply(withBalance.state, nextTotalSupply));
  return mergeResults(
    tx.result,
    withBalance.result,
    local(`Cached total supply = ${nextTotalSupply.toString()} base units`),
  );
};

export const freeze = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
): Promise<OperationResult> => {
  const tx = await runCustodyGatedTx(
    providers,
    'issuer',
    `freeze ${actorLabel(actor)}`,
    `freeze(${actor})`,
    (state, approval) => contract.callTx.freeze(describeActor(state, actor).accountId, approval.pubkeys, approval.signatures),
  );
  await savePrivateState(providers, setActorFrozen(await getPrivateState(providers), actor, true));
  return mergeResults(tx.result, local(`Cached ${actorLabel(actor)} frozen = true`));
};

export const unfreeze = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
): Promise<OperationResult> => {
  const tx = await runCustodyGatedTx(
    providers,
    'issuer',
    `unfreeze ${actorLabel(actor)}`,
    `unfreeze(${actor})`,
    (state, approval) => contract.callTx.unfreeze(describeActor(state, actor).accountId, approval.pubkeys, approval.signatures),
  );
  await savePrivateState(providers, setActorFrozen(await getPrivateState(providers), actor, false));
  return mergeResults(tx.result, local(`Cached ${actorLabel(actor)} frozen = false`));
};
