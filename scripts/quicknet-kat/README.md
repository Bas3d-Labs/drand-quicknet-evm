# Expanded Quicknet KAT corpus

This is additional verifier hardening. The existing constructor's two-sided
self-test and unit/fuzz/gas coverage remain in place.

`contracts/test/fixtures/quicknet-kat.json` is the shared, deterministic input to
the Foundry suite and an independent Noble BLS audit. Both run offline after
their tooling/dependencies are installed. Neither uses RPC, FFI, a live beacon,
the relayer, or a local round clock.

## Run

From the repository root:

```sh
forge test --root contracts --match-contract DrandQuicknetBeaconVerifierKatTest -vv
pnpm install --frozen-lockfile
pnpm --filter quicknet-kat-audit test
```

The Foundry suite also runs through the existing `pnpm test:contracts` CI path.
The Noble audit is a private pnpm workspace package and runs through the
existing `pnpm -r test` path, so both suites are included in `pnpm check`.
Its exact Noble version is declared in this directory's package manifest;
dependency resolution and integrity hashes are recorded in the root
`pnpm-lock.yaml`. It introduces no runtime dependency to the verifier, SDK,
or relayer.

## Corpus and provenance

The 12 real Quicknet rounds are:

`1, 2, 255, 256, 1000, 13335, 65535, 65536, 16777215, 16777216, 20791007, 31089008`.

These cover early rounds, adjacent one/two/three-byte serialization boundaries,
the existing constructor and field-alias regression rounds, and later rounds.
They are historical fixed rounds, not a claim about the current beacon head.

For each round, the signature and expected randomness were copied from matching
responses at both of these chain-hash-pinned endpoints:

- `https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/{round}`
- `https://api2.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/{round}`

The fixture records acquisition time and SHA-256 hashes of the exact response
bytes, in endpoint order. Response hashes are acquisition records; whitespace
or JSON field-order changes upstream can change them without changing a beacon.
Published `randomness` is retained as a literal expected answer, not generated
by the implementation under test. To recheck a particular source:

```sh
curl --fail --silent --show-error \
  'https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/1000'
```

The two HTTP endpoints mirror the same drand network. Agreement is a retrieval
cross-check, not two independent cryptographic implementations. Independence
comes from running the same corpus through Solidity/BLS2/EIP-2537 and
`@noble/curves` 2.4.0. The audit imports no project cryptographic helpers. It
checks signatures against the fixed Quicknet public key, using SHA-256 of the
eight-byte big-endian round and the explicit Quicknet G1 NUL DST. See the
[drand protocol specification](https://docs.drand.love/docs/specification/) and
[Noble implementation](https://github.com/paulmillr/noble-curves/tree/2.4.0).

The fixture's `uncompressed` coordinates were obtained independently from Noble.
Foundry compares BLS2 decompression against those fixed bytes, and Noble repeats
the comparison. These are raw 48-byte x followed by 48-byte y; the verifier's
public API still rejects 96-byte inputs.

## Rejection coverage

Thirty-one fixed negatives record their exact bytes, round, expected encoding
canonicality, and derivation:

- Zero, wrong, and maximum uint64 rounds with a real signature.
- Empty, truncated, appended, concatenated, and genuine uncompressed inputs.
- Compression and infinity flags, all-zero and all-ones encodings.
- Field boundaries `p-1`, `p`, `p+1`, maximum 381-bit x, and an `x+p` alias.
- Both signs of the off-curve candidate `x=1`: `x^3+4=5` is a quadratic
  nonresidue in the BLS12-381 base field.
- Both signs of the order-three points `(0, ±2)`, outside the prime-order G1
  subgroup.
- Sign and coordinate bit corruption, plus an unrelated valid subgroup point.
- A published quicknet-t round-1000 signature under a different network key.

Every rejected call must complete with `(false, bytes32(0))`. A revert fails the
Foundry test. Encoding canonicality is checked separately so a subgroup or
pairing rejection cannot be silently replaced by an encoding-only rejection.

Both implementations also reject each positive signature at `round+2^(8*i)`
for each byte index `i` from 0 through 7, and after a sign-bit flip: 108 further
deterministic negative checks. The round variants exercise all eight input bytes; they
are intentionally invalid pairings, not invented future Quicknet beacons.

The fixed counts and contiguous vector keys protect against accidental corpus
shrinkage. Expected outputs must be reviewed against upstream responses and the
independent audit when updating fixtures. Never regenerate expected answers by
calling the Solidity verifier.

## Cross-network wrong-key vector

Negative `v30` is a published `quicknet-t` beacon for round 1000. Its chain
information and beacon were retrieved from the chain-hash-pinned
`https://pl-us.testnet.drand.sh/cc9c398442737cbd141526600919edd69f1d6f9b4adb67e4d912fbc64341a9a5`
endpoint. The chain hash, public key, and scheme were also checked against
[the official drand client defaults at a pinned commit](https://github.com/drand/drand-client/blob/b9572b2ef11d28d5c011144867ca8d27bece23e2/lib/defaults.ts).

The vector records its source key, scheme, published randomness, URLs,
acquisition time, and response hashes in `source`. This source record is
separate from the dual-endpoint provenance of the 12 Quicknet positives.

The Noble audit requires acceptance under the pinned source key using the same
round serialization and Quicknet DST, and checks the published randomness hash.
Both Noble and Solidity require rejection under the Quicknet key; Solidity
also requires encoding canonicality and `(false, bytes32(0))` without a revert.
Source-key acceptance runs explicitly for `v30` and cannot be skipped by
removing its source metadata. This adds one fixed negative and one source-key
acceptance check; the 12 Quicknet positives and 108 derived negatives are unchanged.

This corpus does not establish every EVM client's precompile compatibility or
replace deployment canaries. A third implementation such as drand's Go stack
can be added later; no Go differential run is claimed here.
