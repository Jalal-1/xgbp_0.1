# mgbp_0.1

Standalone Compact MGBP application.

This project includes a local copy of the CFT Compact source under:

```text
contract/src/compact/
```

The contract entrypoint is:

```text
contract/src/compact/examples/MGBP.compact
```

The app-local Compact compiler output is generated under:

```text
contract/src/managed/MGBP
```

Contract compilation uses OpenZeppelin Compact Tools:

```bash
npm run compact
```

No local `.compact` wrapper is used.

## Step 1: local network

Start the local standalone network:

```bash
npm run network:up
```

Check containers:

```bash
npm run network:status
```

Stop the network:

```bash
npm run network:down
```

Preview and preprod endpoint config is present in the CLI, but deployment is not implemented yet.
