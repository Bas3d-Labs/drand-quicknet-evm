# drand-quicknet-evm reference relayer

Reference permissionless relayer for `DrandQuicknetBeaconRegistry`.

The relayer is a courier, not a randomness provider.

Its job is:

```text
exact requested round R
        ↓
fetch canonical drand beacon R
        ↓
simulate registry submission
        ↓
submit R
        ↓
confirm registry state
```

It never selects another round because that round is easier or faster to
obtain.

## Contents

- [Trust boundary](#trust-boundary)
- [Commands](#commands)
- [Configuration](#configuration)
- [Network sources](#network-sources)
- [Exact-round processing](#exact-round-processing)
- [Signature handling](#signature-handling)
- [Simulation and transaction retry](#simulation-and-transaction-retry)
- [Demand-driven daemon](#demand-driven-daemon)
- [Soft and durable scanning](#soft-and-durable-scanning)
- [Checkpoints](#checkpoints)
- [Durable-head regression](#durable-head-regression)
- [Consumer failure isolation](#consumer-failure-isolation)
- [Logging](#logging)
- [Monitoring](#monitoring)
- [Multiple relayers](#multiple-relayers)
- [Docker](#docker)
- [Testing](#testing)
- [Operational assumptions](#operational-assumptions)

## Trust boundary

A relayer may:

- observe consumer request events
- fetch public drand Quicknet data
- validate the expected response shape
- simulate registry submissions
- submit canonical signatures for exact requested rounds
- retry public beacon retrieval
- recover from process restarts

A relayer is **not** authorized to:

- choose another round
- choose application outcomes
- settle applications
- modify odds
- alter committed application state
- issue refunds
- bypass registry verification

Application security must not depend on a particular relayer being honest.
Multiple relayers may independently service the same request.

## Commands

Build the relayer first:

```bash
pnpm build:relayer
```

The app is started from the repository root with:

```text
pnpm --filter @based-labs/drand-quicknet-relayer start <command> ...
```

### `import`

Attempts to import an exact round immediately:

```bash
pnpm --filter @based-labs/drand-quicknet-relayer start \
  import \
  --network-config networks/examples/robinhood-testnet-custom.json \
  --round 31089008
```

If the exact round is already stored, the command succeeds without sending a
duplicate transaction.

### `import-when-available`

Waits for a future exact round and then imports that same round:

```bash
pnpm --filter @based-labs/drand-quicknet-relayer start \
  import-when-available \
  --network-config networks/examples/robinhood-testnet-custom.json \
  --round 31192648
```

Only the public drand-fetch stage is retried automatically.

### `daemon`

Runs the demand-driven consumer watcher:

```bash
pnpm --filter @based-labs/drand-quicknet-relayer start \
  daemon \
  --network-config networks/examples/robinhood-testnet-custom.json
```

The daemon requires the additional consumer/checkpoint environment variables
described below.

### Custom network source

Every command also accepts a custom network descriptor instead of a built-in
preset:

```bash
pnpm --filter @based-labs/drand-quicknet-relayer start \
  daemon \
  --network-config networks/examples/robinhood-testnet-custom.json
```

Use either `--network` or `--network-config`, never both.

## Configuration

The relayer loads the repository root `.env` through Node when started through
the package script.

The runnable example in this README uses a custom network descriptor:

```dotenv
PRIVATE_KEY=0x...
QUICKNET_RPC_URL=https://...
```

Use a dedicated low-value signing account containing only enough native
currency to pay transaction fees.

Do not give the relayer account:

- application administration privileges
- treasury access
- upgrade authority
- custody authority

Never commit private keys or populated `.env` files.

### Daemon variables

The daemon additionally requires:

```dotenv
QUICKNET_CONSUMERS=0xConsumerA,0xConsumerB
QUICKNET_START_BLOCK=123456
QUICKNET_CHECKPOINT_FILE=.state/quicknet-relayer.json
```

Optional daemon settings:

```dotenv
QUICKNET_MAX_BLOCK_RANGE=2000
QUICKNET_POLL_INTERVAL_MS=1000
QUICKNET_LOG_LEVEL=info
```

`QUICKNET_CONSUMERS` is a comma-separated set of consumer addresses. Duplicate
addresses are normalized away.

`QUICKNET_START_BLOCK` is the first block whose consumer request history the
daemon should reconcile when no durable checkpoint exists.

`QUICKNET_CHECKPOINT_FILE` identifies the durable checkpoint lineage for this
daemon process.

## Network sources

The CLI supports two network sources.

### Built-in presets

The CLI supports built-in presets through `--network`. A preset supplies chain
identity, an RPC environment-variable name, trusted deployment identity, and
a finality policy.

### Custom network descriptor

Custom network descriptors are JSON files with the shape accepted by
`CustomNetworkDescriptor`:

```json
{
  "version": 1,
  "name": "example-network",
  "chain": {
    "id": 12345,
    "name": "Example Network",
    "nativeCurrency": {
      "name": "Ether",
      "symbol": "ETH",
      "decimals": 18
    },
    "testnet": true
  },
  "verifier": {
    "address": "0x...",
    "runtimeCodehash": "0x..."
  },
  "registry": {
    "address": "0x...",
    "runtimeCodehash": "0x..."
  },
  "finality": {
    "type": "safe"
  }
}
```

Custom descriptors carry the deployment identity the relayer needs to
authenticate before servicing a registry. Chain policy such as the expected
`minimumLeadRounds` remains in the chain-security profile and is not duplicated
in relayer configuration.

An upstream chain-security profile is a separate artifact: it documents the
network security model and normative infrastructure policy. See the root
[`README.md`](../../README.md) for the distinction between chain profiles,
deployment manifests, and operator configuration.

## Exact-round processing

For an exact round `R`, the one-shot path is:

```text
verify configured deployment
        ↓
is R already stored?
   ┌────┴────┐
  yes        no
   │          ↓
 success   fetch R
              ↓
        simulate submitBeacon(R)
              ↓
            submit R
              ↓
         wait for receipt
              ↓
         verify registry state
```

The round is never changed during this process.

For `import-when-available`, the relayer first waits until `R` is scheduled and
then performs bounded fetch retries for exact round `R`.

## Signature handling

The current verifier accepts only the canonical 48-byte compressed G1
signature published by drand Quicknet.

`@based-labs/drand-quicknet` validates fetched signatures as 48-byte hexadecimal
data and returns a branded `CompressedSignature`.

The relayer submits that compressed signature directly to the registry. It does
not decompress the signature off-chain.

Cryptographic correctness is enforced on-chain by
`DrandQuicknetBeaconVerifier`; the relayer's parsing is input-shape validation,
not a substitute for BLS verification.

## Simulation and transaction retry

The relayer simulates a registry submission before broadcasting it.

This helps avoid spending gas on a transaction already known to revert, but it
does not make post-broadcast transaction state unambiguous.

Do not blindly retry a transaction after an ambiguous broadcast result.

If a broadcast times out or the RPC response is uncertain, first determine
whether the transaction was accepted or the beacon is already stored. Another
permissionless relayer may also have imported the round while recovery was in
progress.

Always re-check chain state before broadcasting another transaction.

## Demand-driven daemon

The daemon watches configured consumers for:

```solidity
QuicknetRandomnessRequested(uint64 indexed round)
```

The event means:

> Ensure exact Quicknet round `R` is available in this consumer's configured
> beacon registry.

The daemon does not continuously import every Quicknet round.

Its high-level flow is:

```text
configured consumer
       ↓
QuicknetRandomnessRequested(R)
       ↓
deduplicate R
       ↓
registry already stores R?
   ┌─────────┴─────────┐
  yes                  no
   │                    ↓
 done          import when available
```

Before processing a configured consumer, the relayer validates that the
consumer points at the registry deployment the relayer is servicing.

## Soft and durable scanning

The daemon separates low-latency observation from durable progress.

### Soft scan

```text
latest head
    ↓
soft scan
    ↓
low-latency request detection
    ↓
memory-only cursor
```

Soft progress is intentionally not persisted. It is safe to replay because
request processing and registry storage are idempotent.

### Durable scan

```text
durable head
    ↓
durable scan
    ↓
request reconciliation
    ↓
persisted checkpoint
```

The durable checkpoint means every relevant block before `durableNextBlock`
has been reconciled under the configured finality policy.

A useful summary is:

> `latest` is safe enough to act on, but not safe enough to forget.

A restart may replay the non-durable region.

### Finality policies

The relayer supports:

```ts
type FinalityPolicy =
  | {
      type: 'safe';
    }
  | {
      type: 'finalized';
    }
  | {
      type: 'confirmations';
      confirmations: bigint;
    };
```

The finality policy is part of supported network configuration, not an
application fairness guarantee.

Relayer checkpoint finality and application commitment finality are separate
concerns. Acting on a request observed at `latest` can be harmless for the
relayer even when the application requires a stronger commitment-finality
condition before its target beacon becomes knowable.

## Checkpoints

Use a dedicated checkpoint file for each daemon deployment.

Only one daemon process should own a checkpoint lineage at a time. The daemon
uses a checkpoint lock to prevent concurrent processes from accidentally
sharing the same local lineage.

Checkpoint state should be preserved across normal restarts and deployments.

The important invariants are:

```text
soft progress     → replayable

durable progress → persisted and monotonic
```

Older or non-durable history may be replayed. Reprocessing an already-stored
round must remain harmless.

## Durable-head regression

An RPC provider may temporarily report a durable head behind the daemon's
already-persisted durable progress.

The daemon never moves its checkpoint backward.

When this occurs it:

- preserves the persisted durable checkpoint
- skips durable scanning for that cycle
- continues soft/latest processing
- emits `durable_head_regressed`
- resumes durable processing once the durable head catches up

This is treated as an RPC/finality observation rather than a consumer-processing
failure.

## Consumer failure isolation

A failure while processing one configured consumer must not prevent unrelated
consumers from continuing to make progress.

Consumer-specific failures are logged as `consumer_failed`; other consumers in
the same daemon cycle continue independently.

## Logging

The default log level is:

```text
info
```

Enable debug logging with:

```bash
QUICKNET_LOG_LEVEL=debug \
pnpm --filter @based-labs/drand-quicknet-relayer start \
  daemon \
  --network-config networks/examples/robinhood-testnet-custom.json
```

Important structured events include:

```text
round_imported
durable_head_regressed
consumer_failed
heartbeat
checkpoint_advanced
round_already_stored
logging_failed
```

`checkpoint_advanced` and `round_already_stored` are debug-level routine
progress. `heartbeat` is emitted periodically at info level.

Logging failures are isolated so logging itself does not stop the daemon.

## Monitoring

At minimum, operators should monitor:

- daemon process and heartbeat health
- relayer account balance
- requested-round import latency
- requests that remain unprocessed
- repeated beacon-fetch failures
- RPC availability
- drand endpoint availability
- transaction failures
- `consumer_failed`
- `durable_head_regressed`
- distance between `latest` and the durable head
- distance between the durable head and the durable checkpoint

For chain profiles that rely on sequencer timestamp freshness, the configured
skew warning may intentionally sit close to normal timestamp truncation plus
network propagation. Warning-tier noise can therefore be a consequence of a
sensitive canary rather than evidence that the chain has crossed its violation
boundary.

The chain profile's thresholds are authoritative. Do not duplicate them in
relayer configuration or operator documentation.

## Multiple relayers

Running more than one independent relayer is encouraged for liveness.

Relayers do not require leader election or coordination:

```text
relayer A ──┐
            ├──► same permissionless registry
relayer B ──┤
            │
relayer C ──┘
```

If two relayers observe the same request, both may fetch and simulate the same
beacon. Once one stores it, the others converge on the already-stored result.

Each relayer process should maintain its own checkpoint state. Do not share a
checkpoint file between independent operators.

## Docker

Build from the repository root:

```bash
docker build \
  -f apps/relayer/Dockerfile \
  -t drand-quicknet-relayer .
```

Supply operator configuration through environment variables or your deployment
platform's secret-management mechanism. Do not bake private keys into images.

The process handles `SIGINT` and `SIGTERM` through an abort signal so normal
container shutdown can stop the daemon cleanly.

## Testing

Run the relayer test suite:

```bash
pnpm test:relayer
```

Run relayer typechecking:

```bash
pnpm typecheck:relayer
```

Build:

```bash
pnpm build:relayer
```

Coverage includes:

- configuration and CLI parsing
- custom network descriptors
- Quicknet HTTP parsing and endpoint failover
- compressed-signature handling
- registry deployment verification
- exact-round imports
- future-round waiting
- bounded beacon-fetch retries
- already-stored behavior
- permissionless relayer races
- consumer validation
- demand-driven scanning
- soft/durable reconciliation
- finality policies
- checkpoint locking and persistence
- restart/replay behavior
- consumer failure isolation
- durable-head regression handling
- structured logging and heartbeat behavior

## Operational assumptions

The relayer solves a liveness problem: get the already-selected public beacon
onto the destination chain.

It does not solve the consumer's fairness problem by itself.

Consumer protocols must independently guarantee that:

- all outcome-sensitive inputs are committed before randomness is knowable
- the exact target round is fixed in advance
- settlement cannot substitute another round
- failure recovery cannot create a reroll
- refunds or termination rules cannot be selectively abused

The relayer should remain a narrow infrastructure component whose expected
failure mode is delayed settlement rather than biased randomness.
