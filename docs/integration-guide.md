# Custodian Integration Guide

This guide explains what a custodian integration can reuse from the Shielded
Integration Template and where production wallet infrastructure is still needed.

## Architecture

The sample `XGBP` token is an account-based Confidential Fungible Token on
Midnight. Each balance is stored in contract state as an encrypted
exponential-ElGamal ciphertext. Transfers update encrypted balances through
contract circuits, so transfer amounts are hidden from the public.

The privacy model is precise:

- Hidden: transfer amounts and private allowance caps.
- Public: account ids, registrations, KYC/freeze status, transaction timing, and the counterparty graph.
- Local/private: plaintext balances, account secrets, encryption/viewing keys, custody signing material.

This is amount confidentiality, not anonymity. The graph is public and
pseudonymous; issuer KYC can bind account ids to real-world customers.

## Contract Shape

The template deploys one Compact contract for the sample token. There is not a
separate multisig contract per account.

`XGBP.compact` composes:

- `ConfidentialFungibleToken`: encrypted balances, transfers, allowance escrow, mint, burn, and memos.
- `ComplianceRegistry`: KYC and freeze state.
- `CustodyMultisig`: embedded 2-of-3 approval gate.

The base CFT is policy-free. The wrapper gates operations and then calls the CFT
core. This keeps compliance and custody policy separate from the confidential
balance primitive.

## Component Map

### Compact Components

`contract/src/compact/examples/XGBP.compact`

The deployable sample contract. It composes the CFT core, compliance registry,
and custody gate into one regulated token wrapper. This is where policy is
applied: KYC, freeze, issuer controls, and 2-of-3 custody checks are enforced
before or after calls into the policy-free CFT core.

`contract/src/compact/token/ConfidentialFungibleToken.compact`

The confidential token core. It stores balances as encrypted ElGamal
ciphertexts keyed by account id, implements registration, transfer, allowance
escrow, mint, burn, and credit memos. It does not know about KYC, freeze, issuer
roles, or custody policy.

`contract/src/compact/crypto/ElGamal.compact`

Reusable encryption and curve primitive layer. The token uses exponential
ElGamal because it is additively homomorphic: a transfer can debit and credit
encrypted balances without decrypting them on-chain.

`contract/src/compact/security/ComplianceRegistry.compact`

Public compliance state: KYC approval and freeze status. Freeze blocks sending,
receiving, and escrow drawdown. KYC can be required for registration.

`contract/src/compact/multisig/CustodyMultisig.compact`

Embedded 2-of-3 custody gate. It stores one signer set per controlled account
inside the same deployed token contract, checks signer membership, rejects
duplicates, enforces threshold, hashes operation arguments, and increments a
nonce for replay protection. Signature verification is the demo stub until a
real Compact-verifiable ECDSA primitive is available.

### TypeScript Contract Package

`contract/src/index.ts`

Exports the generated `XGBP` contract bindings and the local witness/private
state helpers used by the CLI.

`contract/src/state.ts`

Defines the private witness state needed to call the contract circuits. The
template includes deterministic demo personas for issuer, Alice, and Bob,
including identity secrets, encryption secrets, custody signer material, local
balance cache, and active actor selection. Production integrations replace this
with real wallet/key-management state.

### CLI And Runtime Components

`cli/src/branding.ts`

Single source of truth for template naming, sample token defaults, deployment
directory, private-state store name, Docker project name, and TUI sizing.

`cli/src/config.ts`

Network endpoint configuration for local, preview, and preprod. It also sets
the Midnight network id before providers are built.

`cli/src/wallet.ts`

Builds the local Midnight wallet context used to fund deployment and submit
transactions. In a custodian environment, this is the boundary where real wallet
custody, key backup, signing policies, and DUST funding would be integrated.

`cli/src/providers.ts`

Creates Midnight JS providers: private state, indexer public data, proof server,
ZK artifact provider, wallet provider, and Midnight transaction provider.

`cli/src/deploy.ts`

Deploys the sample `XGBP` contract, stores the maintenance signing key in local
private state, publishes verifier keys in chunks, re-binds the CLI to the
deployed contract, and writes a deployment record under `.shielded-template/`.

`cli/src/token-api.ts`

Adapter between the TUI and the generated contract bindings. It centralizes
custody approval, transaction submission, tx reference capture, indexer checks,
and local wallet cache updates. It does not invent token state; cache changes
happen only after successful contract calls.

`cli/src/tui.ts` and `cli/src/tui-format.ts`

