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

The import, daemon, and nonce-sync examples assume you have created
`network.json` in the repository root using the custom network descriptor
format below. Replace its example values with trusted deployment and
chain configuration for your network. Status examples use public chain
and signer identity instead.

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

Beacon retrieval uses a bounded number of attempts. Submission
uses the simulation fallback policy described below; an import
attempt does not automatically rebroadcast after a wallet error
or receipt timeout.

### `daemon`

Runs the demand-driven consumer watcher:

```bash
pnpm --filter @based-labs/drand-quicknet-relayer start \
  daemon \
  --network-config "$PWD/network.json"
```

`import`, `import-when-available`, `daemon`, and `sync-nonce` accept
either `--network` for a built-in preset or `--network-config` for a
custom descriptor, never both. `status` instead requires `--chain-id`
and `--signer`.

The daemon requires the additional consumer/checkpoint environment
variables described below.

### `sync-nonce`

Previews a forward nonce-allocation repair for an existing signer journal:

```bash
pnpm --filter @based-labs/drand-quicknet-relayer start \
  sync-nonce \
  --network-config "$PWD/network.json"
```

To apply an eligible repair, repeat the command with `--apply`.
Apply performs a fresh inspection; it does not commit a previously
displayed preview.

Stop any other command using the same chain, signer, and state directory
first. Preview and apply both require exclusive service ownership.

The journal must exist and contain no retained attempts, including
included attempts awaiting durable resolution. The RPC chain ID must
match the journal identity. Durable, latest, and pending nonce counts
must agree, and the selected durable anchor must remain stable during
inspection.

Matching the journal's allocation to the durable nonce is not sufficient
for an already-synchronized result. For an otherwise eligible journal and
observation, disagreement between durable, latest, and pending counts
produces a deferred result—even when allocation already equals the durable
nonce.

Investigate outstanding or external signer activity before retrying.
Nonce synchronization does not resolve pending transactions.

A repair only advances allocation. It preserves the original baseline,
records the accepted observation, and retains the newest eight repair
records in the journal. Matching RPC counts do not prove that no
untracked signed transactions or hidden pending transactions exist.
The dedicated-signer requirement still applies.

Preview does not rewrite the journal or remove journal temporary files.
An eligible apply uses normal journal opening, including temporary-file
cleanup and a durability rewrite, before saving the repair. Cancellation
after writable opening may therefore leave those maintenance operations
completed even when no repair is applied.

Once repair persistence starts, the command waits for its actual outcome.
A shutdown signal does not turn a successfully persisted repair into an
interrupted result.

A successful repair emits `signer_nonce_synced` at warning level, subject
to the configured log level. The journal retains the repair independently
of log delivery.

Exit statuses are:

- `0`: preview completed with an eligible repair, already synchronized,
  or repair applied.
- `1`: repair refused or an operational failure occurred.
- `2`: command output failed; a repair may already have been applied.
- `4`: inspection deferred.
- `5`: handled cancellation before a result was returned.
- `75`: another process holds service ownership.

The command does not sign or broadcast transactions, create a missing
journal, or modify checkpoints.

### `status`

Reads local signer diagnostics using public identity:

```bash
QUICKNET_STATE_DIR=/srv/quicknet/robinhood-mainnet \
pnpm --filter @based-labs/drand-quicknet-relayer start \
  status \
  --chain-id 4663 \
  --signer 0xYourSignerAddress
```

Replace the signer placeholder with the signing account's address.

Status requires no private key, RPC URL, or network descriptor. It does
not load the application's env file. Set `QUICKNET_STATE_DIR` in the
launching environment; otherwise the default is `./state`, relative to
the process's working directory.

Without `--source`, the launcher selects the diagnostic source:

| Lock outcome | Selected source |
| --- | --- |
| Exclusive ownership acquired | `journal` |
| Contention, exit status `75` | `daemon-snapshot` |
| Any other acquisition failure | Command fails without fallback |

Contention does not identify the process holding ownership. It may be
another command rather than the daemon.

Automatic selection and explicit journal inspection require an existing
state directory and regular service lock file. Status does not create
either. A missing directory or lock is an error in these modes; it does
not trigger snapshot fallback.

Select a source explicitly for predictable script behavior:

```bash
QUICKNET_STATE_DIR=/srv/quicknet/robinhood-mainnet \
pnpm --filter @based-labs/drand-quicknet-relayer start \
  status \
  --chain-id 4663 \
  --signer 0xYourSignerAddress \
  --source daemon-snapshot \
  --max-age-ms 120000
```

