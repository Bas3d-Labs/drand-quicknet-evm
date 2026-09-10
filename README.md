# drand-quicknet-evm

Permissionless drand Quicknet randomness infrastructure for EVM chains.

`drand-quicknet-evm` provides Solidity contracts, TypeScript libraries,
reference relayer tooling, and chain-security verification tooling for making
[drand Quicknet](https://drand.love/) randomness available to EVM
applications.

```text
drand Quicknet
      ↓
DrandQuicknetBeaconVerifier
      ↓
DrandQuicknetBeaconRegistry
      ↓
DrandQuicknetRandomnessConsumer
      ↓
applications
```

Applications commit to an **exact future Quicknet round before that round
becomes knowable**. Anyone may then submit the corresponding drand beacon to
the shared registry.

Relayers are permissionless couriers. They do not choose randomness, select
fallback rounds, or control application settlement.

License: [MIT](LICENSE).

## Contents

- [Quickstart](#quickstart)
- [Core security rule](#core-security-rule)
- [Architecture](#architecture)
- [Cryptographic verification](#cryptographic-verification)
- [Registry](#registry)
- [Consumer model](#consumer-model)
- [Relayer trust](#relayer-trust)
- [Quicknet schedule and lead rounds](#quicknet-schedule-and-lead-rounds)
- [Chain security profiles](#chain-security-profiles)
- [Deployment manifests](#deployment-manifests)
- [Permissionless multi-chain support](#permissionless-multi-chain-support)
- [Reference relayer](#reference-relayer)
- [Repository structure](#repository-structure)
- [Testing](#testing)
- [Production use](#production-use)
- [Contributing](#contributing)

## Quickstart

### Install

Requirements:

```text
Node.js 24+
pnpm
Foundry
```

Install workspace dependencies:

```bash
pnpm install
```

Build and test the Solidity contracts:

```bash
pnpm build:contracts
pnpm test:contracts
```

### Integrate a consumer

A consumer extends `DrandQuicknetRandomnessConsumer`, commits to an exact future
round, persists that round in application state, and later settles from that
exact beacon.

The example below uses the actual base-contract API to implement a simple coin
flip.

```solidity
contract CoinFlip is DrandQuicknetRandomnessConsumer {
    bytes32 internal constant QUICKNET_REGISTRY_CODEHASH =
        0x...; // from deployments/<network>.json

    bytes32 internal constant DOMAIN = keccak256("COIN_FLIP_V1");

    uint256 public nextFlipId;

    mapping(uint256 => uint64) public committedRound;
    mapping(uint256 => bool) public settled;
    mapping(uint256 => bool) public heads;

    event CoinFlipSettled(
        uint256 indexed flipId,
        bool heads
    );

    constructor(
        address registry,
        uint64 leadRounds
    )
        DrandQuicknetRandomnessConsumer(
            registry,
            QUICKNET_REGISTRY_CODEHASH,
            leadRounds
        )
    {}

    function flip()
        external
        returns (uint256 flipId)
    {
        flipId = nextFlipId++;

        // Commit to the exact future Quicknet round before
        // its randomness becomes knowable.
        committedRound[flipId] = _requestQuicknetRandomness();

        // Bind every outcome-sensitive input here, before
        // the requested round becomes knowable.
    }

    function settle(
        uint256 flipId
    ) external {
        require(!settled[flipId], "flip already settled");

        uint64 round = committedRound[flipId];

        // Quicknet rounds are 1-based, so 0 is a safe
        // sentinel for a flip that was never requested.
        require(round != 0, "flip not requested");

        bytes32 randomness = _getQuicknetBeacon(round);

        bytes32 seed = _deriveQuicknetSeed(
            DOMAIN,
            bytes32(flipId),
            round,
            randomness
        );

        bool isHeads = (uint256(seed) & 1) == 0;

        settled[flipId] = true;
        heads[flipId] = isHeads;

        emit CoinFlipSettled(
            flipId,
            isHeads
        );
    }
}
```

The base constructor:

- authenticates the registry runtime codehash
- reads the authenticated registry's `minimumLeadRounds()`
- requires `leadRounds >= minimumLeadRounds`
- preserves the application-selected `leadRounds` for future commitments

The expected registry codehash should come through a channel with review-time
integrity, such as a source constant, a network-specific build artifact, or an
immutable on-chain configuration the application already trusts. It should not
come from the same mutable runtime configuration that supplies the registry
address.

For a network-specific deployment, embedding the codehash from the trusted
deployment manifest directly in reviewed application source is the simplest
pattern.

`_requestQuicknetRandomness()` commits to an exact future round and emits:

```solidity
QuicknetRandomnessRequested(round)
```

The application is responsible for persisting the returned round and refusing
to replace it later.

`flipId` is unique within the application domain and therefore serves as the
unique request ID for seed derivation.

All outcome logic should depend only on the derived seed and state committed
before the requested round became knowable. Extracting one bit, as above, gives
an exact 50/50 choice. For non-power-of-two ranges, simple `% n` reduction has
a small modulo bias; use rejection sampling when exact uniformity is required.

If the normal relayer path has not imported the beacon, a consumer may expose a
permissionless wrapper around `_submitQuicknetBeacon(round, signature)` for the
**same committed round**. That is a liveness-recovery path, never a
round-selection path.

### Run the reference relayer

Using the repository's current Robinhood Testnet custom descriptor, configure:

```dotenv
QUICKNET_RPC_URL=https://...
PRIVATE_KEY=0x...
QUICKNET_CONSUMERS=0x...
QUICKNET_START_BLOCK=0
QUICKNET_CHECKPOINT_FILE=.state/quicknet-relayer.json
```

Then run the demand-driven daemon:

```bash
pnpm build:relayer
pnpm --filter @based-labs/drand-quicknet-relayer start \
  daemon \
  --network-config networks/examples/robinhood-testnet-custom.json
```

See [`apps/relayer/README.md`](apps/relayer/README.md) for full operator
documentation.

## Core security rule

The most important rule is:

> **A consumer commits to an exact future Quicknet round before that round
> becomes knowable, and settlement uses only that exact round.**

A consumer must never choose randomness based on which beacons happen to be
available.

Unsafe patterns include:

- latest stored round
- first available round
- latest available beacon
- `R`, otherwise `R + 1`
- retry with another round
- choose among several stored rounds

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

If round `R` is temporarily unavailable, that is a **liveness problem**, not
permission to choose another source of randomness.

### Liveness vs randomness selection

If a relayer or drand endpoint is unavailable:

```text
correct:
retry exact R
    ↓
wait for another relayer
    ↓
recover exact R
```

not:

```text
unsafe:
use another round
    ↓
use latest randomness
    ↓
reroll
    ↓
choose whichever beacon is available
```

A delayed exact beacon preserves the committed randomness source. Selecting a
replacement based on availability can introduce bias.

## Architecture

```text
                         drand Quicknet
                              │
                              │ canonical signature for R
                              ▼
                DrandQuicknetBeaconVerifier
                    BLS12-381 verification
                              │
                              │ sha256(signature)
                              ▼
                DrandQuicknetBeaconRegistry
                   mapping(round => randomness)
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
          Consumer A      Consumer B      Consumer C
```

The verifier, registry, consumers, and relayers intentionally have different
trust roles.

## Cryptographic verification

`DrandQuicknetBeaconVerifier` verifies canonical drand Quicknet BLS12-381
beacons.

For a nonzero Quicknet round, it accepts only the canonical 48-byte compressed
G1 signature published by drand. On successful verification, the returned
randomness is:

```text
sha256(canonical compressed signature)
```

### Deployment self-test

Every verifier deployment performs a two-sided known-answer self-test through
the complete verification path:

```text
known valid Quicknet round-1000 vector
              ↓
must verify and produce the known randomness

same vector with a deliberate sign-bit mutation
              ↓
must be rejected and return zero randomness
```

Construction reverts with `PositiveSelfTestFailed` or `NegativeSelfTestFailed`
if either side produces the wrong result.

This means a verifier cannot deploy successfully unless the target execution
environment demonstrates both acceptance of a known-good Quicknet beacon and
rejection of a corrupted one through the exact deployed verification path.

The repository also contains fixture and compatibility tests. A production
hardening milestone is to expand the KAT corpus with additional independently
sourced and cross-implementation vectors; that is an expansion of existing
coverage, not the project's first known-answer test.

The verifier is deployed separately from the registry. The registry pins both
the verifier address and its runtime codehash so an existing registry cannot
silently begin trusting a different verifier implementation.

## Registry

`DrandQuicknetBeaconRegistry` is a permissionless cache:

```solidity
round => canonical randomness
```

Important properties:

- submissions are permissionless
- every new beacon is cryptographically verified
- each exact round maps to one canonical value
- stored rounds are immutable and repeated submissions are idempotent
- no owner selects randomness
- no relayer allowlist is required
- no "latest randomness" settlement API exists
- consumers read by exact round

Strict reads use:

```solidity
getBeacon(round)
```

Availability can be checked without reverting using:

```solidity
isStored(round)
```

The registry also exposes Quicknet schedule helpers:

```solidity
roundAt(timestamp)
roundScheduledTime(round)
latestScheduledRound()
```

and the deployment's minimum supported consumer lead:

```solidity
minimumLeadRounds()
```

`minimumLeadRounds` constrains reference-consumer configuration. It does not
restrict permissionless submission of otherwise valid historical, current, or
future beacons.

## Consumer model

`DrandQuicknetRandomnessConsumer` provides the canonical application-facing
integration.

It:

- pins the registry address immutably
- verifies the expected registry runtime codehash at construction
- requires a nonzero configured lead
- requires that configured lead to satisfy the registry floor
- preserves the configured lead rather than replacing it with the floor
- derives the requested round from the commitment transaction's inclusion time
- emits `QuicknetRandomnessRequested(round)`
- reads only explicitly supplied exact rounds
- derives domain-separated application seeds
- exposes an internal exact-round submission helper for liveness recovery

The base contract does **not** persist application request IDs or committed
rounds. The application must persist the exact round returned by
`_requestQuicknetRandomness()` and must reject attempts to overwrite or replace
that commitment.

The requested round is:

```text
latestScheduledRound() at inclusion + quicknetLeadRounds
```

A transaction delayed before inclusion therefore selects a correspondingly
later future round. Mempool arrival time is not part of the commitment rule.

### Domain separation

Applications should derive an application-specific seed rather than using
registry randomness directly for every purpose.

The reference base binds seed derivation to:

```text
consumer seed domain
application domain
chain ID
consumer address
unique request ID
exact Quicknet round
verified randomness
```

`uniqueRequestId` must be unique for each randomness-consuming request within
an application domain.

## Relayer trust

Relayers are not trusted randomness providers.

The registry verifies every submitted beacon on-chain.

```text
Relayer A ──┐
Relayer B ──┼──> submit exact beacon R
Relayer C ──┘
```

A malicious relayer may delay or refuse to submit a beacon, but it cannot
construct a valid alternative value for the committed round.

A `QuicknetRandomnessRequested(R)` event means only:

> Ensure exact Quicknet round `R` is available in this consumer's configured
> registry.

It does **not** authorize the relayer to:

- choose another round
- select an outcome
- call application settlement
- change application state
- choose odds
- issue refunds

Whichever relayer successfully submits the valid exact beacon first populates
the same canonical registry value.

## Quicknet schedule and lead rounds

Quicknet has a deterministic schedule:

```text
genesis: 1692803367
period:  3 seconds
```

Rounds are scheduled on a fixed 3-second cadence. Actual publication may occur
shortly after a round's scheduled time.

For a timestamp at or after genesis:

```text
roundAt(timestamp)
```

determines the latest scheduled Quicknet round.

### Minimum lead

A registry exposes:

```solidity
minimumLeadRounds()
```

Consumers using the reference base must configure:

```text
quicknetLeadRounds >= minimumLeadRounds
```

The appropriate floor is **chain dependent** and must not be copied blindly
from another network.

For Quicknet period `P = 3` and lead `L`, the mechanical chain-clock separation
is:

```text
3L - 2 through 3L seconds
```

That arithmetic only describes distance relative to the chain's own clock.
Whether that clock and the chain's history-selection rules provide the desired
security depends on the chain's security model.

## Chain security profiles

The protocol contracts are designed for compatible EVM chains, but different
chains have different timestamp, sequencing, consensus, and parent-chain
semantics.

Chain profiles document and verify those network-specific assumptions.

Profiles live under:

```text
docs/security/chain-profiles/
```

A profile consists of:

```text
<network>.yaml   normative machine-readable configuration
<network>.md     explanatory security analysis
```

The YAML contains a checked relative `documentation` reference to the Markdown
file. The loader validates the referenced file and resolves the configured
`securityModel.assumptionsSection` against explicit anchors in that document.

A profile answers questions such as:

- what chain is being used?
- who or what controls `block.timestamp`?
- what sequencing/history assumptions exist?
- what minimum lead policy applies?
- what monitoring policy applies?
- what parent-chain configuration is expected?
- which deployment manifest belongs to the profile?
- which mutable live values are expected?

Network-specific policy values should be read from the committed profile rather
than duplicated in this README.

### Onboarding tiers

Profiles use onboarding tiers to describe verification maturity:

```text
Tier 1
structurally and semantically complete
        ↓
Tier 2
one-shot deployment and chain-state verification exercised
        ↓
Tier 3
recurring watches and alerting operational
```

Tier 2 and Tier 3 are operational claims; they cannot be established solely by
loading a profile.

A committed verification report is historical evidence for a specific
repository revision and pinned chain observations. It does not claim that
mutable chain state can never change later.

### Local validation

Validate every committed profile and referenced deployment manifest with:

```bash
pnpm security:profile
```

This performs no RPC calls.

### Live verification

For a configured network:

```bash
pnpm security:check \
  --network <network> \
  --rpc-url "$CHAIN_RPC_URL" \
  --parent-rpc-url "$PARENT_RPC_URL"
```

The exact observation instruments depend on the chain adapter.

For the current Arbitrum Nitro adapter, checks cover deployment identity,
registry lead policy, the live `SequencerInbox`, the Nitro time-variation
envelope, and the approved WASM module root.

### Check statuses

Individual checks use four statuses:

| Status | Meaning |
| --- | --- |
| `MATCH` | A valid observation agrees with committed expected state. |
| `DRIFT` | A valid observation differs from committed expected state. |
| `ERROR` | A valid observation could not be made. |
| `SKIPPED` | A dependent check could not safely run because its prerequisite was not established. |

`SKIPPED` is reserved for dependency skips. If future tooling supports
selection or filtering of checks, unselected checks should be omitted rather
than represented as `SKIPPED`.

A skip should normally appear alongside its causal `DRIFT` or `ERROR`. The
aggregate fold is fail-closed:

```text
any ERROR          → ERROR
otherwise DRIFT    → DRIFT
otherwise SKIPPED  → ERROR
otherwise          → MATCH
empty check set    → ERROR
```

Under the dependency model, `MATCH + SKIPPED` or an all-`SKIPPED` result means a
skip appeared without its causal finding, so the aggregate classifies the
checker state as `ERROR`.

CLI exit codes are based on aggregate status:

```text
MATCH → 0
ERROR → 1
DRIFT → 2
```

`SKIPPED` has no independent process exit code.

### Verification reports

A live verification run can emit a versioned machine-readable report:

```bash
pnpm security:check \
  --network <network> \
  --rpc-url "$CHAIN_RPC_URL" \
  --parent-rpc-url "$PARENT_RPC_URL" \
  --report docs/security/verification/<network>/<report>.json
```

Reports record:

- network and chain ID
- verification timestamp
- repository revision and worktree cleanliness
- pinned chain observations
- expected and observed values
- per-check status
- aggregate status

Large on-chain integers are serialized losslessly as decimal strings.

Reports are evidence, not mutable configuration.

### Sequencer-based L2s

For sequencer-clock L2s, the security analysis distinguishes:

```text
A1 — protocol timestamp validity
A2 — freshness of protocol-valid timestamps
B  — sequencing and history integrity
```

A future-round lead alone does not establish A2 or B. Increasing
`minimumLeadRounds` also does not remove protocol-valid history-selection or
ordering discretion from an authorized sequencer.

The chain profile is the authoritative place for the detailed assumptions and
evidence for a particular network. See the
[Robinhood Testnet profile](docs/security/chain-profiles/robinhood-testnet.md)
for the current Nitro worked example.

## Deployment manifests

Canonical deployment identity lives under:

```text
deployments/
```

For example:

```text
deployments/robinhood-testnet.json
```

A deployment manifest contains durable artifact identity and provenance:

```text
manifest version
network
chain ID

registry
  address
  runtime codehash
  deployment transaction
  deployment block

verifier
  address
  runtime codehash
  deployment transaction
  deployment block
```

Policy deliberately lives elsewhere:

```text
minimumLeadRounds       → chain profile
security assumptions    → chain profile
monitoring thresholds   → chain profile
RPC URLs                → operator configuration
private keys            → operator configuration
```

Registry runtime verification can prove that deployed contracts match a
supplied deployment identity. Separately, the chain-security checker compares
normative profile policy with live configuration. Neither independently proves
that an arbitrary manifest or profile is the trust root an application intended
to use.

## Permissionless multi-chain support

An upstream chain profile is not an allowlist.

Anyone may:

- deploy compatible verifier and registry infrastructure
- run independent relayers
- maintain deployment metadata in a fork
- maintain their own chain-security profile
- use a compatible EVM chain not currently supported upstream

Upstream support means something narrower:

> This repository contains an explicit security model and machine-verifiable
> expectations for that network.

A new chain in an existing adapter family may reuse that adapter. A chain with
materially different consensus, timestamp, or sequencing semantics should add a
corresponding security adapter rather than being forced into an unrelated
model.

The repository currently includes an upstream profile for
[Robinhood Chain Testnet](docs/security/chain-profiles/robinhood-testnet.yaml).
Read the committed profile for its authoritative current policy values.

A chain definition existing in an EVM library does **not** by itself establish
compatibility with the verifier. The target EVM must provide the BLS12-381
execution behavior the verifier requires, and compatibility should be tested on
the target chain.

## Reference relayer

The reference relayer under [`apps/relayer/`](apps/relayer/) supports exact-round
imports, future-round waiting, demand-driven consumer discovery, endpoint
failover, simulation before broadcast, and durable restart/replay behavior.

The daemon watches `QuicknetRandomnessRequested(round)` and services only that
exact round. Only public beacon retrieval is automatically retried; ambiguous
transaction broadcasts are reconciled against chain state before another
transaction is attempted.

See [`apps/relayer/README.md`](apps/relayer/README.md) for commands, custom
network descriptors, finality policy, checkpointing, logging, recovery, and
operator monitoring.

## Repository structure

```text
drand-quicknet-evm/
├── contracts/                 Solidity verifier, registry, consumers, tests
├── packages/
│   ├── drand-quicknet/        Quicknet schedule/fetch/signature utilities
│   └── registry-sdk/          Typed registry SDK and deployment verification
├── apps/relayer/              Reference permissionless relayer
├── deployments/               Canonical deployment identity/provenance
├── docs/security/
│   ├── chain-profiles/        Chain policy and security assumptions
│   └── verification/          Historical machine-generated evidence
├── networks/examples/         Example operator network descriptors
└── scripts/security/          Profile and live-verification tooling
```

The public TypeScript packages are:

- `@based-labs/drand-quicknet` — round/time calculations, beacon fetching,
  endpoint failover, and 48-byte compressed-signature parsing
- `@based-labs/drand-quicknet-registry` — registry ABI, exact-round reads,
  submission, simulation, and trusted runtime verification

The low-level Quicknet package validates response shape; cryptographic beacon
verification remains on-chain.

## Testing

Useful deterministic checks from the repository root include:

```bash
pnpm security:profile
pnpm typecheck
pnpm test
```

The suites cover the verifier's positive/negative behavior, exact-round
registry semantics, consumer lead and seed rules, Quicknet fetching/signature
parsing, SDK deployment checks, relayer import/recovery behavior, chain-profile
validation, Nitro live-check logic, and verification-report aggregation.

Live security checks are intentionally separate from deterministic repository
tests because they require RPC access.

## Production use

This project may ultimately determine outcomes with financial value.

Before production deployment, high-priority work includes:

1. expand the existing cryptographic KAT coverage with a broader independent
   offline corpus and cross-implementation vectors
2. obtain independent security review of verifier, registry, and consumer
   integration
3. explicitly accept or strengthen the production chain's timestamp and
   sequencing security model
4. verify exact production deployment bytecode and policy
5. operate redundant permissionless relayers
6. test restart, downtime, RPC failure, and ambiguous transaction recovery
7. operate monitoring and alerting appropriate to the chain profile
8. rehearse deployment and verification end-to-end

A larger future-round lead is not a substitute for understanding the security
model of the chain on which the commitment is made.

## Contributing

Contributions are welcome, particularly around:

- compatible EVM deployments
- additional chain-security adapters
- consumer integrations
- relayer reliability
- observability
- deployment verification
- cryptographic test vectors
- security review
- consumer discovery

Changes affecting any of the following should be treated as security-sensitive:

- exact-round commitment
- verifier behavior
- randomness normalization
- minimum-lead semantics
- seed derivation
- fallback policy
- chain-security assumptions
