# Quicknet Relayer

Permissionless relayer for importing requested [drand Quicknet](https://drand.love/) beacons into `DrandQuicknetBeaconRegistry`.

The relayer watches configured consumer contracts for:

```solidity
event QuicknetRandomnessRequested(
    uint64 indexed round
);
```

When a consumer requests a Quicknet round, the relayer:

1. Discovers the request on-chain.
2. Checks whether that exact round is already stored.
3. Fetches the exact requested round from drand if necessary.
4. Uses the beacon's canonical 48-byte compressed signature.
5. Simulates the registry submission.
6. Submits the beacon if necessary.

The relayer is deliberately not trusted by the protocol. It is only a courier for publicly verifiable randomness.

## Architecture

```text
Consumer
   │
   │ QuicknetRandomnessRequested(round)
   ▼
Relayer
   │
   ├── discover request
   ├── check exact round in registry
   ├── fetch exact drand round if missing
   ├── use canonical compressed signature
   ├── simulate registry submission
   │
   ▼
DrandQuicknetBeaconRegistry
   │
   │ verifyBeacon(round, signature)
   ▼
DrandQuicknetBeaconVerifier
   │
   │ verified + sha256(signature)
   ▼
DrandQuicknetBeaconRegistry
   │
   ▼
stored official drand randomness
```

The relayer never chooses the randomness round.

The consumer must commit to an exact future Quicknet round before that round becomes knowable. Once committed, only that round may be used.

There is no:

- "latest available" randomness
- fallback round
- reroll
- relayer-selected round
- first-relayer-wins randomness choice

## Commands

The relayer provides three operational modes.

### `daemon`

Continuously discovers consumer requests and imports their requested beacons.

```sh
pnpm --filter @based-labs/drand-quicknet-relayer \
  start daemon \
  --network robinhood-testnet
```

### `import`

Imports a specific Quicknet round immediately.

Use this for manual operation or diagnostics when the round is already available.

### `import-when-available`

Waits for a future exact Quicknet round and imports it when it becomes available.

This is useful for manual testing of future rounds.

None of these commands allows round substitution.

## Security model

The relayer is permissionless. Correctness is enforced on-chain by
`DrandQuicknetBeaconRegistry` and `DrandQuicknetBeaconVerifier`.

A malicious relayer cannot:

- forge a valid drand beacon
- cause a correctly implemented consumer to settle using a different round
- alter stored randomness for an exact round
- overwrite an already stored beacon
- choose between multiple outcomes for the committed round

A relayer may submit valid beacons for unrelated rounds to the permissionless
registry, but a correctly implemented consumer reads only the exact round it
committed to.

A malicious relayer may:

- refuse to relay
- delay a relay
- submit a beacon that is already stored
- attempt to submit invalid data

Multiple independent relayers may safely operate at the same time.

Beacon storage is idempotent.

## Exact-round processing

Requests are always handled using the exact round emitted by the consumer:

```text
request round R
      │
      ▼
fetch drand round R
      │
      ▼
store round R
```

The relayer never searches for another usable round if `R` is unavailable.

If drand round `R` cannot currently be fetched, that is a liveness condition. It does not authorize a replacement round.

## Finality and reorg handling

The daemon separates **low-latency discovery** from **durable checkpointing**.

On Robinhood Chain Testnet, the configured durable boundary is the RPC `safe` head.

```text
                         latest
                           │
                           │ soft scan
                           ▼
                  immediate discovery
                  immediate importing
                           │
                           │
                    memory-only cursor


                          safe
                           │
                           │ durable scan
                           ▼
                   canonical replay
                           │
                           ▼
                  persisted checkpoint
```

### Soft scan

The daemon scans up to `latest` so new requests can be processed immediately.

Soft progress is stored only in memory.

This avoids forcing users to wait for a request block to reach the durable finality boundary before its beacon can be imported.

### Durable scan

The daemon separately scans up to the configured durable head.

Only successfully processed durable ranges are written to the checkpoint file.

For Robinhood Testnet:

```ts
finality: {
  type: 'safe',
}
```

is configured statically as network security policy.

Finality is not operator-configurable through an environment variable.

### Non-monotonic durable heads

RPC infrastructure may occasionally report a durable head that is behind the
daemon's already-persisted durable progress.

The daemon never moves its durable checkpoint backward.

If the configured durable head temporarily regresses, the daemon:

- preserves the existing durable checkpoint
- skips durable scanning for that cycle
- continues soft/latest scanning
- emits a `durable_head_regressed` warning
- resumes durable scanning from the exact persisted checkpoint once the
  durable head catches up

A temporary durable-head regression is therefore treated as an RPC/finality
observation rather than a consumer-processing failure.

For example:

```text
persisted durableNextBlock = 109638510
RPC safe head              = 109636509
        ↓
preserve durableNextBlock = 109638510
continue soft scan
emit durable_head_regressed
        ↓ safe recovers
resume durable scan from 109638510
```

The checkpoint is never rewound to match a stale RPC response.

### Restart behavior

Because the soft cursor is intentionally memory-only, restarting the daemon causes the non-durable region to be scanned again.

This is safe because beacon imports are idempotent.

For example:

```text
request R discovered at latest
        │
        ▼
beacon R imported
        │
        ▼
daemon restarts before request is safe
        │
        ▼
request R discovered again
        │
        ▼
registry already contains R
        │
        ▼
no replacement randomness
no duplicate state change
```

### Reorg guarantee

The current design does not attempt immediate detection of every soft-chain reorg.

Instead, it guarantees eventual reconciliation against the durable chain.

A reorg of non-durable history may temporarily delay discovery of a replacement request, but a healthy daemon will eventually discover the canonical request when the durable scanner reaches it.

In other words: `latest` is safe enough to act on, but not safe enough to forget.

## Checkpoints

Checkpoints are maintained per consumer.

A checkpoint stores:

```text
nextBlock
```

where `nextBlock` means:

> the first durable block that has not yet been successfully processed.

Example:

```json
{
  "version": 1,
  "chainId": 46630,
  "registry": "0x1111111111111111111111111111111111111111",
  "consumers": {
    "0x2222222222222222222222222222222222222222": {
      "nextBlock": "99706403"
    }
  }
}
```

If the durable head is:

```text
safe = 99706402
```

then:

```text
nextBlock = 99706403
```

means the relayer has durably processed everything through the current safe head.

### Checkpoint safety

The daemon:

- writes progress only after successful durable processing
- uses atomic file replacement
- binds the checkpoint to the configured chain and registry
- validates consumer addresses and stored values when loading
- rejects duplicate normalized consumer addresses
- never persists the soft scan cursor
- never moves a durable checkpoint backward
- tolerates temporary durable-head regressions without failing soft processing
- acquires an exclusive checkpoint lock before daemon processing begins

If the process crashes before a durable checkpoint write, that range is replayed after restart.

### Older checkpoint files

Checkpoint files created by versions of the relayer that checkpointed `latest` must not automatically be treated as durable checkpoints.

Do not silently reinterpret an old latest-head checkpoint as a safe-head checkpoint.

## Consumer interface

Consumers expose the registry they trust:

```solidity
function quicknetBeaconRegistry()
    external
    view
    returns (address);
```

and emit:

```solidity
event QuicknetRandomnessRequested(
    uint64 indexed round
);
```

The relayer validates configured consumers before starting.

Each configured consumer must:

1. contain deployed bytecode
2. implement `quicknetBeaconRegistry()`
3. point to the configured registry

The request event should only be emitted after the consumer has irreversibly committed all outcome-sensitive inputs and the exact requested round.

Emitting the event does not itself grant authority to:

- settle a draw
- choose an outcome
- refund a user
- invoke a callback
- change the requested round

Those semantics belong to the consumer protocol.

## Quicknet

The current deployment uses drand Quicknet.

Quicknet parameters:

```text
genesis timestamp: 1692803367
period:            3 seconds
```

Round scheduling is:

```text
roundAt(timestamp) = floor((timestamp - genesis) / 3) + 1
```

Consumers must commit to a sufficiently future round so all outcome-sensitive
state is fixed before the beacon becomes knowable. The registry exposes an
immutable `minimumLeadRounds` value as authenticated deployment metadata for
consumer safety policy.

The relayer does not enforce `minimumLeadRounds` when submitting beacons.
Submission remains permissionless; commitment timing is a consumer security
responsibility.

## Running the daemon

Run commands from the repository root.

Install dependencies:

```sh
pnpm install
```

Build the workspace:

```sh
pnpm build
```

Or build only the relayer:

```sh
pnpm --filter @based-labs/drand-quicknet-relayer build
```

Configure the relayer using the root `.env`.

The daemon-specific configuration includes:

```text
QUICKNET_CONSUMERS
QUICKNET_START_BLOCK
QUICKNET_CHECKPOINT_FILE
QUICKNET_MAX_BLOCK_RANGE
QUICKNET_POLL_INTERVAL_MS
```

RPC/account configuration is supplied by the selected network configuration.

Example consumer configuration:

```sh
QUICKNET_CONSUMERS=0x1111111111111111111111111111111111111111
QUICKNET_START_BLOCK=123456
QUICKNET_CHECKPOINT_FILE=./state/checkpoint.json
QUICKNET_MAX_BLOCK_RANGE=2000
QUICKNET_POLL_INTERVAL_MS=1000
```

Then run:

```sh
pnpm --filter @based-labs/drand-quicknet-relayer \
  start daemon \
  --network robinhood-testnet
```

The daemon exits cleanly on `SIGINT` or `SIGTERM`.

### Logging

The default log level is `info`.

Set `QUICKNET_LOG_LEVEL=debug` to enable detailed daemon progress:

```sh
QUICKNET_LOG_LEVEL=debug \
pnpm --filter @based-labs/drand-quicknet-relayer \
  start daemon \
  --network robinhood-testnet
```

Important structured events include:

* `round_imported`
* `durable_head_regressed`
* `consumer_failed`
* `heartbeat`
* `checkpoint_advanced`
* `round_already_stored`

`round_imported` and `heartbeat` are emitted at info level.

`checkpoint_advanced` and `round_already_stored` are emitted at debug level.

`durable_head_regressed` is emitted at warn level.

`consumer_failed` is emitted at error level.

A temporary durable-head regression does not mark the consumer as failed.
The consumer remains healthy unless request processing itself fails.

## Docker

The relayer can also be run as a production container.

The image is chain-agnostic. Network selection, RPC configuration, signer
credentials, consumers, and checkpoint state are supplied at runtime rather
than baked into the image.

### Building the image

Build from the repository root:

```sh
docker build \
  -f apps/relayer/Dockerfile \
  -t drand-quicknet-relayer .
```

The image entrypoint is the relayer CLI. Commands are passed directly to the
container.

For example:

```sh
docker run --rm \
  drand-quicknet-relayer \
  --help
```

### Running the daemon

Create a persistent Docker volume for checkpoint state:

```sh
docker volume create quicknet-relayer-state
```

Then run the daemon:

```sh
docker run \
  --detach \
  --name quicknet-relayer \
  --env-file .env \
  -v quicknet-relayer-state:/state \
  drand-quicknet-relayer \
  daemon \
  --network robinhood-testnet
```

The container defaults to:

```text
QUICKNET_CHECKPOINT_FILE=/state/checkpoint.json
```

Checkpoint state should be persisted outside the disposable container
filesystem.

Each independently operated relayer instance should use its own checkpoint
volume. Do not share one checkpoint volume between concurrently running
relayers.

The relayer process runs as the non-root `node` user. Fresh Docker named
volumes mounted at `/state` are initialized with suitable ownership.

When using a host bind mount instead of a named volume, the host directory
must be writable by UID `1000`.

### Logs and shutdown

Logs are written to stdout/stderr:

```sh
docker logs -f quicknet-relayer
```

Detailed logging can be enabled at runtime with:

```sh
-e QUICKNET_LOG_LEVEL=debug
```

Stop the daemon with:

```sh
docker stop quicknet-relayer
```

Docker sends `SIGTERM`, which the daemon handles gracefully before exiting
and releasing its checkpoint lock.

A stopped container can be restarted with:

```sh
docker start quicknet-relayer
```

When a durable checkpoint already exists, it takes precedence over the
configured initial start block.

### Built-in deployments

Canonical deployment manifests required by built-in network presets are
packaged with the image.

The image does not select a network at build time. Network selection and
operator-specific configuration are provided at runtime. The same image can
therefore be used with any supported built-in or custom EVM network
configuration.

## Choosing `QUICKNET_START_BLOCK`

For a new consumer, set `QUICKNET_START_BLOCK` to the first block from which request events may exist.

For a newly deployed consumer, this can normally be its deployment block.

Do not set the start block later than requests that still need to be processed.

Once a durable checkpoint exists for the consumer, the checkpoint takes precedence over the configured initial start block.

## Request processing

For each scan range, the relayer:

```text
scan events
    │
    ▼
collect requested rounds
    │
    ▼
deduplicate rounds
    │
    ▼
for each exact round
    │
    ├── already stored ───────────► success
    │
    └── missing
          │
          ▼
      fetch exact drand round
          │
          ▼
      use canonical signature
          │
          ▼
      simulate transaction
          │
          ▼
      broadcast
```

Requests are processed sequentially.

If processing a durable range fails, the durable checkpoint is not advanced past that range.

## Drand endpoint failover

The Quicknet package supports multiple public drand endpoints:

```text
https://api.drand.sh/v2
https://api2.drand.sh/v2
https://api3.drand.sh/v2
```

Failover still fetches the exact requested round.

Changing endpoints never permits changing rounds.

## Signature handling

The relayer forwards the canonical 48-byte compressed BLS signature returned
for the requested Quicknet round unchanged to `DrandQuicknetBeaconRegistry`.

The registry delegates cryptographic verification to
`DrandQuicknetBeaconVerifier`:

```text
canonical 48-byte Quicknet signature
        │
        ▼
DrandQuicknetBeaconRegistry
        │
        ▼
DrandQuicknetBeaconVerifier.verifyBeacon(round, signature)
        │
        ├── invalid ──► submission reverts
        │
        └── valid
              │
              ▼
        sha256(signature)
              │
              ▼
       official drand randomness
```

For a valid Quicknet beacon, the randomness stored by the registry is exactly
the official drand randomness derived as `sha256(signature)`.

The relayer simulates the registry transaction before broadcasting it.

This protects the relayer account from spending gas on a transaction that is
already known to revert. Cryptographic correctness remains enforced on-chain
by the verifier rather than trusted to the relayer.

## Transaction retry policy

Do not blindly retry transactions after an ambiguous broadcast result.

If a broadcast times out or the RPC response is uncertain, first determine whether the transaction was accepted or whether the beacon is already stored.

Because the registry is permissionless and idempotent, another relayer may also import the same beacon while recovery is occurring.

Always re-check chain state before submitting another transaction.

## Testing

Run the relayer test suite:

```sh
pnpm --filter @based-labs/drand-quicknet-relayer test
```

Run TypeScript checks:

```sh
pnpm --filter @based-labs/drand-quicknet-relayer typecheck
```

Build:

```sh
pnpm --filter @based-labs/drand-quicknet-relayer build
```

Before release, all three should pass:

```sh
pnpm --filter @based-labs/drand-quicknet-relayer test
pnpm --filter @based-labs/drand-quicknet-relayer typecheck
pnpm --filter @based-labs/drand-quicknet-relayer build
```

## Live finality smoke test

The Robinhood Testnet daemon has been tested against the network's `latest`, `safe`, and `finalized` RPC heads.

Observed behavior confirmed:

```text
finalized <= safe <= latest
```

and both `safe` and `finalized` advance over time.

The finality-aware smoke test exercised the following sequence:

```text
request emitted above safe
        │
        ▼
soft scanner discovered request
        │
        ▼
beacon imported immediately
        │
        ▼
no unsafe checkpoint written
        │
        ▼
daemon restarted
        │
        ▼
non-durable history replayed
        │
        ▼
no duplicate import transaction
        │
        ▼
request block reached safe
        │
        ▼
durable scanner replayed request
        │
        ▼
checkpoint advanced past request
```

One test run produced:

```text
target round:         31226127
request block:        99705911
safe after request:   99702754
safe final:           99706402
checkpoint nextBlock: 99706403
```

The beacon was imported while:

```text
request block > safe
```

and the final checkpoint satisfied:

```text
checkpoint nextBlock > request block
checkpoint nextBlock = safe + 1
```

This validated both low-latency soft processing and durable canonical replay.

### Durable-head regression recovery

Robinhood Testnet public RPC infrastructure has also been observed returning
temporarily non-monotonic `safe` heads across successive requests.

In one live daemon run:

```text
checkpoint advanced through:  109638509
persisted nextBlock:          109638510
later reported safe head:     109636509
```

The daemon emitted: `durable_head_regressed` without `consumer_failed`.

Soft/latest processing continued, and when the durable RPC view recovered,
the daemon resumed from `fromBlock = 109638510` rather than rewinding or
skipping durable history.

The consumer remained healthy throughout the regression.

## Finality policies

The relayer supports several finality policy primitives:

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

The appropriate policy is selected as part of the supported network configuration.

It should not be selected casually by an operator because it is part of the relayer's durability assumptions.

### `safe`

Uses the RPC `safe` block tag.

### `finalized`

Uses the RPC `finalized` block tag.

### `confirmations`

Uses a block-depth policy relative to `latest`.

This exists for chains where meaningful `safe` or `finalized` tags are unavailable.

A supported network should only use a finality mechanism whose semantics have been verified for that network and RPC infrastructure.

## Registry verification

Before starting, the relayer verifies the complete configured
registry-to-verifier deployment identity.

The registry SDK represents the trusted deployment as:

```ts
interface RegistryDeployment {
  chainId: number;
  address: Address;
  runtimeCodehash: Hex;
  verifierAddress: Address;
  verifierRuntimeCodehash: Hex;
  minimumLeadRounds: bigint;
}
```

The relayer verifies:

```text
connected chain ID matches
        │
        ▼
registry exists
        │
        ▼
registry runtime codehash matches
        │
        ▼
registry verifier() matches expected verifier
        │
        ▼
registry verifierCodehash() matches expected verifier codehash
        │
        ▼
registry minimumLeadRounds() matches expected value
        │
        ▼
verifier exists
        │
        ▼
verifier runtime codehash matches
```

The registry runtime bytecode is authenticated before the relayer trusts
values returned by `verifier()`, `verifierCodehash()`, or
`minimumLeadRounds()`.

This prevents the relayer from silently servicing a registry or verifier that
does not match the trusted deployment manifest.

`minimumLeadRounds` is authenticated deployment metadata. It does not restrict
permissionless beacon submission and is not used by the relayer to decide
whether a requested round may be imported.

The deployment manifest is part of the relayer's trust root. Runtime
verification proves that the deployed contracts match the supplied manifest;
it does not independently establish that the manifest itself identifies the
canonical deployment intended by the operator.

## Verifier trust

The registry relies on an immutable external `DrandQuicknetBeaconVerifier`
deployment.

The registry pins the verifier address and runtime codehash. The deployment
manifest independently specifies the expected verifier address and runtime
codehash, and the relayer verifies both relationships before operating.

The verifier implementation is maintained as part of this repository and
uses a pinned `bls-solidity` dependency for BLS12-381 operations.

A runtime codehash is only a meaningful identity guarantee for immutable
runtime behavior. Accepted verifier deployments should therefore be
non-upgradeable and should not expose mutable security-critical configuration.

Verifier changes should be represented as new trusted deployments rather than
silently changing the verifier behind an existing registry.

Verifier compatibility is also an execution-environment property. A target
EVM chain must provide the precompiles and semantics required by the verifier.
Support for a deployment should therefore be validated on each target EVM
chain rather than inferred solely from bytecode identity.

## Multiple relayers

Running more than one relayer is encouraged for liveness.

Relayers do not require coordination.

Example:

```text
relayer A ──┐
            ├──► same permissionless registry
relayer B ──┤
            │
relayer C ──┘
```

If two relayers observe the same request:

1. both may fetch the same beacon
2. one may store it first
3. the other observes the beacon is already stored
4. both converge on the same registry state

No relayer leader election is required.

For a production deployment, each relayer process should maintain its own checkpoint state.

Do not share one checkpoint file between concurrently running processes.

## Operational assumptions

The daemon uses a checkpoint lock to prevent concurrent relayer processes from
owning the same checkpoint lineage.

The checkpoint file remains local single-process state rather than a
distributed coordination mechanism. Separate relayer operators should use
independent checkpoint files.

Production operators should also monitor:

- RPC availability
- drand endpoint availability
- relayer account balance
- `consumer_failed`
- `durable_head_regressed`
- `round_imported`
- checkpoint advancement
- distance between `latest` and the durable head
- distance between the durable head and durable checkpoint
- requests that remain unprocessed
- daemon heartbeat/process health

## Liveness vs fairness

The relayer solves a liveness problem: get the already-selected public beacon onto the destination chain.

It does not solve the consumer's fairness problem by itself.

Consumer protocols must independently guarantee that:

- all outcome-sensitive inputs are committed before randomness is knowable
- the exact target round is fixed in advance
- settlement cannot substitute another round
- failure recovery cannot create a reroll
- refunds or termination rules cannot be selectively abused

The relayer should remain a narrow infrastructure component rather than becoming an application-level settlement authority.

## Application finality is separate

Relayer checkpoint finality and application commitment finality are different concerns.

The relayer may safely act on a request observed at `latest` because importing a valid public drand beacon is harmless even if the request is later orphaned.

That does **not** automatically mean an application commitment observed at `latest` is sufficiently final for fairness.

For applications where a commitment must be L1-backed before the target beacon becomes knowable, the consumer must choose a target round far enough in the future to satisfy that requirement.

A three-second Quicknet period should not be confused with a three-second commitment-finality guarantee.

## Design principles

The relayer follows a few intentionally strict rules:

1. **Exact rounds only.**
2. **No randomness substitution.**
3. **No relayer permissioning required by the protocol.**
4. **Act quickly on soft history.**
5. **Persist only durable history.**
6. **Replay rather than guess after failure.**
7. **Make repeated imports harmless.**
8. **Verify configured contracts before operating.**
9. **Simulate before spending gas.**
10. **Keep application settlement outside the relayer.**

The result is a small, permissionless service whose failure mode is primarily delayed liveness rather than biased randomness.