The supported sources are:

- `journal`: requires verified exclusive ownership and reads the
  persisted signer journal. Reports allocation, accepted observations,
  retained attempts with every candidate transaction hash, and retained
  nonce repairs. Explicit journal mode exits `75` on contention.
- `daemon-snapshot`: reads the last published `daemon-status.json`
  without acquiring ownership. Reports historical gate observations,
  retained attempts, cycle completion, and retry observations. It can
  report a missing snapshot even when the state directory is absent.

A read or validation failure never causes fallback to the other source.
Signer identity comparisons are case-insensitive.

`--max-age-ms` applies only to snapshot mode and defaults to `120000`.
It accepts a positive decimal safe integer. Specify
`--source daemon-snapshot` when supplying it: if automatic selection
chooses journal mode, the age option is rejected.

Choose an age threshold that accommodates the daemon's poll interval
plus the work of a cycle. An age equal to the threshold is fresh; an
older observation is stale. A future observation is reported as clock
skew. “Stale” describes the published snapshot's age, not daemon health.

Both sources report current signing authorization as unknown. A
snapshot's last observed open gate does not authorize a new transaction.
A closed gate without reported blockers does not establish why it was
closed.

Cycle completion and retry observation timestamps remain separate from
snapshot publication time. A completed cycle may contain consumer
failures. Retry delays are historical observations, not countdowns or
permission to send.

Status does not initialize or rewrite the journal, remove temporary
files, modify checkpoints, perform recovery, make RPC calls, sign, or
broadcast. Signed transaction bytes are excluded from output.

Exit statuses are:

- `0`: the selected diagnostic source was read and reported successfully,
  including a missing journal, missing snapshot, or stale snapshot.
- `1`: invalid arguments, invalid or unreadable state, ownership
  verification failure, or another operational failure.
- `2`: command output failed.
- `5`: handled cancellation before a result was returned.
- `75`: explicit journal inspection encountered ownership contention.

Other launcher failures may preserve the failing tool's exit status.
Exit status `0` does not establish daemon health or signer readiness.

## Configuration

For `import`, `import-when-available`, `daemon`, and `sync-nonce`, the
package `start` script requires the repository root `.env` and loads it
through Node. A missing file stops startup.

`status` and help bypass application env-file loading. Status uses public
command-line identity and `QUICKNET_STATE_DIR` from the launching
environment.

The `start:container` script uses the existing environment without
automatically loading a file. It can also be used outside containers.

The launcher reads `QUICKNET_STATE_DIR` before Node loads application
configuration. Set it in the launching environment, service definition,
or container environment. Setting it only in the application's `.env`
does not select the directory that the launcher locks.

`QUICKNET_FETCH_TIMEOUT_MS` sets the deadline for each Quicknet endpoint
request, including response body consumption. It defaults to `5000` and
accepts decimal integers from `1` through `60000`. It applies to `import`,
`import-when-available`, and daemon imports.

Each endpoint gets a fresh deadline. With two endpoints, an attempt where
both stall has a nominal timeout budget of twice this setting, 10 seconds
by default, plus scheduling overhead. Retries and retry delays extend the
total duration. Caller cancellation stops the operation without trying
another endpoint.

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

### Receipt timeout

`QUICKNET_RECEIPT_TIMEOUT_MS` controls receipt waiting for `import`,
`import-when-available`, and `daemon`. It defaults to `30000` milliseconds
and accepts decimal integers from `1` through `2147483647`. Zero is rejected.

```dotenv
QUICKNET_RECEIPT_TIMEOUT_MS=30000
```

Choose a timeout that allows a few expected transaction-inclusion times
on your network, with room for ordinary congestion. A shorter value
reports pending work sooner; a longer value keeps the current import
waiting longer before returning to recovery.

This is an operational waiting threshold, not a transaction-safety or
finality bound. Expiry does not cancel the transaction.

When the receipt wait times out, the import returns `pending` with reason
`receipt-timeout`. The journal attempt remains available for recovery.
Timeout does not establish transaction failure, release the signer gate,
or authorize another broadcast.

One-shot commands exit after reporting pending work. The daemon continues
recovery on subsequent cycles.

