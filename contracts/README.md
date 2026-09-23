# Contract Deployment

This directory contains the Foundry project for the Quicknet verifier,
beacon registry, and randomness consumer contracts.

The Foundry project contains:

- `DrandQuicknetBeaconVerifier`: verifies Quicknet signatures.
- `DrandQuicknetBeaconRegistry`: verifies and caches beacons.
- `DrandQuicknetRandomnessConsumer`: provides consumer integration helpers.

The registry supports `submitBeacon` and `submitBeaconWithWitness`.
Both methods share the same cache and produce the same randomness.

Public deployment identity belongs in `deployments/`.
Secrets and RPC credentials belong in the repository-root `.env`.

## Setup

Required tools: Foundry, Node.js 24+, pnpm

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

The target chain must support the precompiles used by the verifier with
compatible behavior and sufficient gas under its configured call limits.
Local Foundry tests alone do not establish target-chain compatibility.

See `../scripts/quicknet-kat/README.md` for the independent audit and
read-only target-chain checks.

Set the following in the repository-root `.env`:

```dotenv
PRIVATE_KEY=
QUICKNET_RPC_URL=
```

Load the environment and select a deployment manifest:

```bash
set -a
source .env
set +a

export DEPLOYMENT_FILE="example-network.json"
MANIFEST="deployments/$DEPLOYMENT_FILE"

: "${PRIVATE_KEY:?Missing PRIVATE_KEY}"
: "${QUICKNET_RPC_URL:?Missing QUICKNET_RPC_URL}"

cast wallet address --private-key "$PRIVATE_KEY"
```

`DEPLOYMENT_FILE` is relative to `deployments/`.
`QUICKNET_RPC_URL` must point to the intended chain.

## Deployment manifest

Use `deployments/<network>.json` to record contract identity and deployment
provenance:

```json
{
  "manifestVersion": 1,
  "network": "example-network",
  "chainId": 12345,
  "verifier": {
    "address": "0x...",
    "runtimeCodehash": "0x...",
    "deployment": {
      "transactionHash": "0x...",
      "blockNumber": 0
    }
  },
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

Replace the example values with the actual deployment values. For a new
deployment, start with the manifest version, network, and intended chain ID,
then add each contract after deploying and authenticating it.

The registry deployment script reads the chain ID and verifier identity.
The registry fields are populated after deployment.

Chain policy such as `minimumLeadRounds` belongs in the chain-security profile,
not in the deployment manifest.

## Build and test

```bash
pnpm run build:contracts
pnpm run test:contracts
pnpm run fmt:contracts:check
pnpm test:quicknet-kat
```

Run the complete workspace check before finalizing changes:

```bash
pnpm check
```

Preserve the compiler, EVM target, and optimizer settings in
`contracts/foundry.toml`. Its filesystem permissions must allow reading
`../deployments` and the existing test fixtures.

The target chain must provide compatible precompiles. Local test success
alone does not establish target-chain compatibility.

## Deploy

Check the RPC chain ID against the selected manifest:

```bash
cast chain-id --rpc-url "$QUICKNET_RPC_URL"
jq -er '.chainId' "$MANIFEST"
```

The values must match before proceeding. `DeployRegistry.s.sol` also checks
this internally; `DeployVerifier.s.sol` does not read the manifest.

### 1. Verifier

Simulate deployment:

```bash
forge script contracts/script/DeployVerifier.s.sol:DeployVerifier \
  --root contracts \
  --rpc-url "$QUICKNET_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  -vvv
```

After simulation succeeds, repeat with `--broadcast`.

From the mined receipt, record the verifier address, transaction hash, and
block number. Confirm that its deployed runtime matches the compiled
verifier artifact, then record its runtime codehash in the manifest:

```bash
cast codehash "$VERIFIER" --rpc-url "$QUICKNET_RPC_URL"
```

Set `VERIFIER` to the actual mined deployment address. Do not use a dry-run
address as evidence of deployment.

An existing verifier may be reused if its runtime is authenticated and it
supports both verification methods.

### 2. Registry

Set and export `MINIMUM_LEAD_ROUNDS` to the value specified by the target
chain-security profile:

```bash
export MINIMUM_LEAD_ROUNDS
: "${MINIMUM_LEAD_ROUNDS:?Set this from the target chain-security profile}"
```

Simulate deployment:

```bash
forge script contracts/script/DeployRegistry.s.sol:DeployRegistry \
  --root contracts \
  --rpc-url "$QUICKNET_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  -vvv
```

After simulation succeeds, repeat with `--broadcast`.

The script checks:

- The manifest chain ID matches the target chain.
- The verifier runtime codehash matches the manifest.
- The minimum lead is a positive `uint64`.
- Both verification methods accept the positive Quicknet KAT.
- Both methods reject the negative KAT. The witness negative uses the
  sign-flipped signature with its matching opposite y-coordinate.

The constructor also requires deployed verifier code and a matching
nonzero codehash.

Record the registry's mined address, transaction hash, and block number.
Authenticate its runtime before recording the runtime codehash:

```bash
cast codehash "$REGISTRY" --rpc-url "$QUICKNET_RPC_URL"
```

Set `REGISTRY` to the actual mined deployment address.

The registry runtime contains immutable constructor values. Compare it
against runtime reconstructed with the exact constructor arguments, rather
than an unpatched compiled runtime template.

## Post-deployment checks

Using the completed manifest:

```bash
REGISTRY=$(jq -er '.registry.address' "$MANIFEST")

cast call "$REGISTRY" "verifier()(address)" \
  --rpc-url "$QUICKNET_RPC_URL"

cast call "$REGISTRY" "verifierCodehash()(bytes32)" \
  --rpc-url "$QUICKNET_RPC_URL"

cast call "$REGISTRY" "minimumLeadRounds()(uint64)" \
  --rpc-url "$QUICKNET_RPC_URL"
```

The verifier identity must match the manifest. The minimum lead must match
the selected chain-security profile.

Verify contract source through the target chain's explorer, then run the
smoke test:

```bash
bash scripts/smoke-test-registry.sh "$MANIFEST"
```

The smoke test:

- Checks chain ID, runtime codehashes, and configured verifier identity.
- Simulates an incorrect witness and expects rejection.
- Broadcasts one witness submission and one compressed submission.
- Checks published randomness and matching `BeaconStored` events.
- Simulates both cached submission methods with invalid inputs.

It requires two distinct, unstored rounds from the KAT fixture. Defaults
are 1000 and 13335. To select other fixture rounds:

```bash
SMOKE_WITNESS_ROUND=255 \
SMOKE_COMPRESSED_ROUND=256 \
  bash scripts/smoke-test-registry.sh "$MANIFEST"
```

Already-stored rounds bypass verification and cannot test a fresh import.
The smoke test uses historical beacons; it does not validate consumer
commitment timing.

Finish by running `pnpm check` and committing the completed manifest.

## Security

The registry authenticates and caches Quicknet randomness.

Consumers remain responsible for:

- authenticating their registry deployment;
- committing to one sufficiently future round;
- choosing a lead at least as large as the authenticated registry floor;
- accounting for chain timing and finality assumptions;
- selecting rounds independently of registry availability;
- never substituting another round after commitment;
- domain-separating randomness for their application.

Neither submission method enforces the consumer lead policy.

Witness coordinates are untrusted inputs validated on-chain. Verifier
identity is pinned at construction, but codehash pinning does not guarantee
correctness or freeze precompile behavior and pricing.

Updating a deployment manifest does not migrate consumers pinned to an older
registry.

See the contract NatSpec for the complete consumer security requirements.