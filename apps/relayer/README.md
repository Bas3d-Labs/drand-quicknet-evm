# drand-quicknet-evm reference relayer

Reference permissionless relayer for `DrandQuicknetBeaconRegistry`.

The relayer is a courier, not a randomness provider.

The relayer transports already-selected public beacons to the registry.
For each exact requested round, it:

1. Authenticates the configured registry deployment.
2. Checks whether the round is already stored.
3. Fetches the exact beacon.
4. Generates a witness and simulates submission, with bounded fallback
   to compressed submission.
5. Broadcasts the successfully simulated request.
6. Confirms a successful receipt and matching registry state.

It never substitutes another round.

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
- generate and validate signature witnesses locally
- retry public beacon retrieval
- resume request scanning from durable checkpoints after restarts

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

The examples assume you have created `network.json` in the repository root
using the custom network descriptor format below. Replace its example
values with trusted deployment and chain configuration for your network.

Build the TypeScript packages first:

```bash
pnpm build:quicknet
pnpm build:registry-sdk
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
  --network-config "$PWD/network.json" \
  --round 31089008
```

If the exact round is already stored, the command succeeds without sending a
duplicate transaction.

### `import-when-available`

Imports an exact round, waiting until its scheduled time if necessary:

```bash
pnpm --filter @based-labs/drand-quicknet-relayer start \
  import-when-available \
  --network-config "$PWD/network.json" \
  --round 31192648
```

Beacon retrieval uses bounded retries. Submission uses the simulation
fallback policy described below; an import attempt does not automatically
rebroadcast after a wallet error or receipt timeout.

### `daemon`

Runs the demand-driven consumer watcher:

```bash
pnpm --filter @based-labs/drand-quicknet-relayer start \
  daemon \
  --network-config "$PWD/network.json"
```

Every command accepts either `--network` for a built-in preset or
`--network-config` for a custom descriptor, never both.

The daemon requires the additional consumer/checkpoint environment variables
described below.

## Configuration

The relayer loads the repository root `.env` through Node when started through
the package script.

The custom-network examples require these environment variables:

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

### Required daemon settings

These settings are required for `daemon`, in addition to the network and
signing configuration. They have no defaults.

```dotenv
QUICKNET_CONSUMERS=0xConsumerA,0xConsumerB
QUICKNET_START_BLOCK=123456
QUICKNET_CHECKPOINT_FILE=.state/quicknet-relayer.json
```

Replace the example consumer placeholders with actual contract addresses.

#### `QUICKNET_CONSUMERS`

Comma-separated list of consumer contracts whose
`QuicknetRandomnessRequested` events the daemon should watch.

Each address must be a valid EVM address. Surrounding whitespace is
trimmed, addresses are normalized, and duplicate addresses are removed.
Empty entries, including a trailing comma, are rejected.

Before scanning, the daemon validates that each configured consumer
points to the registry deployment being serviced.

Only configured consumers are watched. The daemon does not discover
every consumer on the chain automatically.

#### `QUICKNET_START_BLOCK`

First block, inclusive, from which durable request scanning begins for
a consumer that has no saved checkpoint.

Accepts a non-negative decimal integer. `0` starts from genesis, which
can require substantial historical scanning.

Choose a block at or before the earliest request event that must be
processed. For multiple consumers, choose a starting block that covers
the required history of all consumers without checkpoints.

A saved checkpoint takes precedence for its consumer. Changing this
setting does not rewind or skip ahead of existing checkpoints.

When adding a consumer without a saved checkpoint, that consumer starts
from `QUICKNET_START_BLOCK`; existing consumers retain their saved progress.

#### `QUICKNET_CHECKPOINT_FILE`

Path to the JSON file that stores durable scanning progress separately
for each consumer.

Each saved position identifies the next block to reconcile. The file
also records the chain ID and registry address; mismatches with the
configured deployment are rejected.

If the file does not exist, consumers begin without saved checkpoints.
The file and missing parent directories are created when progress is
first saved. The daemon requires filesystem permissions to create its
lock and update checkpoint state.

Relative paths resolve from the relayer process's working directory.
When using the workspace package's `start` script, that directory is
`apps/relayer`, so `.state/quicknet-relayer.json` is stored beneath
`apps/relayer/.state/`.

Use an absolute path when you need an explicit storage location.
For containers, place the checkpoint file on persistent storage.

Preserve this file across normal restarts and deployments. Use a
dedicated checkpoint file for each independent daemon deployment, with
only one process owning a checkpoint lineage at a time.

