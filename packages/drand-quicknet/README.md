# @based-labs/drand-quicknet

Utilities for fetching and working with [drand Quicknet](https://docs.drand.love/docs/quicknet/) randomness.

This package provides:

- Quicknet round/time calculations
- Beacon fetching with endpoint failover and cancellation
- Compressed signature parsing
- Signature witness generation for EVM submissions
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

`fetchBeacon()` tries the default Quicknet endpoints in order and returns
the first successful response.

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

### Cancel a fetch

Both fetching functions accept an optional `AbortSignal`:

```ts
import {
  fetchBeacon,
} from '@based-labs/drand-quicknet';

const beacon = await fetchBeacon(
  31_250_000n,
  undefined,
  { signal: AbortSignal.timeout(10_000) },
);
```

Passing `undefined` for the endpoint list uses the default endpoints.
Cancellation stops the active request and further endpoint attempts.

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

The parser accepts exactly 96 hexadecimal characters (48 bytes), without
a `0x` prefix. It returns a lowercase, `0x`-prefixed `CompressedSignature`.

Parsing checks the input type, length, and hexadecimal characters. It does 
not validate the encoded curve point or authenticate the signature.

### Create a signature witness

```ts
import {
  createSignatureWitness,
  fetchBeacon,
} from '@based-labs/drand-quicknet';

const beacon = await fetchBeacon(31_250_000n);
const witness = createSignatureWitness(beacon.signature);

console.log(witness.yHi);
console.log(witness.yLo);
```

`createSignatureWitness()` decompresses the signature and returns its
y-coordinate as two `bigint` values:

- `yHi`: the upper limb, suitable for Solidity `uint128`.
- `yLo`: the lower 256 bits, suitable for Solidity `uint256`.

The coordinate is reconstructed as `(yHi << 256n) | yLo`.

The helper validates canonical compressed encoding, rejects infinity,
and checks curve membership and prime-order subgroup membership. It
throws if the signature cannot produce a valid witness.

This validates the encoded point; it does not authenticate a signature
against a Quicknet round or public key.

Pass the original signature together with `yHi` and `yLo` to the registry
SDK's `simulateSubmitBeaconWithWitness()` or `submitBeaconWithWitness()`.
The registry verifies the beacon on-chain.

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

- `fetchBeacon(round, endpoints?, options?)`
- `fetchBeaconFromEndpoint(endpoint, round, options?)`
- `roundAt(timestamp)`
- `roundScheduledTime(round)`
- `parseCompressedSignature(signature)`
- `createSignatureWitness(signature)`

Fetching options accept `{ signal?: AbortSignal }`.

### Types

- `QuicknetBeacon`
- `CompressedSignature`
- `SignatureWitness`
- `Hex`

`QuicknetBeacon` contains `round` and `signature`. It does not include a
randomness field.

## Verification

The fetching functions check that the response contains the requested
round and a correctly formatted 48-byte signature.

`parseCompressedSignature()` validates hexadecimal format and length.
`createSignatureWitness()` additionally validates canonical point
encoding, curve membership, and prime-order subgroup membership.

Neither fetching, parsing, nor witness generation verifies that a
signature belongs to the requested round under the Quicknet public key.

For EVM applications, use the on-chain verifier through
[`@based-labs/drand-quicknet-registry`](https://www.npmjs.com/package/@based-labs/drand-quicknet-registry).

## License

MIT
