import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { CompactTypeBytes, CompactTypeVector, persistentHash, type WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { ElGamal_Ciphertext, Ledger, Witnesses } from './artifacts/XGBP/contract/index.js';

export const actorNames = ['issuer', 'alice', 'bob'] as const;
export type ActorName = (typeof actorNames)[number];

export type LocalActor = {
  label: ActorName;
  secretKey: Uint8Array;
  encryptionKey: Uint8Array;
  accountId: Uint8Array;
  knownBalance: bigint;
  registered: boolean;
  kycApproved: boolean;
  frozen: boolean;
  plaintextCache: Record<string, bigint>;
};

export type XgbpPrivateState = {
  activeActor: ActorName;
  secretKey: Uint8Array;
  encryptionKey: Uint8Array;
  ownerSecretKey: Uint8Array;
  randomnessSeed: Uint8Array;
  kycRequired: boolean;
  totalSupply: bigint;
  plaintextCache: Record<string, bigint>;
  actors: Record<ActorName, LocalActor>;
};

const bytes32Type = new CompactTypeVector(1, new CompactTypeBytes(32));
const encoder = new TextEncoder();

const deterministicKey = (label: string): Uint8Array => {
  const key = new Uint8Array(32);
  key.set(encoder.encode(label).slice(0, 32));
  return key;
};

const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

export const shortHex = (bytes: Uint8Array): string => `${bytesToHex(bytes).slice(0, 12)}...`;

const randomSeed = (): Uint8Array => new Uint8Array(randomBytes(32));

const buildAccountId = (secretKey: Uint8Array): Uint8Array => persistentHash(bytes32Type, [secretKey]);

const createActor = (label: ActorName, keyPrefix: string): LocalActor => {
  const secretKey = deterministicKey(`${keyPrefix}_SK`);
  const encryptionKey = deterministicKey(`${keyPrefix}_EK`);

  return {
    label,
    secretKey,
    encryptionKey,
    accountId: buildAccountId(secretKey),
    knownBalance: 0n,
    registered: false,
    kycApproved: false,
    frozen: false,
    plaintextCache: {},
  };
};

export const createXgbpPrivateState = (): XgbpPrivateState => {
  const issuer = createActor('issuer', 'XGBP_ISSUER');
  const alice = createActor('alice', 'XGBP_ALICE');
  const bob = createActor('bob', 'XGBP_BOB');

  return {
    activeActor: 'issuer',
    secretKey: issuer.secretKey,
    encryptionKey: issuer.encryptionKey,
    ownerSecretKey: issuer.secretKey,
    randomnessSeed: randomSeed(),
    kycRequired: false,
    totalSupply: 0n,
    plaintextCache: {},
    actors: { issuer, alice, bob },
  };
};

export const normalizeXgbpPrivateState = (state: XgbpPrivateState): XgbpPrivateState => {
  if (state.actors !== undefined && state.activeActor !== undefined) {
    return state;
  }

  return createXgbpPrivateState();
};

export const initialOwnerAccountId = (state: XgbpPrivateState): Uint8Array =>
  normalizeXgbpPrivateState(state).actors.issuer.accountId;

const serializeCiphertext = (ct: ElGamal_Ciphertext): string =>
  `${ct.c1.x.toString(16)}:${ct.c1.y.toString(16)}:${ct.c2.x.toString(16)}:${ct.c2.y.toString(16)}`;

export const setActiveActor = (state: XgbpPrivateState, actor: ActorName): XgbpPrivateState => {
  const normalized = normalizeXgbpPrivateState(state);
  const persona = normalized.actors[actor];

  return {
    ...normalized,
    activeActor: actor,
    secretKey: persona.secretKey,
    encryptionKey: persona.encryptionKey,
    plaintextCache: { ...persona.plaintextCache },
    randomnessSeed: randomSeed(),
  };
};

export const cachePlaintextForActor = (
  state: XgbpPrivateState,
  actor: ActorName,
  ct: ElGamal_Ciphertext,
  plaintext: bigint,
): XgbpPrivateState => {
  const normalized = normalizeXgbpPrivateState(state);
  const cache = {
    ...normalized.actors[actor].plaintextCache,
    [serializeCiphertext(ct)]: plaintext,
  };

  return {
    ...normalized,
    plaintextCache: normalized.activeActor === actor ? cache : normalized.plaintextCache,
    actors: {
      ...normalized.actors,
      [actor]: {
        ...normalized.actors[actor],
        plaintextCache: cache,
      },
    },
  };
};

export const setActorBalance = (state: XgbpPrivateState, actor: ActorName, knownBalance: bigint): XgbpPrivateState => {
  const normalized = normalizeXgbpPrivateState(state);
  return {
    ...normalized,
    actors: {
      ...normalized.actors,
      [actor]: {
        ...normalized.actors[actor],
        knownBalance,
      },
    },
  };
};

export const setActorRegistered = (state: XgbpPrivateState, actor: ActorName, registered: boolean): XgbpPrivateState => {
  const normalized = normalizeXgbpPrivateState(state);
  return {
    ...normalized,
    actors: {
      ...normalized.actors,
      [actor]: {
        ...normalized.actors[actor],
        registered,
      },
    },
  };
};

export const setActorKycApproved = (state: XgbpPrivateState, actor: ActorName, kycApproved: boolean): XgbpPrivateState => {
  const normalized = normalizeXgbpPrivateState(state);
  return {
    ...normalized,
    actors: {
      ...normalized.actors,
      [actor]: {
        ...normalized.actors[actor],
        kycApproved,
      },
    },
  };
};

export const setActorFrozen = (state: XgbpPrivateState, actor: ActorName, frozen: boolean): XgbpPrivateState => {
  const normalized = normalizeXgbpPrivateState(state);
  return {
    ...normalized,
    actors: {
      ...normalized.actors,
      [actor]: {
        ...normalized.actors[actor],
        frozen,
      },
    },
  };
};

export const setKycRequiredFlag = (state: XgbpPrivateState, kycRequired: boolean): XgbpPrivateState => ({
  ...normalizeXgbpPrivateState(state),
  kycRequired,
});

export const setTotalSupply = (state: XgbpPrivateState, totalSupply: bigint): XgbpPrivateState => ({
  ...normalizeXgbpPrivateState(state),
  totalSupply,
});

export const describeActor = (state: XgbpPrivateState, actor: ActorName): LocalActor =>
  normalizeXgbpPrivateState(state).actors[actor];

export const createXgbpWitnesses = (): Witnesses<XgbpPrivateState> => ({
  wit_ConfidentialTokenSK(
    context: WitnessContext<Ledger, XgbpPrivateState>,
  ): [XgbpPrivateState, Uint8Array] {
    return [context.privateState, normalizeXgbpPrivateState(context.privateState).secretKey];
  },

  wit_ConfidentialTokenEK(
    context: WitnessContext<Ledger, XgbpPrivateState>,
  ): [XgbpPrivateState, Uint8Array] {
    return [context.privateState, normalizeXgbpPrivateState(context.privateState).encryptionKey];
  },

  wit_PlaintextBalance(
    context: WitnessContext<Ledger, XgbpPrivateState>,
    ct: ElGamal_Ciphertext,
  ): [XgbpPrivateState, bigint] {
    const state = normalizeXgbpPrivateState(context.privateState);
    const plaintext = state.plaintextCache[serializeCiphertext(ct)];
    if (plaintext === undefined) {
      throw new Error(`wit_PlaintextBalance: no cached plaintext for ${serializeCiphertext(ct)}`);
    }
    return [context.privateState, plaintext];
  },

  wit_RandomnessSeed(
    context: WitnessContext<Ledger, XgbpPrivateState>,
  ): [XgbpPrivateState, Uint8Array] {
    return [context.privateState, normalizeXgbpPrivateState(context.privateState).randomnessSeed];
  },

  wit_OwnableSK(context: WitnessContext<Ledger, XgbpPrivateState>): [XgbpPrivateState, Uint8Array] {
    return [context.privateState, normalizeXgbpPrivateState(context.privateState).ownerSecretKey];
  },
});