The checkpoint tracks request-scanning progress. It does not store
pending transactions or provide transaction recovery after an uncertain
broadcast.

### Optional daemon settings

These settings are optional. The following values are used when the
variables are unset:

```dotenv
QUICKNET_MAX_BLOCK_RANGE=2000
QUICKNET_POLL_INTERVAL_MS=1000
QUICKNET_LOG_LEVEL=info
```

#### `QUICKNET_MAX_BLOCK_RANGE`

Default: `2000` blocks.

Maximum number of blocks included in each consumer request-log scan.
The limit applies separately to soft and durable scans for each consumer,
not to the total work performed by a daemon cycle.

For example, a scan starting at block `10000` with a limit of `2000`
can include blocks `10000` through `11999`, inclusive. The range is
shortened when the relevant chain head is closer.

Lower this value if your RPC provider rejects large log queries or they
regularly time out. Larger values can reduce the number of queries needed
to catch up, but increase the work and response size of individual queries.

This setting limits blocks scanned, not the number of events, rounds,
or transactions processed.

Accepts a positive decimal integer.

#### `QUICKNET_POLL_INTERVAL_MS`

Default: `1000` milliseconds.

Delay before starting another daemon cycle when the previous cycle made
no scanning progress.

When at least one consumer successfully processes a soft or durable
block range, the daemon starts the next cycle immediately. Scanning a
range counts as progress even if it contains no request events. This
allows historical catch-up without sleeping between every batch.

A shorter interval reduces idle polling delay but increases RPC traffic.
A longer interval reduces idle RPC traffic but can delay detection of
new requests.

This is not a fixed cycle duration or an end-to-end import latency
guarantee. Scanning, beacon retrieval, and transaction confirmation
take additional time.

Accepts a positive decimal integer no greater than
`Number.MAX_SAFE_INTEGER`.

#### `QUICKNET_LOG_LEVEL`

Default: `info`.

Controls the minimum severity emitted by the daemon's structured logger.
Accepted values, from most verbose to least verbose, are:

- `trace`
- `debug`
- `info`
- `warn`
- `error`
- `fatal`
- `silent`

For example, `info` includes informational events, warnings, and errors.
`debug` also includes routine progress events such as
`checkpoint_advanced` and `round_already_stored`.

`silent` suppresses normal structured log events. Logger-failure
diagnostics may still be written to stderr.

Values are lowercase and case-sensitive. An unrecognized value falls
back to `info` and emits an `invalid_log_level` warning.

