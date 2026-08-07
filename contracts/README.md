# Contract Deployment

This directory contains the Foundry project for
`DrandQuicknetBeaconRegistry`.

The deployment script reads the oracle address and expected chain ID directly
from the corresponding JSON manifest under `../deployments/`.

Public deployment configuration belongs in `deployments/*.json`.
Secrets and RPC credentials belong in the repository-root `.env`.

## Repository layout

```text
.
├── .env
├── .env.example
├── deployments/
│   ├── robinhood-testnet.json
│   └── robinhood-mainnet.json
│
└── contracts/
    ├── src/
    │   └── DrandQuicknetBeaconRegistry.sol
    ├── script/
    │   └── DeployRegistry.s.sol
    ├── test/
    └── foundry.toml
```

## Prerequisites

Install Foundry:

```bash
forge --version
cast --version
```

## Environment

Create the repository-root `.env`:

```bash
cp .env.example .env
```

Example:

```dotenv
PRIVATE_KEY=

ROBINHOOD_TESTNET_RPC_URL=
ROBINHOOD_MAINNET_RPC_URL=
```

Contract addresses are read from the deployment manifests.

Load the environment into your shell before running Foundry:

```bash
set -a
source .env
set +a
```

## Deployment manifests

Each supported chain has a JSON file under `deployments/`.

Example:

```json
{
  "chainId": 12345,
  "network": "robinhood-testnet",
  "oracle": {
    "address": "0x692100c4863adAED9f560F6Ce982cF878F083e93",
    "runtimeCodehash": "0x78faa56ca608db8a19cfb3bb052f11fedbaa14fb1ce74db58044db99246b4cfc"
    ...
  },
  "registry": {
    "address": null,
    "deploymentTx": null
    ...
  }
}
```

Replace the example `chainId` with the actual chain ID.

The manifest is the canonical source for public deployment information,
including:

- chain ID
- oracle address
- oracle runtime codehash
- registry address
- registry deployment transaction

## Foundry filesystem permissions

The deployment script reads files from the repository-level `deployments/`
directory.

`contracts/foundry.toml` must therefore allow read access:

```toml
[profile.default]
src = "src"
test = "test"
script = "script"
out = "out"
libs = ["lib"]

solc = "0.8.36"
optimizer = true
optimizer_runs = 200

fs_permissions = [
    { access = "read", path = "../deployments" }
]
```

## Build

From the repository root:

```bash
pnpm run build:contracts
```

Run tests:

```bash
pnpm run test:contracts
```

Check formatting:

```bash
pnpm run fmt:contracts:check
```

## Verify the oracle before deployment

The deployment script performs these checks automatically, but they can also
be inspected manually.

For testnet:

```bash
ORACLE=$(jq -r \
  '.oracle.address' \
  deployments/robinhood-testnet.json)

EXPECTED_CODEHASH=$(jq -r \
  '.oracle.runtimeCodehash' \
  deployments/robinhood-testnet.json)
```

Check that the oracle has deployed code:

```bash
cast code \
  "$ORACLE" \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
```

The result must not be:

```text
0x
```

Check its runtime codehash:

```bash
cast codehash \
  "$ORACLE" \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
```

It must equal:

```bash
echo "$EXPECTED_CODEHASH"
```

and must also equal `EXPECTED_ORACLE_CODEHASH` in
`DrandQuicknetBeaconRegistry.sol`.

## Dry-run deployment

Always simulate before broadcasting.

### Robinhood Testnet

```bash
DEPLOYMENT_FILE=robinhood-testnet.json \
forge script \
  --root contracts \
  script/DeployRegistry.s.sol:DeployRegistry \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
```

### Robinhood Mainnet

```bash
DEPLOYMENT_FILE=robinhood-mainnet.json \
forge script \
  --root contracts \
  script/DeployRegistry.s.sol:DeployRegistry \
  --rpc-url "$ROBINHOOD_MAINNET_RPC_URL"
```

The simulation must succeed before using `--broadcast`.

## Deploy

### Robinhood Testnet

```bash
DEPLOYMENT_FILE=robinhood-testnet.json \
forge script \
  --root contracts \
  script/DeployRegistry.s.sol:DeployRegistry \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --verify \
  --verifier blockscout \
  --verifier-url "https://explorer.testnet.chain.robinhood.com/api" \
  --broadcast
  -vvv
```

### Robinhood Mainnet