This setting controls receipt waiting, not total command or cycle duration.

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
`QUICKNET_STATE_DIR`. Nested directories and paths outside that 
directory are rejected. The filenames `relayer.flock` and 
`daemon-status.json` are reserved.

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

The checkpoint records request-scanning progress. Pending transactions
and signer recovery state are stored separately in the signer journal.
Preserve both files across restarts and deployments.

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
Shutdown interrupts this delay. During first-use daemon startup, this 
also sets the delay between signer initialization attempts when nonce 
counts disagree or the selected durable anchor changes.

This is not a fixed cycle duration or an end-to-end import latency
guarantee. Scanning, beacon retrieval, and transaction confirmation
take additional time.

A shorter interval improves responsiveness and catch-up throughput
but increases RPC traffic. A longer interval reduces cycle frequency
but can delay discovery of new requests and historical catch-up.

This setting controls cycle frequency, not individual RPC calls.
One cycle can make multiple calls and process multiple rounds.

Accepts a positive decimal integer.

#### Transaction broadcast retry settings

`QUICKNET_BROADCAST_RETRY_INITIAL_MS` defaults to `5000` milliseconds.
`QUICKNET_BROADCAST_RETRY_MAX_MS` defaults to `60000` milliseconds.
Both accept decimal integers from `1` through `2147483647`. The maximum
must be at least the initial delay. Equal values select a fixed interval.

These settings configure the journal-backed broadcast retry schedule used
by daemon recovery and recovery before one-shot submissions. A retry
requires both an elapsed delay and fresh coordinator authorization;
elapsed time alone never permits broadcasting.

The schedule doubles the delay between send attempts up to the maximum,
without delaying receipt reconciliation. A restored attempt that may have
been broadcast waits the initial delay. Timing is process-local and starts
again after restart. These settings do not authorize journal bootstrap.

#### `QUICKNET_LOG_LEVEL`

Default: `info`.

Controls the minimum severity emitted by the relayer’s structured logger.
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

Dedicate each state directory to one chain and signing account. All 
commands using that chain and signer must share that directory.

Protected commands require Linux and util-linux `flock`:

- `import`
- `import-when-available`
- `daemon`
- `sync-nonce`

