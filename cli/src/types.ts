import type { XGBP, XgbpPrivateState } from '@shielded-template/contract';
import type { ProvableCircuitId } from '@midnight-ntwrk/compact-js';
import type { DeployedContract, FoundContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';

export const XgbpPrivateStateId = 'xgbpPrivateState';
export type XgbpPrivateStateId = typeof XgbpPrivateStateId;

export type XgbpContract = XGBP.Contract<XgbpPrivateState>;
export type XgbpCircuitId = ProvableCircuitId<XgbpContract>;
export type XgbpProviders = MidnightProviders<XgbpCircuitId, XgbpPrivateStateId, XgbpPrivateState>;
export type DeployedXgbpContract = DeployedContract<XgbpContract> | FoundContract<XgbpContract>;
