# @based-labs/drand-quicknet-registry

TypeScript SDK for interacting with the Based Labs drand Quicknet EVM beacon registry.

The package provides:

- Registry ABI
- Registry deployment validation
- Typed registry reads
- Beacon submission simulation
- Beacon submission
- Registry deployment and signature types

Built on [Viem](https://viem.sh/).

## Installation

```bash
pnpm add @based-labs/drand-quicknet-registry
```

Requires Node.js 24 or later.

## Registry deployment

Registry operations use a `RegistryDeployment` containing:

- chain ID
- registry address
- expected runtime codehash

Create one with:

```ts
import {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

const deployment =
  RegistryDeployment.create({
    chainId: 46630,
    address: '0x...',
    runtimeCodehash: '0x...',
  });
```

`RegistryDeployment.create()` validates and normalizes the deployment metadata.

## Verify a deployment

Before relying on a configured registry, verify that:

1. the connected chain matches the expected chain ID;
2. code exists at the configured registry address; and
3. the deployed runtime codehash matches the expected codehash.

```ts
import {
  createPublicClient,
  http,
} from 'viem';

import {
  verifyRegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

const publicClient =
  createPublicClient({
    transport: http(process.env.RPC_URL),
  });

await verifyRegistryDeployment(
  publicClient,
  deployment,
);
```

A mismatch causes the call to throw.

## Read from the registry

Create a registry reader:

```ts
import {
  createRegistryReader,
} from '@based-labs/drand-quicknet-registry';

const registry =
  createRegistryReader({
    client: publicClient,
    deployment,
  });
```

### Verify the configured deployment

```ts
await registry.verifyDeployment();
```

### Check whether a round is stored

```ts
const stored = await registry.isStored(31_250_000n);
```

### Read a beacon

```ts
const randomness = await registry.getBeacon(31_250_000n);
```

`getBeacon()` reads the exact requested round. If that round is unavailable, the registry call reverts.

If absence is expected, call `isStored()` first.

A specific block can also be pinned:

```ts
const randomness =
  await registry.getBeacon(
    31_250_000n,
    100_000_000n,
  );
```

### Read Quicknet schedule information

```ts
const latestRound = await registry.latestScheduledRound();

const timestamp =
  await registry.roundScheduledTime(
    latestRound,
  );

const round = await registry.roundAt(timestamp);
```

### Read the configured oracle

```ts
const oracle = await registry.oracle();
```

## Submit a beacon

The registry accepts both compressed and uncompressed Quicknet signatures.

Fetch a compressed beacon with `@based-labs/drand-quicknet`:

```ts
import {
  fetchBeacon,
} from '@based-labs/drand-quicknet';

const beacon = await fetchBeacon(31_250_000n);
```

### Simulate before submitting

```ts
import {
  simulateSubmitBeacon,
} from '@based-labs/drand-quicknet-registry';

const simulation =
  await simulateSubmitBeacon({
    publicClient,
    deployment,
    account,
    round: beacon.round,
    signature: beacon.signature,
  });
```

### Submit

```ts
import {
  submitBeacon,
} from '@based-labs/drand-quicknet-registry';

const result =
  await submitBeacon({
    publicClient,
    walletClient,
    deployment,
    account,
    round: beacon.round,
    signature:
      beacon.signature,
  });

console.log(result.hash);
console.log(result.randomness);
```

`submitBeacon()` simulates the contract call before broadcasting it.

The returned value contains:

```ts
{
  hash;
  randomness;
}
```

where `hash` is the submitted transaction hash and `randomness` is the randomness returned by the simulated registry call.

## ABI

The registry ABI is exported directly:

```ts
import {
  drandQuicknetBeaconRegistryAbi,
} from '@based-labs/drand-quicknet-registry';
```

This can be used with Viem directly when the higher-level helpers do not cover a particular use case.

## API

### Reads

- `createRegistryReader(options)`
- `verifyRegistryDeployment(client, deployment)`

The registry reader exposes:

- `verifyDeployment()`
- `oracle()`
- `isStored(round)`
- `getBeacon(round, blockNumber?)`
- `roundAt(timestamp)`
- `roundScheduledTime(round)`
- `latestScheduledRound()`

### Writes

- `simulateSubmitBeacon(options)`
- `submitBeacon(options)`

### Exports

- `drandQuicknetBeaconRegistryAbi`
- `RegistryDeployment`
- `RegistrySignature`

## Exact-round semantics

The registry is designed around exact Quicknet rounds.

Applications should commit to the round they intend to use and later read that same round. They should not substitute a different available round if the requested round has not yet been stored.

This is particularly important for randomness consumers, where substituting rounds can change the resulting outcome.

## License

MIT