Fixed-screen terminal demo. It renders issuer, Alice, Bob, the public contract
view, KYC/freeze state, guided-flow checklist, and scrollable logs. The TUI is
a product-understanding tool, not a production wallet UI.

`cli/src/docker.ts` and `infra/standalone.yml`

Local Midnight standalone network helpers. These are for sandbox testing only;
preview/preprod use configured remote endpoints.

## 2-of-3 Custody

Each controlled account has three signer commitments:

- user
- backup
- custodian

The issuer signer set is registered in the constructor. Alice and Bob register
their signer sets when they register as holders.

Every gated operation receives two public keys and two signatures. On-chain
contract logic checks:

- signer set is registered for the controlled account
- both signers are members of that account's signer set
- the two signers are distinct
- threshold is at least 2
- operation nonce prevents replay
- operation hash includes the contract address, controlled account, nonce, domain, and arguments

Signature verification is currently the Compact demo stub. A production
integration must replace that with a real Compact-verifiable ECDSA primitive
when available. This template still demonstrates where the custody request,
approval collection, and on-chain threshold gate fit.

## Gated Operations

Issuer-controlled operations:

- `mint`
- `freeze`
- `unfreeze`
- `setKycRequired`
- `setKycApproved`

Holder/source-account-controlled operations:

- `transfer`
- `approve`
- `transferFrom`
- `burn`
- `burnFrom`

Read-only/public inspection is not custody-gated.

## Data Sources

The TUI log sources are intentionally separated:

- `[CUSTODY]`: local approval request and selected signer material for the demo.
- `[ONCHAIN]`: submitted Compact transactions and finalized tx references.
- `[INDEXER]`: public contract-state reads.
- `[LOCAL]`: wallet/private-state cache updates.
- `[SYSTEM]`: TUI flow/status.

Public chain reads should go through the indexer. The current CLI keeps one
working CFT demo bridge: `balanceOf` is called to refresh a wallet's encrypted
balance cell after successful operations, while the plaintext balance remains a
local wallet responsibility.

Runtime services:

- Node RPC: accepts submitted transactions.
- Indexer: source for public contract state and finalized transaction data.
- Proof server: generates proofs for circuit calls.
- Private state store: local LevelDB-backed witness/cache state for the demo.
- Generated artifacts: verifier keys and JS bindings produced by Compact Tools.

## Memos And Private Balances

The contract pushes encrypted memos for credits: mint, transfer, and
transferFrom. A recipient wallet scans its memo list, decrypts memos with its
encryption key, and recovers the bounded amount.

Important wallet reality:

- Memos record credits only.
- Debits have no memo.
- Re-approve self-refunds may credit without a memo.
- Large cumulative balances are not directly decryptable by a simple bounded discrete log.
- The wallet must maintain a durable plaintext balance cache.
- Cold recovery requires replaying memo history or restoring an encrypted cache backup.

A production custodian integration therefore needs key backup, CSPRNG-backed
transaction randomness, memo scanning, amount recovery, private cache backup,
and reconciliation of authority actions such as freeze or future seize.

## End-To-End Flow

1. Build Compact artifacts with OpenZeppelin Compact Tools.
2. Start or select a Midnight network.
3. Build wallet and providers.
4. Deploy the sample `XGBP` contract.
5. Publish verifier keys in maintenance chunks.
6. Confirm deployed public contract state through the indexer.
7. Register holder custody signer sets.
8. Issuer approves KYC and manages freeze state through custody-gated calls.
9. Holder operations collect 2-of-3 custody approval, submit a Compact
   transaction, and wait for finality.
10. Wallet-side state updates local plaintext balance cache only after the
    on-chain operation succeeds.

## What A Custodian Replaces

- Deterministic demo actor keys with real account and encryption-key custody.
- Demo signer material with the custodian's approval workflow.
- `stubVerifySignature` with a real Compact-verifiable ECDSA primitive.
- Local private-state cache with durable encrypted wallet storage and backup.
- Manual memo/cache handling with a production memo scanner and reconciliation
  service.
- Local standalone network with preview, preprod, or production deployment
  controls.

## Current Limits

- No production ECDSA verifier in Compact; signature verification is demo-only.
- No full wallet SDK for memo scanning and discrete-log recovery.
- No seize implementation.
- No auditor/viewing-key implementation.
- Public transaction graph remains visible.
- Concurrent credits to the same account can contend on the recipient balance cell.

These limits are deliberate for the current institutional-style template: the
goal is to show a working CFT integration path with custody, KYC, freeze, real
deployment, and clear data boundaries.