`status` acquires ownership when inspecting the journal. Snapshot mode
does not require ownership. Automatic source selection attempts ownership
and selects snapshot mode only on contention; see [`status`](#status).

Use the package scripts or installed `relayer` executable. They enter
through `scripts/relayer.sh`. Commands requiring ownership acquire an
exclusive, nonblocking lock on:

    QUICKNET_STATE_DIR/relayer.flock

The default state directory is `./state` when `QUICKNET_STATE_DIR` is
unset. An explicitly empty value is invalid.

For `import`, `import-when-available`, `daemon`, and `sync-nonce`, the
launcher creates a missing directory and canonicalizes its path.
Check configured paths carefully: a typo can create a new state
directory with no existing checkpoint.

`status` never creates the state directory or lock file.

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

The launcher opens the persistent lock file on a dedicated descriptor
and uses util-linux flock to acquire exclusive ownership. It then
replaces itself with Node, preserving the locked descriptor and direct
signal delivery.

For `daemon`, `import`, `import-when-available`, and `sync-nonce`, SIGINT
and SIGTERM request cooperative shutdown. Round waits, beacon fetching,
and cancellable retry delays receive the shutdown signal. Other active
operations finish before cancellation is checked at operation boundaries.

`status` also handles SIGINT and SIGTERM cooperatively. It checks
cancellation around reads; an active filesystem read may finish before
cancellation is observed. The command performs no journal recovery or
persistence.

Signing and journal persistence are allowed to finish once started.
If cancellation prevents broadcasting a recorded signed attempt, that
attempt remains in the journal for recovery on a later run. Shutdown
does not discard the attempt or reset its nonce.

Once broadcasting starts, its outcome is preserved. An acknowledged
broadcast proceeds through receipt waiting using the configured receipt
timeout and, on success, stored-beacon verification. Shutdown does not
interrupt those steps or trigger another submission. One-shot commands
still report the resulting import outcome; unrelated failures remain
failures.

Repeated shutdown signals do not bypass active work. Give the service
enough shutdown time for network requests, journal writes, receipt
waiting, and post-receipt verification. The receipt timeout alone is
not a bound on total shutdown time.

Ownership remains held until process exit. SIGKILL also releases
ownership after the process exits, but bypasses application cleanup.

Normally spawned children do not retain the lock. Application code must
not explicitly forward the inherited lock descriptor through child
stdio or close it while protected work remains active.

Lock recovery is not transaction recovery. After a crash or forced stop,
the next process uses the retained signer journal to reconcile recorded
attempts before authorizing further submissions. A released lock does
not prove that the previous process's transaction was rejected.

Unattributed signer activity or an exhausted replacement search keeps
the signer blocked and requires investigation. Do not delete the journal
to bypass a blocker.

### Exit status and diagnostics

These statuses describe the underlying launcher or Node process.
Package managers and supervisors may additionally report wrapper errors.

| Status | Meaning |
| --- | --- |
| `0` | Successful command completion or graceful daemon shutdown. |
| `1` | Application failure, refused nonce repair, or explicit launcher validation failure. |
| `2` | CLI output failure; the operation may already have succeeded. |
| `3` | One-shot import remains pending. A journaled transaction attempt remains unresolved. |
| `4` | Import deferred because the signer is unavailable or the work is already retained, or nonce-sync inspection deferred. |
| `5` | One-shot command handled SIGINT/SIGTERM before producing a result. Retained journal state may still require recovery. |
| `6` | Signer startup refused because the journal exceeds supported runtime bounds. |
| `9` | Node startup failure observed when a configured env file is missing. |
| `75` | Another process holds the service lock; this may have no diagnostic output. |

For one-shot commands, a shutdown signal does not override an import
outcome returned by active work. Completed, pending, and deferred results
retain their normal exit codes; unrelated failures remain failures.
Exit code `5` does not prove that no transaction was signed or broadcast.

Exit code `5` applies to cancellation handled after the command installs
its shutdown handlers. Signals received earlier during process startup
may terminate the process with the platform's default signal status.

For `import` and `import-when-available`, status `0` after executing the
import means the round was imported or was already stored. Help requests
also exit `0` without performing an import.

Incomplete work uses separate statuses:

- `3` (`pending`): a journaled transaction was not acknowledged by the RPC,
  or receipt waiting timed out. Output includes the attempt ID,
  locally computed transaction hash, and pending reason.
- `4` (`deferred`): no new attempt was prepared. For
  `signer-unavailable`, output includes the signer blocker. For
  `already-retained`, output includes the existing attempt ID and
  work identity (`workId`).
- `5` (`interrupted`): the command handled cancellation before producing
  an import result. No result is printed; retained journal state may
  still require recovery.

None of these outcomes proves that the beacon is absent on-chain.
Retained transaction attempts remain available for journal recovery.
The one-shot command exits rather than continuing recovery in the
background.

If rendering or writing a command result fails, status `2` takes precedence 
over the result’s normal exit status. An import or nonce repair may already 
have succeeded. Service ownership is released when the process exits. The 
journal is retained.

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

### Journal runtime bounds

The signer runtime supports at most:

- One retained transaction attempt.
- Sixteen signed transaction candidates per attempt, including the
  original transaction.

These are supported runtime limits, not environment settings. The
candidate limit does not itself enable automatic fee replacement.

Signer startup refuses a journal that exceeds either limit, reports
`journal-bounds-exceeded`, and exits with status `6`. It does not truncate
or overwrite the journal to make it fit.

Preserve the journal and inspect it using explicit journal status mode.
Journal inspection remains available for structurally valid journals
that exceed runtime bounds. Inspection does not authorize signing.

An over-bound journal requires investigation and a deliberate recovery
plan. Do not delete attempts or signed transaction candidates merely to
pass startup validation: they may represent transactions that were
already broadcast.

`sync-nonce` is not a way to discard retained attempts. It refuses repair
while any attempt remains retained.

Having one valid retained attempt is normal during transaction recovery.
It is distinct from exceeding the journal bounds.

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

`import`, `import-when-available`, and `daemon` use the same submission path 
for an exact round `R`:

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

After successful simulation, the submitter performs fresh signer recovery
and checks the signer gate. If the gate remains closed, the import returns
`deferred` with the observed blocker and prepares no new attempt.

When authorized, the coordinator signs and persists an attempt before
broadcasting its recorded bytes. Before the RPC send, it persists that
broadcast may occur. The send request disables automatic RPC retries.

An acknowledgement means the RPC returned the locally computed transaction
hash; it does not establish inclusion or execution. The importer then
waits for a receipt and verifies stored randomness at the receipt's block.

An RPC request error, malformed response, or mismatched hash returns
`pending` with reason `broadcast-not-acknowledged`. A receipt-wait timeout
returns `pending` with reason `receipt-timeout`. Both retain the attempt ID
and locally computed transaction hash.

Journal persistence failures and other operational errors still propagate
as failures. Reverted receipts and stored-randomness mismatches also fail
the import.

Broadcast and receipt outcomes do not trigger compressed-signature
fallback. That fallback remains confined to simulation.

### Recovery after an uncertain transaction

The signer journal retains attempts across daemon cycles and process
restarts. Recovery inspects chain evidence and persists reconciliation
results before allowing further signer work.

Every broadcast consumes its authorization. Another send requires fresh
reconciliation and retry-schedule eligibility. Retries send recorded
transaction bytes; an uncertain response does not allocate a new nonce
or discard the attempt.

The command runtime currently retains at most one attempt. Included
attempts remain journaled until durable resolution, so observing inclusion
alone does not free journal capacity.

Preserve the signer journal alongside the checkpoint. Commands sharing a
chain and signer must use the same state directory. Releasing the service
lock does not prove that a transaction was rejected, and an unstored round
does not prove that an earlier broadcast was never accepted.

### Durable recovery scheduling

Signer recovery separates durable reconciliation from latest-head
inclusion validation. Durable reconciliation determines which retained
attempts can be resolved under the configured finality policy.
Latest-head validation checks whether retained inclusion evidence still
holds and whether further signer work is permitted.

The command runtime may skip the durable portion of a recovery call when
a previous pass completed successfully, the durable anchor and relevant
committed recovery state are unchanged, and the retained population is
empty or fully verified. Persistent recovery blockers prevent reuse.
An explicit latest head is required.

Latest-head validation still runs on every recovery call, including
recovery before submission. Daemon recovery and pre-submit recovery
share the same runtime schedule.

An unchanged durable pass becomes due again after 60 seconds, measured
with a monotonic clock from successful durable completion. This is an
internal safety-net interval, not an environment setting or a background
timer. The refresh runs on the next recovery call after it becomes due.

A changed durable anchor, including a same-height hash change or a
regression, requires a new durable pass. Relevant committed-state changes
also prevent reuse. Failed operations, incomplete latest-head validation,
and persistence uncertainty invalidate reuse. A restarted runtime always
requires fresh recovery.

A consumed nonce without an identified outcome remains on the full
recovery path, including after replacement-search exhaustion. Exhaustion
does not establish that an attempt succeeded, reverted, or was replaced.

Internally, a reused durable pass returns
`inspection.status: 'skipped'` with reason
`unchanged-durable-state`. This describes only the omitted durable
inspection; latest-head validation still runs. It is not a CLI exit
status, a transaction outcome, or signing authorization.

This schedule is separate from durable-head polling. Recovery reacts to
the durable anchor supplied by the head reader, whose polling policy
still determines when a new durable head is observed.

The runtime retention limit remains one attempt. An included attempt
continues occupying that slot until durable resolution. Scheduling
reduces repeated recovery work; it does not remove that throughput limit.

### First-use signer initialization

A missing signer journal initializes automatically during recovery.
There is no separate initialization command.

Initialization requires matching transaction counts at the selected
durable block, `latest`, and `pending`. The durable block's hash is
rechecked before accepting the observation. Only an accepted observation
is persisted as the journal's initial nonce baseline.

Matching counts do not prove that no untracked signed transactions exist.
Use a dedicated signer with no outstanding transactions outside this
relayer's journal and service-ownership boundary.

When counts disagree, initialization is deferred and the journal remains
missing. The daemon retries at `QUICKNET_POLL_INTERVAL_MS`; an anchor
change also causes another startup pass. RPC and persistence failures
propagate as failures rather than entering this polling retry loop.

The daemon waits for signer journal initialization before opening or
creating checkpoint state and entering normal processing. Initialization
alone does not authorize submission: the signer gate still requires
recovery and inclusion checks.

Before opening a missing signer journal, startup inspects the state
directory while holding verified service ownership. Automatic
initialization is allowed only when the directory contains the verified
`relayer.flock` entry and nothing else. Checkpoints, daemon status snapshots,
journal temporary files, other signers' journals, and unrelated entries
block initialization with `prior-state-present`, regardless of whether a
checkpoint path was configured.

Verify the configured directory and restore the matching journal if
available. Remove entries only after establishing they are unrelated to
prior relayer state. Do not delete checkpoint or journal recovery evidence
to bypass this check.

This check cannot detect an entirely lost or incorrectly selected state
directory.

Existing journals follow normal recovery. An unreadable or invalid journal
causes startup to fail; it is not replaced with a new baseline.

One-shot commands exit after reporting pending or deferred work; they do
not keep recovery running in the background. The daemon continues recovery
on subsequent cycles.

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
checkpoint_advanced
consumer_failed
durable_head_regressed
heartbeat
logging_failed
round_already_stored
round_deferred
round_imported
rpc_usage
signer_bootstrap_deferred
signer_nonce_synced
status_publication_failed
```

`checkpoint_advanced` and `round_already_stored` are debug-level routine
progress. `heartbeat` is emitted periodically at info level.

`round_deferred` reports a round for which no new transaction attempt
was prepared. Its reason distinguishes `signer-unavailable`, which
includes a signer blocker, from `already-retained`, which includes the
existing attempt ID and work identity (`workId`).

An already-retained result means the signer coordinator already tracks
that work. It does not establish that the transaction succeeded or that
the beacon is stored; the retained attempt still requires reconciliation.

`signer_bootstrap_deferred` is an info-level event emitted when first-use
initialization observes mismatched nonce counts. It includes `signer`,
`durableBlock`, `durableBlockHash`, `durableNonce`, `latestNonce`, and
`pendingNonce`; block numbers and nonce counts are decimal strings.

The coordinator reports the first mismatch and subsequent changes to
any of the three nonce counts. Unchanged counts are suppressed even
when the durable anchor advances. Suppression is process-local, so
restarting can report the same mismatch again.

`signer_nonce_synced` is emitted at warning level after repair persistence
succeeds. It includes `signer`, `previousNextNonce`, `nextNonce`, `durableBlock`,
`durableBlockHash`, `durableNonce`, and `repairAt`, alongside the logger’s
chain identity. Nonces and block numbers are decimal strings.

`status_publication_failed` is a warning emitted when daemon status
observation or publication fails. It includes the signer and a scrubbed
error summary. The daemon continues; the previous snapshot may remain
on disk, and a failed write may have an uncertain on-disk outcome.

Logging failures are isolated so logging itself does not stop the daemon.

### RPC usage reporting

`rpc_usage` is an info-level event reporting JSON-RPC activity through
the relayer's instrumented public and wallet clients. It excludes drand
beacon fetches.

Logical calls and HTTP requests are independent measurements. A logical
call may require multiple HTTP requests because of retries, while batching
can combine multiple logical calls into one HTTP request.

Logical durations run from invocation to resolution or rejection. HTTP
durations run from request start until response headers arrive or the
request rejects; they do not measure full response-body processing.
An HTTP response does not establish that the JSON-RPC operation succeeded.

Reports include cumulative usage since collector creation and, when
available, an interval view. Logical rows are grouped by client and method;
HTTP rows are grouped by client and include response-status counts.
Average durations are null when there are no completions.

The daemon checks the 60-second reporting threshold at completed cycle
boundaries. There is no separate reporting timer or catch-up burst.
Long-running startup or cycles can delay reports. The daemon also attempts
one final report when its reporting session finishes, including when
startup or execution fails.

`import`, `import-when-available`, and `sync-nonce` attempt one final
cumulative report after their result output or when execution unwinds
through failure or cancellation. No summary is created if client creation
fails. Forced termination such as SIGKILL cannot run final reporting.

Daemon RPC events use the daemon's stdout log destination. The three
CLI commands write RPC events to stderr, keeping stdout for command
results. Reports follow `QUICKNET_LOG_LEVEL`: info, debug, and trace allow
them; warn, error, fatal, and silent suppress them.

The first report has no interval baseline. Later daemon reports use actual
monotonic elapsed time between observations. Interval counters are deltas,
while in-flight values describe the current observation. Work spanning
observations contributes its full duration to the interval in which it
completes.

An interval is unavailable when there is no baseline, the collector changes,
elapsed time is invalid, or counters regress. Cumulative usage remains
available in those reports.

The interval baseline advances when a report is constructed, before log
delivery. Filtering or delivery failure does not preserve that interval
for replay. A capture failure preserves the previous baseline, and the
daemon waits for the next reporting threshold before retrying.

RPC reporting failures do not replace command results or execution errors.
These measurements are diagnostic observations, not provider billing
totals or evidence of daemon health.

### Daemon status snapshot

The daemon attempts to publish `daemon-status.json` in the canonical
`QUICKNET_STATE_DIR` after successful startup and after each completed
cycle. Publication starts only after signer journal initialization.
Writes are serialized and awaited.

When available, the snapshot also includes cumulative RPC usage captured
for that publication. The `status` command displays this historical
observation without making RPC requests. Older snapshots may omit RPC
usage. If RPC capture fails, recovery-status publication can still proceed
without the RPC section.

Snapshot RPC usage is independent of periodic `rpc_usage` log reports and
does not advance their interval baseline.

Publication is awaited before processing continues. A slow or stalled
filesystem write can delay startup or the next daemon cycle even though
publication errors are isolated. Use the persistent local storage
required by the service-ownership model.

Publication is independent of the configured log level. There is no
separate publication timer; long-running cycles can leave an older
snapshot on disk. Publication failures are reported through
`status_publication_failed`, subject to the configured log level.

The snapshot contains the chain and signer identity, the daemon's log
run ID, the observation timestamp, journal initialization state, and
the last observed signer gate. Gate diagnostics include blockers,
recovery and inclusion-check completion, persistence state, and
the coordinator-reported `blockedSince`.

`blockedSince` identifies the coordinator-reported blocking episode.
A change in the primary blocker does not itself reset it. After restart,
it may originate from a retained attempt's creation time.

Retained attempts include their IDs, decimal nonces, phases, and every
recorded candidate transaction hash. Signed transaction bytes are
excluded.

Cycle completion and retry observations carry separate timestamps.
Publishing another snapshot does not refresh those timestamps.
A completed cycle may include consumer failures. A recorded retry
delay is historical; it is neither a live countdown nor permission
to broadcast.

The snapshot is diagnostic state. It does not replace the signer
journal or checkpoints and is not used to authorize transaction work.
It can remain on disk after shutdown or a failed restart.

A fresh snapshot does not authorize signing. A held service lock does
not establish daemon health; another command may own it.

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

During import or daemon startup, a missing journal with entries other 
than the verified `relayer.flock` in the state directory produces
`cli_failed` with kind `signer-journal`, code `prior-state-present`, 
and exit status `1`. `sync-nonce` instead reports `journal-missing` and
does not initialize the journal.

Other failures use fixed fallback descriptions until the credential-aware
diagnostic policy is installed.

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

CLI exceptions are emitted as structured `cli_failed` records. A refused
nonce repair is reported as a command result with exit status `1`.
Uncaught exceptions and unhandled rejections use the same configured
scrubbing and summary limits when initialization has reached that point.

For nonce synchronization, `output_failed` preserves validated identity,
mode, status, and repair details when available. Output failure does not
undo a persisted repair.

If rendering or writing command output fails, the CLI attempts to emit
`output_failed` and exits with status `2`.

That diagnostic preserves validated import outcome fields when available:
completed results include randomness and, for imported results, the
transaction hash. Pending results include the attempt ID, transaction
hash, and reason. Deferred results include the reason and signer blocker.

An output failure does not change the underlying import outcome.

For status, `output_failed` retains only the validated source, whether the
journal or snapshot was present, and `gate: unknown`. It does not copy the
journal, snapshot, or signed transaction bytes into the diagnostic.

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
- daemon startup remaining deferred on mismatched signer nonce counts.
  Unchanged counts do not produce repeated log events
- `status_publication_failed`
- snapshot observation age and last completed cycle time, accounting
  for expected cycle duration

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

Use a separate signing account, state directory, and checkpoint file for each independent relayer.

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
PID 1. The daemon, both import commands, and `sync-nonce` install
SIGINT/SIGTERM handlers and await active work during graceful shutdown.
Configure the container stop timeout accordingly; expiry can force
termination before work completes.

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
- daemon status snapshot validation and exclusion of signed bytes
- reserved snapshot filename and filesystem safety checks
- snapshot publication after initialization and cycle completion
- shared run IDs across daemon logs and snapshots
- serialized publications and publication-failure isolation
- historical cycle and retry timestamps
- public-identity status configuration without signing credentials
- automatic and explicit status source selection
- snapshot age classification and historical gate reporting
- status reads preserving journals, checkpoints, and temporary files
- status output validation and output-failure exit codes

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
