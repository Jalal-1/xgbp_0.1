# Shielded Integration Template

Vendor-neutral Compact application showing how a custodian can integrate a
Midnight Confidential Fungible Token with a 2-of-3 ECDSA custody architecture.

The concrete sample token is `XGBP`. The reusable part is the deployment,
wallet/provider wiring, custody approval flow, fixed-screen TUI, and integration
notes around private balances.

## Quickstart

Requirements:

- Node.js 20+
- Docker with `docker compose`
- Access to this repository

```bash
git clone <repo-url> shielded-integration-template
cd shielded-integration-template
npm ci
npm run build
npm run network:up
npm run tui -- --network local
```

In the TUI:

```text
1 Deploy new XGBP contract
1 Guided flow
```

Use a terminal of at least `120x38` so the fixed dashboard fits on screen.

## What This Demonstrates

- One Compact contract deployment for the sample `XGBP` CFT.
- Issuer, Alice, and Bob as demo actors.
- Per-account 2-of-3 custody signer sets.
- Custody approval before every gated mutating operation.
- KYC registration and freeze controls.
- Public chain view where non-owner balances remain `encrypted`.
- Actor chain views where each actor sees only its own local balance cache.
- On-chain transaction references for contract operations.
- Clear separation of `[CUSTODY]`, `[ONCHAIN]`, `[INDEXER]`, `[LOCAL]`, and `[SYSTEM]` logs.

The demo does not mock token state. The only demo cryptographic stub is signature
verification inside the Compact custody module; membership, duplicate signer,
threshold, nonce, and operation-domain checks are contract logic.

## Commands

```bash
npm ci
npm run build
npm run typecheck
```

Local network:

```bash
npm run network:up
npm run network:status
npm run network:down
```

TUI:

```bash
npm run tui -- --network local
npm run tui -- --network local --verbose
```

Inside the TUI, press `v` to toggle verbose logs. Normal mode keeps pending
progress out of history; verbose mode keeps progress and raw error detail.

Direct deploy:

```bash
npm run deploy -- --network local --name XGBP --symbol XGBP --decimals 2 --vk-chunk-size 8
npm run deploy:fresh -- --network local
```

## Project Layout

```text
contract/src/compact/examples/XGBP.compact       sample token wrapper
contract/src/compact/multisig/                  embedded 2-of-3 custody gate
contract/src/compact/token/                     confidential fungible token core
contract/src/compact/security/                  KYC/freeze registry
contract/src/state.ts                           witness/private-state helpers
cli/src/deploy.ts                               deploy and verifier-key publication
cli/src/token-api.ts                            token operation adapter for the TUI
cli/src/tui.ts                                  fixed-screen terminal UI flow
docs/integration-guide.md                       custodian integration notes
infra/standalone.yml                            local Midnight network
```

Generated outputs are ignored by git:

```text
contract/src/artifacts/
contract/dist/
cli/dist/
.shielded-template/
```

## Important Boundary

This is an integration template, not a production wallet.

Balances are encrypted on-chain. Credit memos help wallets discover incoming
value, but debits are not memoed. A production integration must maintain a
durable private balance cache, support key backup/recovery, scan/decrypt memos,
recover bounded amounts, and reconcile authority actions.

See [docs/integration-guide.md](docs/integration-guide.md) for the custody,
privacy, indexer, memo, and production-readiness details.