This setting changes logging verbosity, not scanning, submission,
or retry behavior. See [Logging](#logging) for event details.

## Network sources

The CLI supports two network sources.

A custom descriptor configures the relayer. It does not establish that the
target chain supports the verifier's required precompiles or satisfies
application timing and finality requirements. Use a compatible deployment
and assess the target chain's security model separately.

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

All commands use the same submission path for an exact round `R`:

1. Verify the configured registry and verifier deployment.
2. If `R` is already stored, return its randomness without fetching a
   beacon or broadcasting a transaction.
3. Fetch the beacon for `R` and check that its returned round matches.
4. Generate a signature witness and select a successfully simulated
   submission path.
5. Broadcast the exact request returned by simulation.
6. Wait for a successful transaction receipt.
7. Read `getBeacon(R)` at the receipt's block and compare the stored
   randomness with the simulation result.

The round and compressed signature remain unchanged when falling back
between submission methods.

For an unstored round, `import-when-available` first waits until `R` is
scheduled and performs bounded fetch retries for that exact round.

Confirmation reads have bounded retries for transient RPC failures.
These reads do not broadcast another transaction.

## Signature handling

Both submission methods use the canonical 48-byte compressed G1 signature
published by drand Quicknet.

`@based-labs/drand-quicknet` checks fetched signature length and hexadecimal
format and returns a branded `CompressedSignature`. Parsing alone does
not establish canonical point encoding or authenticate a beacon.

The relayer normally calls `createSignatureWitness()` to decompress the
signature locally. This validates canonical encoding, rejects infinity,
and checks curve membership and prime-order subgroup membership.

The resulting y-coordinate is split into:

- `yHi`: the upper limb, passed as Solidity `uint128`.
- `yLo`: the lower 256 bits, passed as Solidity `uint256`.

The relayer supplies these limbs alongside the original compressed
signature to `submitBeaconWithWitness`.

Local point validation does not authenticate the signature against a
Quicknet round or public key. Beacon authentication remains the
responsibility of the configured on-chain verifier.

## Simulation and transaction retry

The relayer prefers witness-assisted submission and selects the submission
method before broadcasting.

### Simulation fallback

| Condition | Action | Fallback reason |
| --- | --- | --- |
| Witness generation and simulation succeed | Use `submitBeaconWithWitness` | None |
| Local witness generation throws | Simulate `submitBeacon` once | `witness-decode-failed` |
| Witness simulation returns a decoded `InvalidBeacon` for the configured registry and witness method | Simulate `submitBeacon` once | `witness-rejected` |
| Any other witness simulation error | Fail the attempt | None |

The compressed fallback uses the same round and signature.

Fallback after witness simulation failure requires Viem's decoded contract
error and matching call context, never provider message text. Transport
failures, unrelated contract errors, and errors attributed to another
contract or method do not trigger this fallback.

Local witness-generation failure is a separate fallback trigger and does
not require an RPC error.

If compressed simulation fails, its error propagates without another
simulation attempt. The unsuccessful attempt does not permanently label
the round invalid.

### Broadcasting and confirmation

After successful simulation, the relayer makes one wallet submission call
with the simulated request, then waits for a receipt and verifies stored
randomness at the receipt's block.

Broadcasting is outside the simulation fallback boundary. Wallet errors,
uncertain submission responses, transaction reverts, and receipt timeouts
do not trigger compressed fallback or another broadcast within that
import attempt.

A successful simulation does not guarantee that a later transaction will
succeed.

### Recovery after an uncertain transaction

Durable pending-transaction tracking and reconciliation across attempts,
daemon cycles, and process restarts are not implemented by this submission
flow. A later daemon cycle or command invocation may revisit the round.

Before retrying an uncertain submission, reconcile the signer's pending
transactions and nonce state, and check whether the registry already
stores the round. Another relayer may have imported it in the meantime.

An unstored round alone does not prove that the earlier transaction was
never accepted.

Registry idempotence prevents overwriting stored randomness. Duplicate
broadcasts can still consume gas, conflict on nonces, or stall the
signer's transaction queue.

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

Soft progress is intentionally not persisted. Replaying requests cannot
overwrite stored randomness, but unresolved transactions still require
reconciliation to avoid duplicate broadcasts and nonce conflicts.

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
  --network-config "$PWD/network.json"
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

### Submission reporting

Successful CLI imports include the selected submission method:

```text
Submission: witness
```

A successful compressed fallback includes its reason:

```text
Submission: compressed
Fallback reason: witness-rejected
```

The other possible fallback reason is `witness-decode-failed`.

Successful daemon imports report the same information on `round_imported`:

- `submission`: `witness` or `compressed`.
- `fallbackReason`: present for compressed fallback and omitted from
  serialized JSON for witness submission.

Already-stored results do not report a submission method because no
transaction was sent.

Submission metadata is attached to successful import results. An attempt
that fails after selecting fallback is reported through the existing
failure path; it does not produce a successful `round_imported` event.

There is no separate witness-fallback log event.

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
- successful compressed fallback frequency, grouped by fallback reason
- uncertain submissions and pending signer transactions

For chain profiles that rely on sequencer timestamp freshness, the configured
skew warning may intentionally sit close to normal timestamp truncation plus
network propagation. Warning-tier noise can therefore be a consequence of a
sensitive canary rather than evidence that the chain has crossed its violation
boundary.

The chain profile's thresholds are authoritative. Do not duplicate them in
relayer configuration or operator documentation.

## Multiple relayers

Multiple independent relayers improve availability. The registry does not
require leader election to accept beacon submissions.

Use a separate signing account and checkpoint file for each independent
relayer.

If multiple relayers submit the same round, the first successful import
populates the cache. Later successful submissions return the cached value
without overwriting it or emitting another `BeaconStored` event.

Duplicate transactions may still consume gas.

Processes sharing a signing account must coordinate transaction nonces.
Checkpoint ownership and signer ownership are separate concerns: separate
checkpoint files do not prevent signer conflicts.

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
- witness generation and witness-assisted submission
- compressed fallback after local witness-generation failure
- compressed fallback after a matching decoded `InvalidBeacon`
- rejection of unrelated errors as fallback triggers
- exact calldata through the real SDK and a simulated RPC transport
- no additional submission within an attempt after uncertain wallet
  errors or receipt timeouts
- receipt-block storage verification
- submission method and fallback-reason reporting
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
