import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { CompactTypeBytes, CompactTypeVector, persistentHash, type WitnessContext } from '@midnight-ntwrk/compact-runtime';
import * as XGBP from './artifacts/XGBP/contract/index.js';
import type { ElGamal_Ciphertext, Ledger, Witnesses } from './artifacts/XGBP/contract/index.js';

export const actorNames = ['issuer', 'alice', 'bob'] as const;
export type ActorName = (typeof actorNames)[number];
export type CustodySignerLabel = 'user' | 'backup' | 'custodian';

export type CustodySigner = {
  label: CustodySignerLabel;
  publicKey: Uint8Array;
  signature: Uint8Array;
  commitment: Uint8Array;
};

export type LocalActor = {
  label: ActorName;
  secretKey: Uint8Array;
  encryptionKey: Uint8Array;
  accountId: Uint8Array;
  custodySigners: CustodySigner[];
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
  custodyInstanceSalt: Uint8Array;
  randomnessSeed: Uint8Array;
  kycRequired: boolean;
  totalSupply: bigint;
  plaintextCache: Record<string, bigint>;
  actors: Record<ActorName, LocalActor>;
};

const bytes32Type = new CompactTypeVector(1, new CompactTypeBytes(32));
const encoder = new TextEncoder();

const deterministicBytes = (label: string, length: number): Uint8Array => {
  const source = encoder.encode(label);
  const key = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    key[i] = source[i % source.length] ^ ((i * 31) & 0xff);
  }
  return key;
};

const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

export const shortHex = (bytes: Uint8Array): string => `${bytesToHex(bytes).slice(0, 12)}...`;

const randomSeed = (): Uint8Array => new Uint8Array(randomBytes(32));

const buildAccountId = (secretKey: Uint8Array): Uint8Array => persistentHash(bytes32Type, [secretKey]);

const createCustodySigners = (keyPrefix: string, instanceSalt: Uint8Array): CustodySigner[] =>
  (['user', 'backup', 'custodian'] as const).map((label) => {
    const publicKey = deterministicBytes(`${keyPrefix}_CUSTODY_${label.toUpperCase()}_PK`, 64);
    return {
      label,
      publicKey,
      signature: deterministicBytes(`${keyPrefix}_CUSTODY_${label.toUpperCase()}_SIG`, 64),
      commitment: XGBP.pureCircuits.calculateCustodySignerId(publicKey, instanceSalt),
    };
  });

const createActor = (label: ActorName, keyPrefix: string, instanceSalt: Uint8Array): LocalActor => {
  const secretKey = deterministicBytes(`${keyPrefix}_SK`, 32);
  const encryptionKey = deterministicBytes(`${keyPrefix}_EK`, 32);

  return {
    label,
    secretKey,
    encryptionKey,
    accountId: buildAccountId(secretKey),
    custodySigners: createCustodySigners(keyPrefix, instanceSalt),
    knownBalance: 0n,
    registered: false,
    kycApproved: false,
    frozen: false,
    plaintextCache: {},
  };
};

export const createXgbpPrivateState = (): XgbpPrivateState => {
  const custodyInstanceSalt = deterministicBytes('XGBP_CUSTODY_INSTANCE_SALT', 32);
  const issuer = createActor('issuer', 'XGBP_ISSUER', custodyInstanceSalt);
  const alice = createActor('alice', 'XGBP_ALICE', custodyInstanceSalt);
  const bob = createActor('bob', 'XGBP_BOB', custodyInstanceSalt);

  return {
    activeActor: 'issuer',
    secretKey: issuer.secretKey,
    encryptionKey: issuer.encryptionKey,
    custodyInstanceSalt,
    randomnessSeed: randomSeed(),
    kycRequired: false,
    totalSupply: 0n,
    plaintextCache: {},
    actors: { issuer, alice, bob },
  };
};

export const normalizeXgbpPrivateState = (state: XgbpPrivateState): XgbpPrivateState => {
  if (
    state.actors !== undefined &&
    state.activeActor !== undefined &&
    state.custodyInstanceSalt !== undefined &&
    state.actors.issuer.custodySigners !== undefined
  ) {
    return state;
  }

  return createXgbpPrivateState();
};

export const initialIssuerAccountId = (state: XgbpPrivateState): Uint8Array =>
  normalizeXgbpPrivateState(state).actors.issuer.accountId;

export const custodyInstanceSalt = (state: XgbpPrivateState): Uint8Array =>
  normalizeXgbpPrivateState(state).custodyInstanceSalt;

export const custodySignerCommitmentsForActor = (state: XgbpPrivateState, actor: ActorName): Uint8Array[] =>
  normalizeXgbpPrivateState(state).actors[actor].custodySigners.map((signer) => signer.commitment);

export const custodyApprovalForActor = (
  state: XgbpPrivateState,
  actor: ActorName,
): { pubkeys: Uint8Array[]; signatures: Uint8Array[]; labels: CustodySignerLabel[] } => {
  const signers = normalizeXgbpPrivateState(state).actors[actor].custodySigners;
  const selected = [signers[0], signers[2]];
  return {
    pubkeys: selected.map((signer) => signer.publicKey),
    signatures: selected.map((signer) => signer.signature),
    labels: selected.map((signer) => signer.label),
  };
};

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
});
