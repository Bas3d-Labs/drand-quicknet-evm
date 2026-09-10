# @based-labs/drand-quicknet-registry

TypeScript SDK for interacting with the Based Labs drand Quicknet EVM beacon registry.

The package provides:

- Registry ABI
- Trusted registry and verifier deployment metadata
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
round -> official drand randomness
```

Anyone may submit a beacon. For an unstored round, the registry verifies the
canonical 48-byte Quicknet signature through its configured on-chain verifier
and stores the official drand randomness returned by that verifier.

For Quicknet, the stored randomness is:

```ts
    sha256(canonical signature)
```

Stored rounds are immutable and repeated submissions are idempotent.

Applications should commit to an exact future round before it becomes knowable
and later settle using that same round. A missing round is a liveness
condition, not permission to substitute another round.

The registry address alone is not the complete deployment identity. A trusted
deployment pins:

- chain ID
- registry address
- registry runtime codehash
- verifier address
- verifier runtime codehash

Chain-specific policy such as the expected `minimumLeadRounds` belongs in the
chain-security profile rather than in deployment identity.

## Registry deployment

Registry operations use a `RegistryDeployment`:

```ts
interface RegistryDeployment {
  chainId: number;
  address: Address;
  runtimeCodehash: Hex;
  verifierAddress: Address;
  verifierRuntimeCodehash: Hex;
}
```

Create one with:

```ts
import {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

const deployment =
  RegistryDeployment.create({
    chainId: <chain id>,
    address: '<registry address>',
    runtimeCodehash: '<registry runtime codehash>',
    verifierAddress: '<verifier address>',
    verifierRuntimeCodehash: '<verifier runtime codehash>',
  });
```

Deployment metadata is a trust root and should come from a trusted manifest or
other authenticated source.

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
4. registry `verifier()` matches the trusted verifier address
5. registry `verifierCodehash()` matches the trusted verifier codehash
6. verifier code exists
7. verifier runtime codehash matches

Registry runtime authentication occurs before registry configuration getters
are trusted.

A successful check verifies that the connected chain contains the registry and
verifier described by the supplied trust root. It does not establish that the
trust root itself is canonical.

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

Read the configured verifier:

```ts
const verifier =
  await registry.verifier();

const verifierCodehash =
  await registry.verifierCodehash();

const minimumLeadRounds =
  await registry.minimumLeadRounds();
```

`registry.minimumLeadRounds()` reads the immutable consumer floor from the live
registry. The expected network policy is intentionally not stored in
`RegistryDeployment`; chain-profile security tooling owns the comparison
between normative policy and live registry state.

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
  signature: beacon.signature,
});

const result =
  await submitBeacon({
    publicClient,
    walletClient,
    deployment,
    account,
    round: beacon.round,
    signature: beacon.signature,
  });
```

The registry SDK accepts canonical compressed Quicknet signatures.

`submitBeacon()` simulates before broadcasting and returns the transaction hash
and official drand randomness.

Multiple independent relayers may safely submit the same round. The registry
is permissionless and idempotent.

## Consumer safety

The registry does not enforce application commitment timing.

`minimumLeadRounds` is an immutable registry consumer-safety floor, not a
restriction on beacon submission. Its expected network value belongs to the
chain-security profile rather than deployment identity metadata.

Consumers should:

- authenticate the registry deployment before trusting its configuration
- require the registry minimum lead to satisfy their own local safety floor
- commit to an exact future round before it becomes knowable
- fix all outcome-sensitive inputs before the commitment
- settle only from the committed round
- never reroll or substitute another round
- domain-separate application seeds with a unique request identifier

For example:

```solidity
bytes32 seed = keccak256(
    abi.encode(
        QUICKNET_SEED_DOMAIN,
        applicationDomain,
        block.chainid,
        address(this),
        uniqueRequestId,
        round,
        randomness
    )
);
```

## Deployment manifest

A trusted deployment manifest represents durable registry and verifier identity
and provenance. For example:

```json
{
  "manifestVersion": 1,
  "network": "<network name>",
  "chainId": 12345,
  "registry": {
    "address": "<registry address>",
    "runtimeCodehash": "<registry runtime codehash>",
    "deployment": {
      "transactionHash": "<deployment transaction>",
      "blockNumber": 0
    }
  },
  "verifier": {
    "address": "<verifier address>",
    "runtimeCodehash": "<verifier runtime codehash>",
    "deployment": {
      "transactionHash": "<deployment transaction>",
      "blockNumber": 0
    }
  }
}
```

The verifier is intentionally separate because it is independently deployed
and independently attested.

Policy values such as the expected registry `minimumLeadRounds` are not part of
the deployment manifest. The chain profile is the normative policy source; the
live registry is the runtime source; the security checker compares the two.

The verifier Solidity implementation is not bundled into this package.

## Robinhood Testnet

Use the repository deployment manifest as the trusted deployment-identity record
for the current Robinhood Testnet verifier and registry deployments.

Quicknet schedule:

```text
chain ID: 46630
genesis timestamp: 1692803367
period: 3 seconds
```

Use the corresponding chain-security profile for normative network policy and
the deployment manifest for artifact identity.

## API

### Reads

- `createRegistryReader(options)`
- `verifyRegistryDeployment(client, deployment)`
- `verifyDeployment()`
- `verifier()`
- `verifierCodehash()`
- `minimumLeadRounds()`
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
