# drand-quicknet-evm

Permissionless drand Quicknet randomness infrastructure for EVM chains.

`drand-quicknet-evm` provides Solidity contracts, TypeScript libraries, reference
relayer tooling, and chain-security verification tooling for making
[drand Quicknet](https://drand.love/) randomness available to EVM applications.

The core model is:

```text
drand Quicknet
      ↓
Quicknet verifier
      ↓
DrandQuicknetBeaconRegistry
      ↓
DrandQuicknetRandomnessConsumer
      ↓
applications
```

Applications commit to an **exact future Quicknet round before that round becomes
knowable**.

Anyone may then submit the corresponding drand beacon to the shared registry.

Relayers are permissionless couriers. They do not choose randomness, select
fallback rounds, or control application settlement.

## Why?

Many EVM applications need publicly verifiable randomness but cannot rely on a
chain-specific VRF deployment or dedicated fulfillment service.

drand provides a distributed randomness beacon with a deterministic publication
schedule. Quicknet publishes a new beacon every approximately 3 seconds.

This project provides the EVM-side infrastructure needed to use those beacons:

- verify drand Quicknet signatures on-chain
- normalize valid beacons to canonical randomness
- cache verified randomness by exact Quicknet round
- let any account submit valid beacons
- commit applications to future rounds before they become knowable
- derive application-specific random seeds safely
- fetch and submit beacons with a reference TypeScript relayer
- relay only rounds actually requested by consumers
- characterize chain-specific timing and sequencing assumptions
- verify deployed infrastructure against committed expectations

## Core security rule

The most important rule is:

> **A consumer commits to an exact future Quicknet round before that round
> becomes knowable, and settlement uses only that exact round.**

A consumer must never choose its randomness based on which beacons happen to be
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

## Architecture

```text
                         drand Quicknet
                              │
                              │ beacon R
                              ▼
                       Quicknet verifier
                    BLS12-381 verification
                              │
                              │ canonical randomness
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

### Verifier

The verifier performs the cryptographic verification required to establish that
a submitted beacon is valid drand Quicknet output.

It is deployed separately from the registry.

The registry pins the verifier identity so that an existing deployment cannot
silently begin trusting a different cryptographic implementation.

### Registry

`DrandQuicknetBeaconRegistry` is a permissionless cache of verified Quicknet
randomness:

```solidity
round => randomness
```

Important properties:

- submissions are permissionless
- every new beacon is cryptographically verified
- each exact round maps to one canonical value
- previously stored rounds are idempotent
- no owner chooses randomness
- no relayer allowlist is required
- no "latest randomness" settlement mechanism exists
- reads are exact-round only

Strict reads use:

```solidity
getBeacon(round)
```

Availability can be checked with:

```solidity
isStored(round)
```

The registry also exposes Quicknet schedule helpers and its configured minimum
consumer lead.

### Consumer base

`DrandQuicknetRandomnessConsumer` provides the canonical application-facing
integration.

It:

- pins the registry address
- attests the registry runtime code at deployment
- requires a configured future-round lead
- requires that lead to be at least the registry's `minimumLeadRounds`
- derives the requested round from the commitment transaction's inclusion time
- emits `QuicknetRandomnessRequested(round)`
- can persist request ID → exact round relationships
- reads only the persisted exact round
- derives domain-separated application seeds

The target round is fixed at commitment inclusion.

A delayed transaction therefore selects a correspondingly later future round;
the consumer does not depend on when the transaction first entered a mempool.

## Domain separation

Applications should derive their own seed from the verified beacon rather than
using the registry value directly for every purpose.

The reference consumer derives seeds using inputs including:

```text
application domain
unique request ID
consumer address
chain ID
exact Quicknet round
verified beacon randomness
```

This allows many applications and many requests to consume the same Quicknet
beacon without sharing application-level outcomes.

`uniqueRequestId` must uniquely identify the application request.

## Relayer trust

Relayers are not trusted randomness providers.

The registry verifies every submitted beacon on-chain.

A malicious relayer may delay or refuse to submit a beacon, but it cannot
construct an alternative valid randomness value for the committed round.

```text
Relayer A ──┐
Relayer B ──┼──> submitBeacon(R, signature)
Relayer C ──┘
```

Whichever relayer successfully submits the exact beacon first populates the same
canonical registry value.

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

The appropriate number of future rounds is **chain dependent**.

It must not be copied blindly from another network.

## Minimum lead rounds

A registry exposes:

```solidity
minimumLeadRounds()
```

Consumers using `DrandQuicknetRandomnessConsumer` must configure:

```text
quicknetLeadRounds >= minimumLeadRounds
```

For a 3-second Quicknet period, a lead of `L` rounds gives a mechanical
chain-clock separation of:

```text
3L - 2 through 3L seconds
```

For example:

```text
L = 3  →  7–9 seconds
L = 5  → 13–15 seconds
```

This is only the mechanical timing relationship to the chain clock.

Whether that chain clock itself is sufficiently trustworthy depends on the
security model of the chain.

## Chain security profiles

The contracts are designed to be EVM-chain-agnostic, but different EVM chains
have different timestamp, sequencing, consensus, and parent-chain semantics.

Chain profiles document and verify those network-specific assumptions.

A profile answers questions such as:

- which chain is being used?
- who or what controls `block.timestamp`?
- what history-selection or sequencing assumptions exist?
- what minimum Quicknet lead should consumers use?
- what parent-chain configuration is expected?
- which verifier and registry deployment should be present?
- which live chain values should match committed expectations?

Profiles live under:

```text
docs/security/chain-profiles/
```

For example:

```text
docs/security/chain-profiles/
  robinhood-testnet.yaml
  robinhood-testnet.md
```

The YAML is the normative machine-readable configuration.

The Markdown document explains the corresponding security assumptions.

### Profiles are not an allowlist

A chain does **not** need an upstream profile in this repository in order to use
`drand-quicknet-evm`.

Anyone may deploy the verifier, registry, relayer, and consumers on a compatible
EVM chain.

A profile instead means:

> This repository contains an explicit security model and machine-verifiable
> expectations for this particular network.

Operators may maintain their own profiles and deployment manifests in a fork
without requiring approval from Based Labs.

## Chain-profile tiers

Profiles use onboarding tiers to distinguish configured networks from networks
that have also undergone live verification.

Conceptually:

```text
Tier 1
  configured and locally validated
        ↓
live verification succeeds
        ↓
machine-generated evidence
        ↓
Tier 2
  live expectations verified at pinned chain snapshots
```

A Tier-2 report is historical evidence for a particular repository revision and
particular chain snapshots.

It does not prove that mutable chain state can never change later.

## Security verification tooling

Local profile validation is available with:

```bash
pnpm security:profile
```

This validates committed configuration without requiring RPC access.

Security tooling can also verify live deployments:

```bash
pnpm security:check \
  --network robinhood-testnet \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL" \
  --parent-rpc-url "$ETHEREUM_SEPOLIA_RPC_URL"
```

For the current Robinhood Testnet Nitro profile, the live verifier checks:

```text
L2
├── registry runtime codehash
├── verifier runtime codehash
└── registry minimumLeadRounds

parent chain
├── Rollup.sequencerInbox()
├── SequencerInbox.maxTimeVariation()
└── Rollup.wasmModuleRoot()
```

The parent-chain checks use one shared pinned parent snapshot.

Results are classified as:

```text
MATCH
DRIFT
ERROR
SKIPPED
```

Aggregate CLI exit behavior is:

```text
MATCH → 0
ERROR → 1
DRIFT → 2
```

### Machine-generated verification reports

A successful verification run can emit a versioned evidence record:

```bash
pnpm security:check \
  --network robinhood-testnet \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL" \
  --parent-rpc-url "$ETHEREUM_SEPOLIA_RPC_URL" \
  --report docs/security/verification/robinhood-testnet/<report>.json
```

Reports record:

- report schema version
- network and chain ID
- verification timestamp
- repository revision
- worktree cleanliness
- pinned chain observations
- expected values
- observed values
- per-check status
- aggregate status

Large on-chain integers are serialized losslessly as decimal strings.

Committed reports live under:

```text
docs/security/verification/
```

They are evidence, not mutable configuration.

## Sequencer-based L2 assumptions

For sequencer-based L2s, a future-round lead by itself does not establish every
security property needed by a commitment scheme.

The security analysis distinguishes between:

```text
A1 — protocol timestamp validity

A2 — freshness of protocol-valid timestamps

B  — sequencing and history integrity
```

A chain may permit timestamps that are protocol-valid but much older than the
application's desired freshness bound.

Similarly, increasing `minimumLeadRounds` does not eliminate the possibility
that an authorized sequencer has discretion over ordering or history selection.

Profiles make these assumptions explicit rather than hiding them behind a single
"lead time" number.

A stronger future deployment model may instead anchor the commitment on a parent
chain before the target drand round becomes knowable.

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
│
├── docs/
│   └── security/
│       ├── chain-profiles/
│       └── verification/
│
├── scripts/
│   └── security/
│       ├── core/
│       └── adapters/
│
├── package.json
├── README.md
└── ...
```

## TypeScript packages

### `@based-labs/drand-quicknet`

Low-level Quicknet tooling.

It provides functionality including:

- Quicknet schedule constants
- round calculations
- compressed-signature parsing
- Quicknet HTTP fetching
- multi-endpoint failover
- BLS signature decompression
- typed compressed and uncompressed signatures

The reference relayer normally fetches drand's compressed signature and
decompresses it locally before submission.

### `@based-labs/drand-quicknet-registry`

TypeScript SDK for interacting with registry deployments.

It provides functionality including:

- registry ABI
- deployment metadata types
- runtime deployment verification
- registry reads
- submission simulation
- beacon submission

Runtime verification can establish that the configured deployment matches the
identity recorded in the deployment manifest.

It does not independently establish that the manifest itself is the deployment
an application intended to trust.

## Deployment manifests

Deployment manifests live under:

```text
deployments/
```

For example:

```text
deployments/robinhood-testnet.json
```

A manifest intentionally contains only durable deployment identity and
provenance, such as:

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

Policy belongs elsewhere.

For example:

```text
minimumLeadRounds       → chain profile
RPC URLs                → operator configuration
private keys            → operator configuration
security assumptions    → chain profile + documentation
```

This separation avoids conflating immutable deployment facts with mutable
network policy or operator-specific configuration.

## Reference relayer

The reference relayer lives in:

```text
apps/relayer
```

It supports exact-round one-shot imports, future-round imports, and a
long-running demand-driven daemon.

### Exact round

```bash
pnpm --filter @based-labs/drand-quicknet-relayer start \
  import \
  --network robinhood-testnet \
  --round 31089008
```

If the round is already stored, the command succeeds without sending a duplicate
transaction.

### Future round

```bash
pnpm --filter @based-labs/drand-quicknet-relayer start \
  import-when-available \
  --network robinhood-testnet \
  --round 31192648
```

The relayer:

```text
waits for exact R
      ↓
fetches exact R
      ↓
simulates exact R
      ↓
submits exact R
```

It never changes the requested round.

### Demand-driven daemon

```bash
pnpm --filter @based-labs/drand-quicknet-relayer start \
  daemon \
  --network robinhood-testnet
```

The daemon watches configured consumers for:

```solidity
QuicknetRandomnessRequested(uint64 indexed round)
```

The event means:

> Ensure exact Quicknet round `R` is available in this consumer's configured
> registry.

It does not authorize the relayer to:

- choose another round
- select an application outcome
- settle the application
- change application state
- choose odds
- issue refunds

## Consumer request standard

The minimal demand signal is:

```solidity
interface IDrandQuicknetRandomnessConsumer {
    event QuicknetRandomnessRequested(
        uint64 indexed round
    );

    function quicknetBeaconRegistry()
        external
        view
        returns (address);
}
```

A consumer emits the event only after committing to exact round `R`.

The reference daemon currently watches a configured set of consumers.

Future discovery mechanisms may supply consumer addresses dynamically without
changing the on-chain event standard.

## Demand-driven daemon internals

The daemon maintains both low-latency and durable scanning paths.

```text
latest head
    ↓
soft scan
    ↓
low-latency request detection
    ↓
memory-only cursor
```

and:

```text
durable head
    ↓
durable scan
    ↓
request reconciliation
    ↓
persisted checkpoint
```

Soft progress is replayable.

Durable progress is persisted.

A useful operational summary is:

> `latest` is safe enough to act on, but not safe enough to forget.

### Durable-head regression

An RPC provider may temporarily report a durable head behind already-persisted
progress.

The daemon never moves its durable checkpoint backward.

Instead it:

- preserves the checkpoint
- skips durable scanning for that cycle
- continues soft/latest processing
- emits `durable_head_regressed`
- resumes durable scanning once the durable head catches up

## Relayer configuration

Relayer RPC and signing configuration is operator-specific.

For example:

```dotenv
ROBINHOOD_TESTNET_RPC_URL=https://...
PRIVATE_KEY=0x...
```

Use a dedicated low-value relayer account with only enough native currency to
pay transaction fees.

Do not give the relayer account:

- application administration privileges
- treasury access
- upgrade authority
- custody privileges

Never commit `.env` files or private keys.

## Current upstream network support

The repository currently contains an upstream security profile and deployment
configuration for:

```text
Robinhood Chain Testnet
```

Its current profile uses:

```text
Quicknet period:       3 seconds
minimumLeadRounds:     3
chain-clock lead:      7–9 seconds
```

See the committed profile and deployment manifest for the authoritative current
configuration.

Additional compatible EVM chains can be used without waiting for upstream
support.

A new chain in the same adapter family may reuse the existing verification
logic.

A chain with materially different consensus, timestamp, or sequencing semantics
should introduce an appropriate new security adapter rather than pretending to
be a supported chain family.

## Permissionless multi-chain model

The project intentionally distinguishes between:

```text
protocol capability
```

and:

```text
which deployments a particular operator chooses to service
```

Anyone may:

- deploy compatible infrastructure
- run a relayer
- maintain their own deployment manifest
- maintain their own chain profile
- operate against chains not included in the upstream repository

Operator configuration is an operational policy, not an on-chain allowlist.

## Testing

Run the security tooling:

```bash
pnpm security:profile
pnpm typecheck:security
pnpm test:security
```

Build and test Solidity contracts:

```bash
cd contracts
forge build
forge test
```

Run relayer tests:

```bash
pnpm run relayer:test
```

Run relayer typechecking:

```bash
pnpm run relayer:typecheck
```

Build the relayer:

```bash
pnpm run relayer:build
```

Test coverage includes areas such as:

- Quicknet HTTP parsing and endpoint failover
- signature decompression
- known Quicknet vectors
- registry SDK reads and writes
- deployment manifest validation
- deployment runtime verification
- exact-round import
- future-round waiting
- bounded beacon-fetch retries
- permissionless relayer races
- already-stored idempotency
- consumer validation
- demand-driven request scanning
- soft/latest and durable scanning
- checkpoint persistence and locking
- restart/replay behavior
- per-consumer failure isolation
- durable-head regression handling
- chain-profile validation
- Nitro timestamp-envelope verification
- Nitro consensus-root verification
- machine verification reports
- aggregate live verification orchestration

## Known-vector testing

The repository contains known Quicknet-vector coverage used to verify
compatibility across components.

A dedicated production cryptographic KAT suite is a separate security-hardening
milestone and should provide deterministic, offline known-answer coverage of the
exact verifier path before production use.

## Operational guidance

Relayer operators should:

- use a dedicated low-value signing account
- verify deployment identity before servicing it
- use independent RPC infrastructure where practical
- use multiple drand endpoints
- fetch only requested exact rounds
- decompress signatures locally where appropriate
- simulate submissions before broadcasting
- treat already-stored rounds as success
- avoid blindly retrying ambiguous broadcasts
- expect independent relayers to race
- preserve durable checkpoints across restarts
- never move durable checkpoints backward
- monitor relayer lag, RPC health, and drand availability

For sequencer-clock chains, operators should also monitor the chain-specific
timestamp-freshness assumptions documented by the corresponding profile.

## Liveness vs randomness selection

Liveness policy must remain separate from randomness selection.

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

A delayed exact beacon preserves the committed randomness source.

Choosing a replacement based on availability can introduce bias.

## Production use

This project may ultimately determine outcomes with financial value.

Before production deployment, high-priority work includes:

1. deterministic cryptographic known-answer testing
2. independent review/audit of verifier, registry, and consumer logic
3. explicit acceptance of the production chain's timing and sequencing model
4. deployment and bytecode verification
5. redundant relayer operation
6. relayer restart and failure-recovery testing
7. monitoring and alerting
8. production deployment rehearsal

Chain-specific lead configuration must not be treated as a substitute for
understanding the chain's sequencing and timestamp security model.

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