# XGBP

Standalone Compact application for an XGBP confidential fungible token demo.

The app deploys a real Compact contract to a local Midnight standalone network
and provides a fixed-screen terminal UI for exploring issuer actions, holder
flows, KYC/freeze controls, and confidential balances.

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

Use a terminal of at least `120x35` so the fixed dashboard fits on screen.

## What The Demo Shows

- Issuer deploys and administers the token.
- Alice and Bob are regulated holders.
- KYC approval and freeze state are public policy state.
- Public chain view shows holder balances as `encrypted`.
- Alice and Bob each see only their own local balance view.
- Values update only after real contract calls succeed; the TUI does not mock token state.

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

Verifier keys are published after a stripped deploy. The default chunk size is
`8`; if a chunk is too large for local block limits, the CLI halves the chunk
and retries.

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
