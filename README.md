# XGBP

Standalone Compact application for an XGBP confidential fungible token demo.

The app deploys a real Compact contract to a local Midnight standalone network
and provides a fixed-screen terminal UI for exploring issuer actions, holder
flows, 2-of-3 custody approval, KYC/freeze controls, and confidential balances.

## Quickstart

```bash
git clone git@github.com:Jalal-1/xgbp_0.1.git
cd xgbp_0.1
npm ci
npm run build
npm run network:up
npm run tui -- --network local
```

In the TUI:

```text
1 Deploy new XGBP contract
```

After deployment, choose:

```text
1 Guided flow
```

Use a terminal of at least `120x38` so the fixed dashboard fits on screen.

## What The Demo Shows

- Issuer deploys and administers the token.
- Alice and Bob are regulated holders.
- Each actor has three custody signers: user, backup, and custodian.
- Mutating token operations require 2-of-3 custody approval.
- The TUI separates local custody activity from on-chain activity:
  `[CUSTODY]` shows request/signature collection, while `[ONCHAIN]` shows
  finalized contract calls. `[INDEXER]` shows public chain state reads.
- KYC approval and freeze state are public policy state.
- Public chain view shows holder balances as `encrypted`.
- Alice and Bob each see only their own local balance view.
- Values update only after real contract calls succeed; the TUI does not mock token state.

## Custodian Sandbox Integration Notes

XGBP deploys as one Compact contract. There is not a separate multisig contract
per user. The `CustodyMultisig` code is an embedded module inside
`XGBP.compact`, and its public ledger state lives inside the deployed XGBP
contract.

Custody state is per account:

- The issuer signer set is registered in the constructor.
- Alice and Bob register their signer sets through `register`.
- Each account has three signer commitments: user, backup, and custodian.
- Each gated operation receives two public keys and two signatures.
- The contract checks signer membership, duplicate signer rejection, threshold
  `>= 2`, and nonce replay protection.
- Signature verification is intentionally the Compact demo stub. This is the
  only mocked cryptographic primitive; production integration needs a real
  Compact-verifiable signature primitive.

Gated operations:

- Issuer-controlled: `mint`, `freeze`, `unfreeze`, `setKycRequired`,
  `setKycApproved`.
- Holder/source-account controlled: `transfer`, `approve`, `transferFrom`,
  `burn`, `burnFrom`.
- Read-only/public state inspection should use the indexer, not view-circuit
  transactions.

Runtime data sources:

- `[CUSTODY]`: local approval preparation for the demo signer set.
- `[ONCHAIN]`: finalized Compact transactions with tx id, tx hash, block, and
  status.
- `[INDEXER]`: public contract-state reads via `publicDataProvider`.
- `[LOCAL]`: wallet/private-state cache, including plaintext balance tracking.

The current CLI follows the working CFT demo pattern for wallet balance-cache
refresh. Public chain state should be read from the indexer; private balance
display remains a wallet responsibility because balances are encrypted.

## Requirements

- Node.js 20+
- Docker with `docker compose`
- GitHub access to this private repository

The Compact build uses OpenZeppelin Compact Tools through npm scripts. A global
Compact install is not required for the normal quickstart.

## Useful Commands

Install dependencies:

```bash
npm ci
```

Build contract artifacts and CLI:

```bash
npm run build
```

Run type checks:

```bash
npm run typecheck
```

Start, inspect, and stop the local Midnight network:

```bash
npm run network:up
npm run network:status
npm run network:down
```

Start the TUI:

```bash
npm run tui -- --network local
```

Start the TUI with verbose logs:

```bash
npm run tui -- --network local --verbose
```

Inside the TUI, press `v` to toggle normal/verbose logs. Normal mode keeps
pending progress out of history; verbose mode keeps progress and raw error detail.

Deploy without the TUI:

```bash
npm run deploy -- --network local --name XGBP --symbol XGBP --decimals 2 --vk-chunk-size 8
```

Force a fresh build before deploy:

```bash
npm run deploy:fresh -- --network local
```

## Project Layout

```text
contract/src/compact/examples/XGBP.compact       contract entrypoint
contract/src/compact/multisig/                  2-of-3 custody approval gate
contract/src/compact/token/                     confidential fungible token source
contract/src/compact/security/                  KYC/freeze registry source
contract/src/state.ts                           witness/private-state helpers
cli/src/main.ts                                 CLI entrypoint
cli/src/tui.ts                                  fixed-screen terminal UI
cli/src/deploy.ts                               deploy and verifier-key publication
infra/standalone.yml                            local Midnight network
```

Generated outputs are ignored by git:

```text
contract/src/artifacts/
contract/dist/
cli/dist/
.xgbp/
```

## Notes

`npm run build` uses:

```bash
compact-builder +0.31.0 --clean-dist --src src --dir compact/examples --out src/artifacts
```

Verifier keys are published after the deploy transaction. The default chunk size is
`8`; if a chunk is too large for local block limits, the CLI halves the chunk
and retries.

The custody gate follows the OpenZeppelin multisig example pattern for signer
membership, duplicate signer rejection, threshold checks, operation hashing,
and nonce replay protection. Signature verification is intentionally demo-only
until a Compact-verifiable signature primitive is wired in.

Custody visibility in the TUI:

- Actor panels show whether the account has a `2-of-3 on-chain` custody gate.
- Gated operation transaction refs are labelled with `custody=2/3`.
- `[CUSTODY]` logs are local request/signature preparation.
- `[ONCHAIN]` logs are finalized Compact circuit transactions.
- `[INDEXER]` logs are public contract-state reads from the indexer.

Local network endpoints:

```text
node         http://127.0.0.1:9944
indexer      http://127.0.0.1:8088/api/v4/graphql
proof server http://127.0.0.1:6300
```

If `network:up` reports ports in use, stop the other local Midnight stack first.

## Current Boundary

OpenZeppelin Compact Tools are used for Compact compilation and contract-package
build assembly. Deployment uses the Midnight JS SDK because Compact Tools do
not provide network submission.
