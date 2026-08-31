# @based-labs/drand-quicknet

Utilities for fetching and working with [drand Quicknet](https://docs.drand.love/docs/quicknet/) randomness.

This package provides:

- Quicknet round/time calculations
- Beacon fetching with endpoint failover
- Compressed signature parsing
- Quicknet constants and types

## Installation

```bash
pnpm add @based-labs/drand-quicknet
```

Requires Node.js 24 or later.

## Usage

### Fetch a beacon

```ts
import {
  fetchBeacon,
} from '@based-labs/drand-quicknet';

const beacon = await fetchBeacon(31_250_000n);

console.log(beacon.round);
console.log(beacon.signature);
```

`fetchBeacon()` tries the default Quicknet endpoints in order and returns the first successful response.

You can provide your own endpoint list:

```ts
const beacon = await fetchBeacon(
  31_250_000n,
  [
    'https://example.com/v2',
  ],
);
```

### Fetch from a specific endpoint

```ts
import {
  fetchBeaconFromEndpoint,
} from '@based-labs/drand-quicknet';

const beacon = await fetchBeaconFromEndpoint(
  'https://api.drand.sh/v2',
  31_250_000n,
);
```

### Round calculations

```ts
import {
  roundAt,
  roundScheduledTime,
} from '@based-labs/drand-quicknet';

const round =
  roundAt(
    BigInt(Math.floor(Date.now() / 1000)),
  );

const scheduledTime = roundScheduledTime(round);
```

`roundAt()` returns `0n` for timestamps before the Quicknet genesis timestamp.

`roundScheduledTime()` throws for round `0n`.

### Parse a compressed signature

```ts
import {
  parseCompressedSignature,
} from '@based-labs/drand-quicknet';

const signature = parseCompressedSignature('...');
```

The parser validates that the value is a 48-byte hexadecimal Quicknet signature and returns a branded `CompressedSignature`.

## Constants

```ts
import {
  QUICKNET_ENDPOINTS,
  QUICKNET_GENESIS_TIMESTAMP,
  QUICKNET_PERIOD_SECONDS,
} from '@based-labs/drand-quicknet';
```

Current exported values include:

- `QUICKNET_GENESIS_TIMESTAMP`
- `QUICKNET_PERIOD_SECONDS`
- `QUICKNET_ENDPOINTS`

Quicknet currently uses a 3-second period.

## API

### Functions

- `fetchBeacon(round, endpoints?)`
- `fetchBeaconFromEndpoint(endpoint, round)`
- `roundAt(timestamp)`
- `roundScheduledTime(round)`
- `parseCompressedSignature(signature)`

### Types

- `QuicknetBeacon`
- `CompressedSignature`
- `Hex`

## Verification

This package fetches Quicknet beacon data and validates its expected shape,
including canonical 48-byte compressed signatures. It does **not**
cryptographically verify beacon signatures.

For EVM applications using the Based Labs Quicknet beacon registry, see
[`@based-labs/drand-quicknet-registry`](https://www.npmjs.com/package/@based-labs/drand-quicknet-registry).

## License

MIT
