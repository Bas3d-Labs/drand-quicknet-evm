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
- [Service ownership](#service-ownership)
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

The package `start` script requires the repository root `.env` and loads
it through Node. A missing file stops startup.

The `start:container` script uses the existing environment without
automatically loading a file. It can also be used outside containers.

The launcher reads `QUICKNET_STATE_DIR` before Node loads application
configuration. Set it in the launching environment, service definition,
or container environment. Setting it only in the application's `.env`
does not select the directory that the launcher locks.

Existing environment variables take precedence over the application
env file. The launcher exports the canonical state-directory path so
application configuration cannot select a different directory afterward.

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
QUICKNET_CHECKPOINT_FILE=./state/checkpoint.json
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

The checkpoint must be a direct child of the canonical
`QUICKNET_STATE_DIR`. Nested directories and paths outside that directory
are rejected. The filename `relayer.flock` is reserved.

An existing checkpoint must be a regular file with one hard link.
Checkpoint symlinks and hard-link aliases are rejected. The state
directory itself may be configured through a symlink; the relayer
resolves its canonical location.

A new checkpoint need not exist yet. Consumers without saved progress
start from `QUICKNET_START_BLOCK`.

Relative paths resolve from the relayer process's working directory.
For workspace package scripts, that directory is `apps/relayer`.
The default state directory is therefore `apps/relayer/state`.

Use absolute paths for an explicit storage location. For example,
launch with `QUICKNET_STATE_DIR=/srv/quicknet/robinhood-mainnet` and
configure:

    QUICKNET_CHECKPOINT_FILE=/srv/quicknet/robinhood-mainnet/checkpoint.json

Preserve the checkpoint across normal restarts and deployments.

The checkpoint records request-scanning progress. It does not record
pending transactions or provide recovery after an uncertain broadcast.

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

Delay after each completed daemon cycle before starting the next one.
Shutdown interrupts this delay.

This is not a fixed cycle duration or an end-to-end import latency
guarantee. Scanning, beacon retrieval, and transaction confirmation
take additional time.

A shorter interval improves responsiveness and catch-up throughput
but increases RPC traffic. A longer interval reduces cycle frequency
but can delay discovery of new requests and historical catch-up.

This setting controls cycle frequency, not individual RPC calls.
One cycle can make multiple calls and process multiple rounds.

Accepts a positive decimal integer.

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

### Durable-head polling

The daemon refreshes the `safe` or `finalized` head on the first
successful read and then reuses it for up to 30 seconds, measured
from the start of that refresh. The interval is currently an internal
constant, not an environment setting.

One reader is shared across consumers and cycles within each daemon.
Latest-head reads continue on each consumer iteration, subject to
the RPC client's existing caching.

Durable-head advancement and regression detection can be delayed
by the refresh interval plus scheduling and RPC time. Heartbeats
report the cached durable head between refreshes.

An expired refresh failure is propagated rather than served from
stale data. A latest-head read failure or a cached durable head ahead
of the latest head invalidates the cache.

Confirmation-based finality continues using the existing uncached
head-reading path.

## Service ownership

Protected commands require Linux and util-linux `flock`:

- `import`
- `import-when-available`
- `daemon`

Use the package scripts or installed `relayer` executable. They enter
through `scripts/relayer.sh`, which acquires an exclusive, nonblocking
lock on:

    QUICKNET_STATE_DIR/relayer.flock

The default state directory is `./state` when `QUICKNET_STATE_DIR` is
unset. An explicitly empty value is invalid.

The launcher creates a missing directory and canonicalizes its path.
Check configured paths carefully: a typo can create a new state
directory with no existing checkpoint.

The launcher uses `umask 077`. Newly created state directories and lock
files normally have permissions `0700` and `0600`. Existing permissions
are not repaired automatically.

The application verifies the inherited descriptor against the lock
file's device and inode and checks for an exclusive whole-file flock.
An existing lock file, or a lock owned by another process, is not enough.

Direct execution of `dist/bootstrap.js` does not acquire ownership.
Protected commands refuse execution unless the required lock is
already inherited.

### Scope

All commands using the same signer on the same chain must use the same
state directory and underlying lock file. Stop the daemon before running
a manual import with that signer; otherwise the manual command exits
with contention.

This is a filesystem service lock, not a global signer registry.
Different state directories, independent container volumes, or separate
hosts can bypass coordination even when they use the same textual path.

Do not run the same signer through another wallet, keeper, or relayer
outside this coordination boundary.

Independent relayers should use separate signing accounts and state
directories.

### Filesystem requirements

Use persistent local storage with working flock semantics and trusted,
stable parent directories.

The verifier rejects a world-writable immediate state directory.
The lock file must be a regular file with one hard link; symlinks and
hard-linked lock files are rejected.

These checks do not validate every ancestor's ownership, permissions,
ACLs, or filesystem behavior. Restrict access to the state directory
and its ancestors to trusted operators.

Never remove, replace, or rotate `relayer.flock` while a writer may be
running. Replacing the path can let separate processes lock different
inodes and run concurrently.

The lock file remains present after shutdown. Its presence does not
mean that ownership is still held.

### Help

No arguments, a leading `help`, or `-h`/`--help` anywhere in the
arguments takes the help path without loading the application env file
or acquiring the service lock.

A leading `--` argument separator is accepted.

Help flags take precedence even where an option value would otherwise
be expected. `daemon --help` displays daemon-specific help.

### Shutdown and recovery

The launcher replaces itself with flock, which replaces itself with
Node using `--no-fork`. Node receives signals directly.

For daemon execution, SIGINT and SIGTERM request shutdown. The daemon
awaits its active cycle before exiting; repeated shutdown signals do
not bypass that wait. Give the service enough shutdown time for its
configured network and transaction waits.

Ownership remains held until process exit. SIGKILL also releases
ownership after the process exits, but bypasses application cleanup.

Normally spawned children do not retain the lock. Application code must
not explicitly forward the inherited lock descriptor through child
stdio or close it while protected work remains active.

Lock recovery is not transaction recovery. After a crash, forced stop,
or uncertain submission, inspect pending transactions, signer nonce
state, receipts, and registry state before retrying. A released lock
does not prove that the previous process's transaction was rejected.

### Exit status and diagnostics

These statuses describe the underlying launcher or Node process.
Package managers and supervisors may additionally report wrapper errors.

| Status | Meaning |
| --- | --- |
| `0` | Successful command completion or graceful daemon shutdown. |
| `1` | Application failure or an explicit launcher validation failure. |
| `2` | CLI output failure; the operation may already have succeeded. |
| `9` | Node startup failure observed when a configured env file is missing. |
| `75` | Another process holds the service lock; this may have no diagnostic output. |

Other startup failures can retain the exit status of the failing tool.
Do not interpret every nonzero status as contention.

Application verification failures use `SERVICE_LOCK_NOT_HELD` with a
fixed diagnostic reason:

| Reason | Check that failed |
| --- | --- |
| `platform` | Protected execution requires Linux. |
| `state-directory` | State-directory validation or checkpoint placement. |
| `lock-file` | Lock-file lookup, type, or link-count validation. |
| `descriptor` | No matching inherited exclusive flock was verified. |

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

Use a dedicated checkpoint file and state directory for each independent
daemon deployment.

The launcher holds service ownership for the process lifetime. The
daemon verifies that ownership before creating or loading checkpoint
state. There is no separate application-managed checkpoint lock to
acquire or release.

Preserve checkpoint state across normal restarts and deployments.

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

### Error diagnostics

Once configuration loading installs the credential-aware diagnostic
policy, the CLI and daemon use it for subsequent error diagnostics,
including failures during remaining configuration validation.

`QUICKNET_LOG_LEVEL` controls daemon event verbosity independently.

Each error summary preserves its name, supported code and HTTP status,
and a scrubbed explanation. Explanation selection prefers `details`,
then `shortMessage`, then `message`, using the first non-empty string.
Causes and aggregate members are summarized recursively within fixed
limits.

The scrubber removes recognized forms of the configured private key and
RPC credentials, authorization values, and URL user information and
path/query/fragment contents. Endpoint hostnames can remain visible.
It does not guarantee removal of arbitrary secrets that were never
configured or recognized.

External error objects are not serialized directly. Stack traces,
headers, request bodies, ABI objects, and other undeclared properties
are not copied into the summary. Selected explanation text is scrubbed
before output.

Registered usage, configuration, and service-lock errors use fixed
messages. Other failures use fixed fallback descriptions until the
credential-aware diagnostic policy is installed.

If scrubbing a field throws, that field becomes
`[diagnostic text unavailable]`.

Summaries have these limits:

- Four error levels, including the root.
- Twelve error nodes in total.
- Four members per aggregate.
- 8,192 bytes per serialized error summary.

`causeOmitted` and `errorsOmitted` indicate omitted traversal.
`textModified` indicates that text was redacted, escaped, truncated,
or replaced with a fallback.

### Failure context

When available, `consumer_failed` includes an `operation` object
identifying the last operation entered, with relevant scan bounds
or checkpoint position.

Round-import context includes the exact round and a phase such as
`fetch-beacon`, `prepare-submission`, `submit-transaction`,
`wait-for-receipt`, or `verify-stored-beacon`. Receipt-wait and
post-receipt verification context include the known transaction hash.

CLI import failures include the corresponding round-import context.
Context is attached to the original reported failure; unrelated fatal
errors do not inherit it.

A phase identifies where processing stopped. It does not establish
whether a broadcast was accepted or whether retrying is safe.

### Decoded contract reverts

When available, contract-revert summaries include a `revert` object
containing the decoded error name, reason, and up to four scalar
arguments.

Strings are scrubbed. Supported bigints become decimal strings.
Unsupported argument values retain their position as `[omitted]`;
`argsOmitted` indicates unsupported or additional arguments.
Revert text shares the summary's output-size budget.

Decoded fields are diagnostic information. They do not change
simulation fallback, transaction retry, or recovery decisions.

### CLI and output failures

CLI failures are emitted as structured `cli_failed` records.
Uncaught exceptions and unhandled rejections use the same configured
scrubbing and summary limits when initialization has reached that point.

If rendering or writing successful command output fails, the CLI
attempts to emit `output_failed` and exits with status `2`.
That diagnostic preserves validated import outcome fields when
available, including the transaction hash. An output failure does not
mean that an already-completed import failed.

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

Processes sharing a signing account on the same chain must share the
service-ownership boundary described above. Separate checkpoint files
or separate state directories do not prevent signer nonce conflicts.
The service lock does not reconcile transactions after a restart.

## Docker

Build from the repository root:

```bash
docker build \
  -f apps/relayer/Dockerfile \
  -t drand-quicknet-relayer .
```

Supply operator configuration through environment variables or your deployment
platform's secret-management mechanism. Do not bake private keys into images.

The image runs as the `node` user and defaults to:

    QUICKNET_STATE_DIR=/state
    QUICKNET_CHECKPOINT_FILE=/state/checkpoint.json

Mount persistent storage at `/state`. Containers intended to coordinate
must mount the same underlying storage there; separate volumes provide
separate locks.

Bind-mounted directories retain their host ownership and permissions.
The image's `/state` permissions do not repair a mounted directory.
Ensure the service user can create the lock and update checkpoints.
A world-writable state directory is refused.

The entrypoint uses the service launcher. Without `--init`, Node becomes
PID 1. The daemon installs SIGINT/SIGTERM handlers and waits for active
work before exiting. Configure the container stop timeout accordingly;
expiry can force termination before work completes.

Running with `--init` is also supported. Never delete the lock file to
force a second container to start.

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
- inherited service-lock verification and checkpoint persistence
- ownership through graceful shutdown and forced process termination
- ordinary child processes not retaining service ownership
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
