# @based-labs/drand-quicknet-registry

TypeScript SDK for interacting with the Based Labs drand Quicknet EVM beacon registry.

The package provides:

- Registry ABI
- Trusted registry and oracle deployment metadata
- Deployment verification
- Typed registry reads
- Beacon submission simulation and submission

Built on [Viem](https://viem.sh/).

## Installation

```bash
pnpm add @based-labs/drand-quicknet-registry
```

Requires Node.js 24 or later.

## Security model

The registry is a permissionless cache of verified drand Quicknet randomness keyed by exact round:

```text
round -> normalized randomness
```

Anyone may submit a beacon. For an unstored round, the registry verifies the drand signature through its configured on-chain oracle before storing the normalized randomness.

Stored rounds are immutable and repeated submissions are idempotent.

Applications should commit to an exact future round before it becomes knowable and later settle using that same round. A missing round is a liveness condition, not permission to substitute another round.

The registry address alone is not the complete trust root. A trusted deployment pins:

- chain ID
- registry address
- registry runtime codehash
- oracle address
- oracle runtime codehash

## Registry deployment

Registry operations use a `RegistryDeployment`:

```ts
interface RegistryDeployment {
  chainId: number;
  address: Address;
  runtimeCodehash: Hex;
  oracleAddress: Address;
  oracleRuntimeCodehash: Hex;
}
```

Create one with:

```ts
import {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

const deployment =
  RegistryDeployment.create({
    chainId: 46_630,
    address: '0xEc2a718F4D1B18c8315794A24Fe90622400A40de',
    runtimeCodehash: '0x19ef2338aa49f196ed6ceea377ee52c8674899edb2280f20145768cf30c8f699',
    oracleAddress: '0x692100c4863adAED9f560F6Ce982cF878F083e93',
    oracleRuntimeCodehash: '0x78faa56ca608db8a19cfb3bb052f11fedbaa14fb1ce74db58044db99246b4cfc',
  });
```

Deployment metadata is a trust root and should come from a trusted manifest or other authenticated source.

## Verify a deployment

Before using a configured registry, verify the full deployment:

```ts
import {
  verifyRegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

await verifyRegistryDeployment(
  publicClient,
  deployment,
);
```

Verification checks:

1. the connected chain ID
2. registry code exists
3. registry runtime codehash matches
4. registry `oracle()` matches the trusted oracle address
5. registry `oracleCodehash()` matches the trusted oracle codehash
6. oracle code exists
7. oracle runtime codehash matches

A successful check verifies that the connected chain contains the registry and oracle described by the supplied trust root. It does not establish that the trust root itself is canonical.

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

Verify the configured deployment:

```ts
await registry.verifyDeployment();
```

Read the configured oracle:

```ts
const oracle =
  await registry.oracle();

const oracleCodehash =
  await registry.oracleCodehash();
```

Check whether a round is stored:

```ts
const stored =
  await registry.isStored(
    31_250_000n,
  );
```

Read an exact beacon:

```ts
const randomness =
  await registry.getBeacon(
    31_250_000n,
  );
```

`getBeacon()` reverts when the exact round is unavailable.

Read Quicknet schedule information:

```ts
const latestRound =
  await registry.latestScheduledRound();

const timestamp =
  await registry.roundScheduledTime(
    latestRound,
  );

const round =
  await registry.roundAt(
    timestamp,
  );
```

`latestScheduledRound()` is schedule information, not a fallback randomness API.

## Submit a beacon

Fetch a beacon with `@based-labs/drand-quicknet`, then simulate or submit it:

```ts
import {
  fetchBeacon,
} from '@based-labs/drand-quicknet';

import {
  simulateSubmitBeacon,
  submitBeacon,
} from '@based-labs/drand-quicknet-registry';

const beacon =
  await fetchBeacon(
    31_250_000n,
  );

await simulateSubmitBeacon({
  publicClient,
  deployment,
  account,
  round: beacon.round,
  signature:
    beacon.signature,
});

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
```

`submitBeacon()` simulates before broadcasting and returns the transaction hash and normalized randomness.

Multiple independent relayers may safely submit the same round. The registry is permissionless and idempotent.

## Consumer safety

The registry does not enforce application commitment timing.

Consumers should:

- commit to an exact future round before it becomes knowable
- fix all outcome-sensitive inputs before the commitment
- settle only from the committed round
- never reroll or substitute another round
- domain-separate application seeds with a unique request identifier

For example:

```solidity
bytes32 seed = keccak256(
    abi.encode(
        DOMAIN_TAG,
        block.chainid,
        address(this),
        uniqueRequestId,
        round,
        beacon
    )
);
```

## Deployment manifest

A trusted deployment manifest should represent the oracle and registry as separate deployed contracts:

```json
{
  "chainId": 46630,
  "network": "robinhood-testnet",
  "quicknet": {
    "genesisTimestamp": 1692803367,
    "periodSeconds": 3
  },
  "oracle": {
    "address": "0x692100c4863adAED9f560F6Ce982cF878F083e93",
    "runtimeCodehash": "0x78faa56ca608db8a19cfb3bb052f11fedbaa14fb1ce74db58044db99246b4cfc",
    "sourceRepository": "Zodomo/DrandVerifier",
    "sourceCommit": "ccf2336ae51efd85208b29e7b7a10cb53db2f01f"
  },
  "registry": {
    "address": "0xEc2a718F4D1B18c8315794A24Fe90622400A40de",
    "runtimeCodehash": "0x19ef2338aa49f196ed6ceea377ee52c8674899edb2280f20145768cf30c8f699",
    "deploymentTx": "0x8a0398a81b6e33349a70d4260860bc02830558e2a8c19aa49bc111574360a160",
    "deploymentBlock": 99860908,
    "sourceCommit": "d3d541edabc5f52c60b135c4a9b1f387440a3c54"
  }
}
```

The oracle is intentionally separate because it is independently deployed and independently attested.

The verifier Solidity implementation is not bundled into this package.

## Robinhood Testnet

```text
chain ID: 46630

registry:
0xEc2a718F4D1B18c8315794A24Fe90622400A40de

registry runtime codehash:
0x19ef2338aa49f196ed6ceea377ee52c8674899edb2280f20145768cf30c8f699

oracle:
0x692100c4863adAED9f560F6Ce982cF878F083e93

oracle runtime codehash:
0x78faa56ca608db8a19cfb3bb052f11fedbaa14fb1ce74db58044db99246b4cfc

Quicknet genesis timestamp: 1692803367
Quicknet period: 3 seconds
```

Use the repository deployment manifest as the complete trust-root record.

## API

### Reads

- `createRegistryReader(options)`
- `verifyRegistryDeployment(client, deployment)`
- `verifyDeployment()`
- `oracle()`
- `oracleCodehash()`
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

## Testing

```sh
pnpm --filter @based-labs/drand-quicknet-registry test
pnpm --filter @based-labs/drand-quicknet-registry typecheck
pnpm --filter @based-labs/drand-quicknet-registry build
```

## License

MIT
