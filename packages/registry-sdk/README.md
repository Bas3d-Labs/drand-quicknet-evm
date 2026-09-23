# @based-labs/drand-quicknet-registry

TypeScript SDK for interacting with the Based Labs drand Quicknet EVM beacon registry.

The package provides:

- Registry ABI, including witness-assisted submission
- Typed registry and verifier deployment configuration
- Deployment verification
- Typed registry reads
- Compressed-signature and witness-assisted submission helpers

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

Anyone may submit a beacon through either method:

- `submitBeacon`: submits the canonical 48-byte compressed signature.
- `submitBeaconWithWitness`: submits the same compressed signature plus
  its y-coordinate limbs.

For an unstored round, both methods authenticate the beacon through the
configured on-chain verifier and store the same official drand randomness.
The witness assists verification; it does not replace signature
authentication.

For Quicknet, the stored randomness is SHA-256 of the canonical compressed
signature bytes, not the hexadecimal text.

Stored rounds are immutable and repeated submissions are idempotent.

Both methods share the same cache. For an already-stored round, they
return cached randomness without examining the signature or witness,
and do not emit another `BeaconStored` event.

A successful simulation for a stored round therefore does not validate
the supplied signature or witness.

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

`RegistryDeployment.create()` validates configuration field formats and
normalizes addresses. It does not contact the chain or authenticate the
deployment.

Read and write helpers do not automatically verify deployment identity.
Call `verifyRegistryDeployment()` or `registry.verifyDeployment()` before
using the configured registry. Configure the wallet client for the same
chain as the verified public client.

Deployment metadata is a trust root and should come from a trusted manifest
or other authenticated source.

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

The following examples also use `@based-labs/drand-quicknet`:

```bash
pnpm add @based-labs/drand-quicknet
```

The examples assume `publicClient`, `walletClient`, `account`, and a
verified `deployment` are configured for the intended chain.

### Submit with a witness

```ts
import {
  createSignatureWitness,
  fetchBeacon,
} from '@based-labs/drand-quicknet';

import {
  submitBeaconWithWitness,
} from '@based-labs/drand-quicknet-registry';

const beacon = await fetchBeacon(31_250_000n);
const witness = createSignatureWitness(beacon.signature);

const result = await submitBeaconWithWitness({
  publicClient,
  walletClient,
  deployment,
  account,
  round: beacon.round,
  signature: beacon.signature,
  yHi: witness.yHi,
  yLo: witness.yLo,
});
```

`yHi` and `yLo` are `bigint` values corresponding to Solidity `uint128`
and `uint256`. They reconstruct the signature's y-coordinate as
`(yHi << 256n) | yLo`.

Witness generation validates the encoded point locally. The on-chain
verifier authenticates the signature against the submitted round.

### Submit without a witness

```ts
import {
  fetchBeacon,
} from '@based-labs/drand-quicknet';

import {
  submitBeacon,
} from '@based-labs/drand-quicknet-registry';

const beacon = await fetchBeacon(31_250_000n);

const result = await submitBeacon({
  publicClient,
  walletClient,
  deployment,
  account,
  round: beacon.round,
  signature: beacon.signature,
});
```

Both methods accept `RegistrySignature`, an alias of the branded
`CompressedSignature` type exported by `@based-labs/drand-quicknet`.
Obtain it through `fetchBeacon()` or `parseCompressedSignature()`.

The TypeScript brand does not prove that a signature authenticates a
particular round.

### Simulate without broadcasting

```ts
import {
  createSignatureWitness,
  fetchBeacon,
} from '@based-labs/drand-quicknet';

import {
  simulateSubmitBeaconWithWitness,
} from '@based-labs/drand-quicknet-registry';

const beacon = await fetchBeacon(31_250_000n);
const witness = createSignatureWitness(beacon.signature);

const simulation = await simulateSubmitBeaconWithWitness({
  publicClient,
  deployment,
  account,
  round: beacon.round,
  signature: beacon.signature,
  yHi: witness.yHi,
  yLo: witness.yLo,
});

console.log(simulation.result);
```

`simulateSubmitBeacon()` provides the equivalent simulation without
witness arguments.

Both simulation helpers return Viem's simulation result, including
`request` and `result`. Neither broadcasts a transaction.

### Confirm a submission

Both submission helpers simulate before broadcasting and return:

- `hash`: the submitted transaction hash.
- `randomness`: the value returned by simulation.

They do not wait for a receipt. Returned randomness is a simulated
result, not confirmation that the transaction succeeded or stored a beacon.

After either submission example:

```ts
const receipt = await publicClient.waitForTransactionReceipt({
  hash: result.hash,
});

if (receipt.status !== 'success') {
  throw new Error('Beacon submission reverted.');
}

const registry = createRegistryReader({
  client: publicClient,
  deployment,
});

const storedRandomness = await registry.getBeacon(
  beacon.round,
  receipt.blockNumber,
);

if (
  storedRandomness.toLowerCase() !==
  result.randomness.toLowerCase()
) {
  throw new Error('Stored randomness does not match simulation.');
}
```

Import `createRegistryReader` from
`@based-labs/drand-quicknet-registry` when using this confirmation example.

### Fallback and retries

The SDK does not generate witnesses automatically, select a submission
method, fall back between methods, or retry failed submissions.

Applications own fallback and transaction-reconciliation policy.
An unsuccessful witness attempt does not permanently invalidate a round.

Independent relayers may submit the same round without overwriting stored
randomness. Duplicate transactions can still consume gas, and processes
sharing a signer must coordinate nonces.

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

## Network support

The SDK is chain-agnostic. Configure public and wallet clients for the
target EVM chain and supply a trusted `RegistryDeployment` for that chain.

Using the SDK requires a compatible registry and verifier deployment.
SDK compatibility alone does not establish that a chain supports the
verifier's required precompiles or satisfies an application's timing and
finality requirements.

Network-specific deployment records, security profiles, and operational
guidance belong in the deployment repository.

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
- `simulateSubmitBeaconWithWitness(options)`
- `submitBeaconWithWitness(options)`

### Deployment configuration

- `RegistryDeployment.create(options)`

### ABI

- `drandQuicknetBeaconRegistryAbi`

### Types

- `RegistryDeployment`
- `CreateRegistryDeploymentOptions`
- `RegistrySignature`
- `SimulateSubmitBeaconOptions`
- `SubmitBeaconOptions`
- `SimulateSubmitBeaconWithWitnessOptions`
- `SubmitBeaconWithWitnessOptions`

## Testing

```sh
pnpm --filter @based-labs/drand-quicknet-registry test
pnpm --filter @based-labs/drand-quicknet-registry typecheck
pnpm --filter @based-labs/drand-quicknet-registry build
```

## License

MIT
