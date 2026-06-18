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

const readBalanceCiphertext = async (contract: DeployedXgbpContract, accountId: Uint8Array) => {
  const tx = await contract.callTx.balanceOf(accountId);
  return tx.private.result;
};

const refreshActorCache = async (
  contract: DeployedXgbpContract,
  state: XgbpPrivateState,
  actor: ActorName,
  plaintextBalance: bigint,
): Promise<XgbpPrivateState> => {
  const account = describeActor(state, actor);
  const ciphertext = await readBalanceCiphertext(contract, account.accountId);
  const cached = cachePlaintextForActor(state, actor, ciphertext, plaintextBalance);
  return setActorBalance(cached, actor, plaintextBalance);
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
): Promise<void> => {
  await activateActor(providers, 'issuer');
  await contract.callTx.setKycRequired(required);
  await savePrivateState(providers, setKycRequiredFlag(await getPrivateState(providers), required));
};

export const setKycApproved = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
  approved: boolean,
): Promise<void> => {
  const state = await activateActor(providers, 'issuer');
  await contract.callTx.setKycApproved(describeActor(state, actor).accountId, approved);
  await savePrivateState(providers, setActorKycApproved(await getPrivateState(providers), actor, approved));
};

export const register = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
): Promise<void> => {
  const state = await activateActor(providers, actor);
  await contract.callTx.register();
  const registered = setActorRegistered(await getPrivateState(providers), actor, true);
  await savePrivateState(providers, await refreshActorCache(contract, registered, actor, state.actors[actor].knownBalance));
};

export const mint = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
  amount: bigint,
): Promise<void> => {
  const state = await activateActor(providers, 'issuer');
  const recipient = describeActor(state, actor);
  await contract.callTx.mint(recipient.accountId, amount);

  const current = await getPrivateState(providers);
  const nextBalance = current.actors[actor].knownBalance + amount;
  const withBalance = await refreshActorCache(contract, current, actor, nextBalance);
  await savePrivateState(providers, setTotalSupply(withBalance, current.totalSupply + amount));
};

export const transfer = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  from: ActorName,
  to: ActorName,
  amount: bigint,
): Promise<void> => {
  const state = await activateActor(providers, from);
  await contract.callTx.transfer(describeActor(state, to).accountId, amount);

  const current = await getPrivateState(providers);
  const fromBalance = current.actors[from].knownBalance - amount;
  const toBalance = current.actors[to].knownBalance + amount;
  const fromCached = await refreshActorCache(contract, current, from, fromBalance);
  const toCached = await refreshActorCache(contract, fromCached, to, toBalance);
  await savePrivateState(providers, toCached);
};

export const burn = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
  amount: bigint,
): Promise<void> => {
  await activateActor(providers, actor);
  await contract.callTx.burn(amount);

  const current = await getPrivateState(providers);
  const nextBalance = current.actors[actor].knownBalance - amount;
  const withBalance = await refreshActorCache(contract, current, actor, nextBalance);
  await savePrivateState(providers, setTotalSupply(withBalance, current.totalSupply - amount));
};

export const freeze = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
): Promise<void> => {
  const state = await activateActor(providers, 'issuer');
  await contract.callTx.freeze(describeActor(state, actor).accountId);
  await savePrivateState(providers, setActorFrozen(await getPrivateState(providers), actor, true));
};

export const unfreeze = async (
  providers: XgbpProviders,
  contract: DeployedXgbpContract,
  actor: ActorName,
): Promise<void> => {
  const state = await activateActor(providers, 'issuer');
  await contract.callTx.unfreeze(describeActor(state, actor).accountId);
  await savePrivateState(providers, setActorFrozen(await getPrivateState(providers), actor, false));
};
