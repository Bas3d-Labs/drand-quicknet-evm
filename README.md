# drand-quicknet-evm

Permissionless drand Quicknet randomness infrastructure for EVM chains.

`drand-quicknet-evm` provides contracts, TypeScript libraries, and reference relayer tooling for making [drand Quicknet](https://drand.love/) randomness available on-chain.

The core model is simple:

```text
drand Quicknet
      ↓
DrandOracleQuicknet
      ↓
DrandQuicknetBeaconRegistry
      ↓
consumer contracts
```

Applications commit to an **exact future Quicknet round** before that round becomes knowable. Anyone may then submit the corresponding drand beacon to the shared registry.

Relayers are permissionless couriers. They do not choose randomness, select fallback rounds, or control application settlement.

## Why?

Many EVM applications need publicly verifiable randomness but cannot rely on a chain-specific VRF deployment.

drand provides a distributed randomness beacon with a deterministic publication schedule. Quicknet publishes a new beacon approximately every 3 seconds.

This project provides the EVM-side infrastructure needed to safely use those beacons:

* verify drand Quicknet signatures on-chain
* normalize each beacon to one canonical randomness value
* cache verified randomness by exact Quicknet round
* let any account submit valid beacons
* fetch and submit beacons using a reference TypeScript relayer
* support future-round waiting and bounded drand API retries
* provide a path toward permissionless demand-driven relaying across applications and chains

## Security model

The most important rule is: **Consumers commit to an exact Quicknet round before that round becomes knowable, and settlement uses only that exact round.**

A consumer must never choose randomness based on which beacons happen to be available in the registry.

Unsafe patterns include:

* latest stored round
* first available round
* latest available beacon
* R, otherwise R + 1
* retry with another round
* pick among several stored rounds

The safe flow is:

```text
consumer commits to exact round R
              ↓
R becomes publicly knowable
              ↓
any relayer submits R
              ↓
registry verifies and stores R
              ↓
consumer settles using exactly R
```

If round `R` is temporarily unavailable, that is a **liveness problem**, not permission to use a different source of randomness.

### Domain separation

Applications should derive their own random seed from the stored beacon rather than using the registry value directly for every purpose.

For example:

```solidity
bytes32 seed = keccak256(
    abi.encode(
        DOMAIN_TAG,
        block.chainid,
        address(this),
        campaignId,
        drawId,
        beacon
    )
);
```

This allows many applications and draws to safely consume the same Quicknet beacon without sharing application-level outcomes.

### Relayer trust

Relayers are not trusted randomness providers.

The registry verifies every submitted drand signature on-chain. A malicious relayer may delay or refuse to submit a beacon, but it cannot create a valid alternative value for the committed round.

The registry is intentionally permissionless:

```text
Relayer A ──┐
Relayer B ──┼──> submitBeacon(R, signature)
Relayer C ──┘
```

Whichever relayer submits a valid beacon first populates the same canonical value.

## Architecture

```text
                         drand Quicknet
                              │
                              │ beacon R
                              ▼
                    DrandOracleQuicknet
                    BLS12-381 verification
                              │
                              │ normalized hash
                              ▼
                DrandQuicknetBeaconRegistry
                   mapping(round => randomness)
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
          Consumer A      Consumer B      Consumer C
```

The reference relayer performs:

```text
exact round R
     ↓
verify registry deployment
     ↓
already stored?
 ┌───┴────┐
 yes      no
 │         ↓
 │   wait until R is scheduled
 │         ↓
 │   fetch exact R
 │         ↓
 │   bounded HTTP retries
 │         ↓
 │   decompress signature off-chain
 │         ↓
 │   simulate submission
 │         ↓
 │   submit transaction
 │         ↓
 │   wait for receipt
 │         ↓
 │   verify stored randomness
 │
 ▼
success
```

The round is never changed during this process.

## Repository structure

```text
drand-quicknet-evm/
├── contracts/
│   ├── src/
│   ├── test/
│   ├── script/
│   ├── foundry.toml
│   └── remappings.txt
│
├── packages/
│   ├── drand-quicknet/
│   │   └── @based-labs/drand-quicknet
│   │
│   └── registry-sdk/
│       └── @based-labs/drand-quicknet-registry
│
├── apps/
│   └── relayer/
│       └── @based-labs/drand-quicknet-relayer
│
├── deployments/
├── docs/
├── scripts/
├── package.json
└── README.md
├── ...
```

## Components

### `DrandOracleQuicknet`

The oracle verifies drand Quicknet BLS signatures using EVM BLS12-381 functionality.

The current architecture keeps the verifier separately deployed and pinned rather than treating it as application-owned mutable infrastructure.

The registry expects a specific verifier implementation.

Applications should treat verifier upgrades as new deployments rather than silently changing the cryptographic implementation behind an existing registry.

### `DrandQuicknetBeaconRegistry`

The registry is a permissionless cache of verified Quicknet randomness:

```solidity
round => normalized randomness
```

Important properties:

* submissions are permissionless
* every new beacon is verified by the configured oracle
* each exact round maps to one canonical normalized value
* previously stored rounds are idempotent
* no owner selects randomness
* no relayer allowlist is required
* no "latest randomness" settlement mechanism exists
* consumers are responsible for committing to a future round safely

The registry also exposes Quicknet schedule helpers such as:

```solidity
roundAt(timestamp)
roundScheduledTime(round)
latestScheduledRound()
```

### `@based-labs/drand-quicknet`

Low-level TypeScript tooling for Quicknet.

It provides:
* Quicknet schedule constants
* roundAt()
* roundScheduledTime()
* compressed signature parsing
* Quicknet HTTP fetching
* multi-endpoint failover
* BLS G1 signature decompression
* typed compressed/uncompressed signatures

The official relayer fetches drand's compressed 48-byte signature and decompresses it off-chain before submission.

Both compressed and uncompressed signatures normalize to the same registry randomness, but submitting the uncompressed representation avoids expensive on-chain point decompression.

### `@based-labs/drand-quicknet-registry`

TypeScript SDK for interacting with a registry deployment.

It provides:
* registry ABI
* deployment metadata types
* runtime deployment verification
* registry reads
* submission simulation
* beacon submission

Before using a deployment, the SDK can verify:

```text
expected chain ID
        +
contract exists
        +
runtime bytecode hash matches manifest
```

### Reference relayer

The reference relayer lives in:

```text
apps/relayer
```

It currently supports two one-shot commands.

`import` attempts to import an exact round immediately:

```bash
pnpm --filter @based-labs/drand-quicknet-relayer start \
  import \
  --network robinhood-testnet \
  --round 31089008
```

If the round is already stored, it exits successfully without sending another transaction.

`import-when-available` also supports future rounds:

```bash
pnpm --filter @based-labs/drand-quicknet-relayer start \
  import-when-available \
  --network robinhood-testnet \
  --round 31192648
```

Its behavior is:

```text
check registry
      ↓
wait until exact round R is scheduled
      ↓
retry fetching exact R for a bounded period
      ↓
import exact R
```

Only the public drand fetch stage is automatically retried.

Transaction submission is **not blindly retried** because transaction state can become ambiguous after broadcast.

## Quicknet schedule

The Quicknet schedule used by this project is deterministic:

```text
genesis: 1692803367
period:  3 seconds
```

For a timestamp at or after genesis:

```text
roundAt(timestamp)
```

determines the corresponding Quicknet round.

Consumers should generally commit to a round sufficiently far in the future to ensure the commitment is finalized before the beacon can become knowable.

The appropriate lead time is application and chain dependent.

## Installation

Requirements:

```text
Node.js
pnpm
Foundry
```

Install workspace dependencies from the repository root:

```bash
pnpm install
```

Build the TypeScript packages and relayer as needed:

```bash
pnpm run build:quicknet
pnpm run build:registry-sdk
pnpm run build:relayer
```

Build and test the Solidity contracts:

```bash
cd contracts
forge build
forge test
```

## Relayer configuration

The relayer reads operator secrets and RPC configuration from environment variables.

For Robinhood Chain Testnet:

```dotenv
ROBINHOOD_TESTNET_RPC_URL=https://...
PRIVATE_KEY=0x...
```

The private key should belong to a dedicated relayer account with enough native currency to pay transaction fees.

Do not give the relayer account application administration, treasury, upgrade, or custody privileges.

For local development, the relayer currently loads the root `.env` through Node:

```text
node --env-file=../../.env ...
```

Never commit `.env` or private keys.

## Deployment manifests

Canonical deployment metadata lives under:

```text
deployments/
```

For example:

```text
deployments/robinhood-testnet.json
```

A deployment manifest supplies the chain ID, registry address, and expected runtime codehash used by the relayer and SDK.

The relayer validates the manifest and then verifies the deployed runtime bytecode before servicing it.

Deployment facts belong in manifests; operator-specific values such as RPC URLs and private keys belong in operator configuration.

This separation is intended to support additional chains without hard-coding deployment addresses into relayer logic.

## Current network support

The reference configuration currently includes:

```text
Robinhood Chain Testnet
```

Additional compatible chains can be added by deploying and verifying the required oracle/registry infrastructure and publishing a deployment manifest.

A chain definition existing in an EVM library does **not** by itself mean the chain is compatible with this verifier. The required cryptographic precompiles and verifier behavior must be available and tested.

The long-term relayer design allows operators to service deployments beyond the repository's built-in network list.

## Permissionless multi-chain model

The protocol and reference software intentionally distinguish between:

```text
canonical deployment information
```

and:

```text
which deployments/consumers a particular operator chooses to fund
```

Anyone may run a relayer.

Operators choose which networks and applications they are willing to service because relaying consumes their RPC resources and transaction fees.

A configured consumer or deployment list is therefore an **operator policy**, not an on-chain relayer allowlist.

## Consumer request standard

The project is introducing a minimal consumer demand signal:

```solidity
interface IQuicknetRandomnessConsumer {
    event QuicknetRandomnessRequested(
        uint64 indexed round
    );

    function quicknetBeaconRegistry()
        external
        view
        returns (address);
}
```

A consumer emits `QuicknetRandomnessRequested(R)` only after it has committed to exact round `R`.

The event means:

> Ensure exact Quicknet round `R` is available in this consumer's configured beacon registry.

It does **not** authorize a relayer to:

* choose another round
* select an outcome
* call application settlement
* change application state
* choose odds
* issue refunds

For the first daemon implementation, relayer operators will configure which consumer contracts they want to watch.

A future discovery mechanism can supply consumer addresses dynamically without changing the event/interface standard.

## Planned daemon

The automated daemon is intentionally demand-driven.

It will not import every Quicknet beacon every 3 seconds.

Instead:

```text
configured consumer
       ↓
QuicknetRandomnessRequested(R)
       ↓
deduplicate R
       ↓
registry already contains R?
   ┌───────────┴───────────┐
  yes                      no
   │                        ↓
 done             import when available
```

This avoids approximately 28,800 unnecessary registry transactions per chain per day when there is no demand.

The first reference daemon will watch a configured list of consumer addresses.

Future discovery mechanisms may include shared manifests or on-chain directories, while preserving the same underlying consumer event and permissionless registry submission model.

## Testing

Run relayer tests:

```bash
pnpm run relayer:test
```

Run relayer source and test typechecking:

```bash
pnpm run relayer:typecheck
```

Build the relayer:

```bash
pnpm run relayer:build
```

The test suites cover areas including:

* Quicknet HTTP parsing and endpoint failover
* signature decompression
* known Quicknet vectors
* registry SDK reads and writes
* deployment manifest validation
* deployment runtime verification
* relayer configuration
* CLI parsing
* exact-round import
* future-round waiting
* bounded beacon fetch retries
* permissionless relayer races
* already-stored idempotency
* wait → fetch → import orchestration

## Live test status

The reference relayer has successfully imported verified Quicknet beacons into the Robinhood Chain Testnet registry.

A live future-round test successfully exercised:

```text
future exact round
      ↓
scheduled wait
      ↓
Quicknet fetch
      ↓
off-chain decompression
      ↓
on-chain verification
      ↓
registry storage
```

Re-running the same operation returned the existing beacon without sending another transaction, confirming the composed import path is idempotent.

## Known-vector testing

Known external Quicknet vectors are used to verify compatibility between drand, the TypeScript tooling, the on-chain verifier, and the registry.

For example, Quicknet round `31089008` normalizes to:

```text
0x9b81abb093df33375d039627e697083932b2d07ea75f7add4aa3389a13370b17
```

The same normalized value must be produced regardless of whether the corresponding valid BLS signature is supplied in compressed or canonical uncompressed form.

## Operational guidance

Relayer operators should:

- use a dedicated low-value transaction-signing account
- verify deployment runtime codehashes before servicing them
- use independent RPC infrastructure where practical
- never sponsor arbitrary user-supplied signature calldata without validation
- fetch requested drand signatures from known Quicknet endpoints
- decompress and validate signatures locally before broadcasting
- simulate registry submissions before sending transactions
- service only the exact committed round
- treat already-stored rounds as successful
- avoid blindly retrying transactions after ambiguous broadcast failures
- persist enough daemon state to safely recover after restarts
- expect multiple independent relayers to race for the same request

## Liveness vs randomness selection

A key design goal is to keep liveness policy separate from randomness selection.

If a relayer or drand endpoint is unavailable:

```text
correct response:
retry retrieving exact R
      ↓
wait for another relayer
      ↓
recover service for exact R
```

not:

```text
unsafe response:
use another round
      ↓
use latest randomness
      ↓
reroll
      ↓
choose whichever beacon is available
```

A delayed exact beacon preserves fairness. Selecting a replacement based on availability can introduce bias.

## Auditing and production use

This project handles infrastructure that may ultimately determine outcomes with financial value.

Before production deployment:

1. Audit consumer commitment logic
2. Audit registry integration
3. Audit verifier assumptions
4. Pin deployed bytecode
5. Verify deployment manifests
6. Test chain-specific precompile behavior
7. Run independent relayers
8. Test downtime/recovery behavior
9. Monitor drand and RPC availability

The upstream verifier implementation used by the current deployment has not been treated as professionally audited solely by virtue of being open source.

Do not infer production safety from testnet operation alone.

## License

See [`LICENSE`](./LICENSE).

Third-party components may be governed by their own licenses. In particular, verifier code should not be copied or relicensed without reviewing the upstream license terms.

## Contributing

Contributions are welcome, particularly around:

- additional compatible EVM deployments
- consumer integrations
- relayer reliability
- daemon operation
- observability
- deployment verification
- test vectors
- security review
- open consumer discovery

Changes affecting exact-round commitment, verifier behavior, randomness normalization, or fallback policy should be treated as security-sensitive.