```bash
DEPLOYMENT_FILE=robinhood-mainnet.json \
forge script \
  --root contracts \
  script/DeployRegistry.s.sol:DeployRegistry \
  --rpc-url "$ROBINHOOD_MAINNET_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --verify \
  --verifier blockscout \
  --verifier-url "https://robinhoodchain.blockscout.com/api" \
  --broadcast
  -vvv
```

Only the manifest filename changes between deployments. The Solidity script
does not contain chain-specific oracle addresses.

## What the deployment script validates

Before broadcasting the registry deployment, the script checks:

1. The manifest can be read.
2. `block.chainid` matches `.chainId` from the manifest.
3. `.oracle.address` has the runtime codehash recorded in the manifest.
4. The registry constructor accepts the oracle's codehash.

This protects against mistakes such as:

```text
Manifest:  robinhood-mainnet.json
RPC:       Robinhood Testnet
```

or:

```text
Manifest oracle:        0xABC...
Actual codehash:        0x111...
Manifest codehash:      0x222...
```

Both deployments fail before the registry is created.

## Post-deployment checks

After deployment, set the registry address:

```bash
REGISTRY=0x...
```

Verify the immutable oracle:

```bash
cast call \
  "$REGISTRY" \
  "oracle()(address)" \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
```

Compare it against the manifest:

```bash
jq -r \
  '.oracle.address' \
  deployments/robinhood-testnet.json
```

Verify the pinned oracle codehash:

```bash
cast call \
  "$REGISTRY" \
  "EXPECTED_ORACLE_CODEHASH()(bytes32)" \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
```

Verify the Quicknet constants:

```bash
cast call \
  "$REGISTRY" \
  "GENESIS_TIMESTAMP()(uint64)" \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"

cast call \
  "$REGISTRY" \
  "PERIOD_SECONDS()(uint64)" \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
```

Expected:

```text
GENESIS_TIMESTAMP = 1692803367
PERIOD_SECONDS    = 3
```

## Smoke test

Submit a known-valid Quicknet round:

```bash
ROUND=<round>
SIGNATURE=0x<signature>
```

Then:

```bash
TX=$(cast send \
  "$REGISTRY" \
  "submitBeacon(uint64,bytes)" \
  "$ROUND" \
  "$SIGNATURE" \
  --private-key "$PRIVATE_KEY" \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL" \
  --json | jq -r '.transactionHash')
```

Check the receipt:

```bash
cast receipt \
  "$TX" \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
```

Check storage:

```bash
cast call \
  "$REGISTRY" \
  "isStored(uint64)(bool)" \
  "$ROUND" \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
```

Expected:

```text
true
```

Read the randomness:

```bash
cast call \
  "$REGISTRY" \
  "getBeacon(uint64)(bytes32)" \
  "$ROUND" \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
```

The value must equal the oracle's `normalizedRoundHash` for the same round.

## Record the deployment

After deployment, update the corresponding manifest.

Before:

```json
{
  "registry": {
    "address": null,
    "deploymentTx": null
  }
}
```

After:

```json
{
  "registry": {
    "address": "0x...",
    "deploymentTx": "0x..."
  }
}
```

The completed deployment manifest should be committed to Git.

The manifest may also record reproducibility metadata:

```json
{
  "build": {
    "solc": "0.8.36",
    "optimizer": true,
    "optimizerRuns": 200,
    "viaIR": false
  }
}
```

## Mainnet checklist

Before a mainnet deployment:

- Foundry tests pass.
- Fuzz/invariant tests pass.
- `forge fmt --check` passes.
- Compiler and optimizer settings are frozen.
- The registry source is committed/tagged.
- The correct deployment manifest is selected.
- Manifest chain ID matches the target RPC.
- Oracle address has been independently verified.
- Oracle runtime codehash matches the manifest.
- Oracle runtime codehash matches `EXPECTED_ORACLE_CODEHASH`.
- Oracle is non-upgradeable.
- Oracle has no mutable security-critical verification configuration.
- Deployment account has sufficient gas funds.
- Dry-run deployment succeeds.
- Production deployment is broadcast.
- Registry source is verified on the chain explorer.
- Post-deployment smoke test succeeds.
- Deployment manifest is updated and committed.

## Security

`DrandQuicknetBeaconRegistry` only authenticates and caches Quicknet
randomness.

Consumers are responsible for:

- committing to a specific sufficiently-future round;
- never selecting randomness based on registry availability;
- never substituting another round;
- domain-separating the returned randomness for their application.

See the contract NatSpec for the complete consumer security requirements.