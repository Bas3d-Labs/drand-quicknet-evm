# Contract Deployment

This directory contains the Foundry project for
`DrandQuicknetBeaconRegistry`.

The deployment script reads verifier identity and expected chain ID from the
corresponding JSON manifest under `../deployments/`. The registry minimum lead
is supplied separately from the target chain-security profile.

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
  "manifestVersion": 1,
  "network": "example-network",
  "chainId": 12345,
  "registry": {
    "address": "0x...",
    "runtimeCodehash": "0x...",
    "deployment": {
      "transactionHash": "0x...",
      "blockNumber": 0
    }
  },
  "verifier": {
    "address": "0x...",
    "runtimeCodehash": "0x...",
    "deployment": {
      "transactionHash": "0x...",
      "blockNumber": 0
    }
  }
}
```

The manifest is the canonical source for durable artifact identity and
provenance, including:

- chain ID
- verifier address and runtime codehash
- registry address and runtime codehash
- deployment transaction and block provenance

Chain policy such as `minimumLeadRounds` belongs in the chain-security profile,
not in the deployment manifest.

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

## Verify the verifier before deployment

The deployment script performs these checks automatically, but they can also
be inspected manually.

For testnet:

```bash
VERIFIER=$(jq -r \
  '.verifier.address' \
  deployments/robinhood-testnet.json)

EXPECTED_CODEHASH=$(jq -r \
  '.verifier.runtimeCodehash' \
  deployments/robinhood-testnet.json)
```

Check that the verifier has deployed code:

```bash
cast code \
  "$VERIFIER" \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
```

The result must not be:

```text
0x
```

Check its runtime codehash:

```bash
cast codehash \
  "$VERIFIER" \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
```

It must equal:

```bash
echo "$EXPECTED_CODEHASH"
```

The deployment script additionally exercises the verifier's positive and
negative Quicknet KAT before creating the registry.

## Dry-run deployment

Always simulate before broadcasting.

The registry floor is a deployment input whose normative value comes from the
target chain-security profile, not from the deployment manifest. Before running
the script, set:

```bash
export MINIMUM_LEAD_ROUNDS=<timing.minimumLeadRounds from the target chain profile>
```

`DeployRegistry.s.sol` requires this value explicitly and validates that it is a
positive `uint64`.

### Robinhood Testnet

```bash
DEPLOYMENT_FILE=robinhood-testnet.json \
forge script \
  --root contracts \
  contracts/script/DeployRegistry.s.sol:DeployRegistry \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
```

### Robinhood Mainnet

```bash
DEPLOYMENT_FILE=robinhood-mainnet.json \
forge script \
  --root contracts \
  contracts/script/DeployRegistry.s.sol:DeployRegistry \
  --rpc-url "$ROBINHOOD_MAINNET_RPC_URL"
```

The simulation must succeed before using `--broadcast`.

## Deploy

### Robinhood Testnet

```bash
DEPLOYMENT_FILE=robinhood-testnet.json \
forge script \
  --root contracts \
  contracts/script/DeployRegistry.s.sol:DeployRegistry \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --verify \
  --verifier blockscout \
  --verifier-url "https://explorer.testnet.chain.robinhood.com/api" \
  --broadcast \
  -vvv
```

### Robinhood Mainnet

```bash
DEPLOYMENT_FILE=robinhood-mainnet.json \
forge script \
  --root contracts \
  contracts/script/DeployRegistry.s.sol:DeployRegistry \
  --rpc-url "$ROBINHOOD_MAINNET_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --verify \
  --verifier blockscout \
  --verifier-url "https://robinhoodchain.blockscout.com/api" \
  --broadcast \
  -vvv
```

The deployment manifest supplies artifact identity. `MINIMUM_LEAD_ROUNDS` is a
separate policy input sourced from the target chain profile. The Solidity script
does not hard-code chain-specific verifier addresses or lead policy.

## What the deployment script validates

Before broadcasting the registry deployment, the script checks:

1. The deployment manifest can be read.
2. `block.chainid` matches `.chainId` from the manifest.
3. `.verifier.address` has the runtime codehash recorded in the manifest.
4. `MINIMUM_LEAD_ROUNDS` is a positive `uint64`.
5. The verifier accepts the known-good Quicknet KAT vector.
6. The verifier rejects the corrupted negative KAT vector.
7. The registry constructor accepts the verifier identity and explicit floor.

This protects against mistakes such as:

```text
Manifest:  robinhood-mainnet.json
RPC:       Robinhood Testnet
```

or:

```text
Manifest verifier:      0xABC...
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

## Record the deployment

After deployment, update the corresponding deployment manifest with the
registry's durable identity and provenance:

```json
{
  "registry": {
    "address": "0x...",
    "runtimeCodehash": "0x...",
    "deployment": {
      "transactionHash": "0x...",
      "blockNumber": 0
    }
  }
}
```

The completed deployment manifest should be committed to Git. Keep policy such
as `minimumLeadRounds` in the chain-security profile rather than copying it into
the manifest.

## Mainnet checklist

Before a mainnet deployment:

- Foundry tests pass.
- Fuzz/invariant tests pass.
- `forge fmt --check` passes.
- Compiler and optimizer settings are frozen.
- The registry source is committed/tagged.
- The correct deployment manifest is selected.
- Manifest chain ID matches the target RPC.
- Verifier address has been independently verified.
- Verifier runtime codehash matches the manifest.
- The chain-profile `minimumLeadRounds` value is supplied explicitly to the deployment script.
- Verifier deployment self-tests pass.
- Verifier is non-upgradeable.
- Verifier has no mutable security-critical verification configuration.
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