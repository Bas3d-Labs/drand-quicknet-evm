# Quicknet verifier validation

This directory contains an offline Quicknet known-answer corpus audit and an
optional read-only target-chain conformance runner.

The verifier supports two entry points:

- `verifyBeacon`: decompresses the canonical signature on-chain.
- `verifyBeaconWithWitness`: accepts an untrusted y coordinate alongside the
  canonical compressed signature.

Both entry points return SHA-256 of the compressed signature on success.
Witness coordinates do not contribute to the randomness hash.

The constructor exercises acceptance and pairing-equation rejection through
both verification paths. Unit, fuzz, gas, corpus, and raw-precompile tests
provide additional coverage.

## Offline validation

`contracts/test/fixtures/quicknet-kat.json` is the shared, deterministic input
to the Foundry KAT suite and an independent Noble BLS audit.

These checks run offline after their tooling and dependencies are installed.
Neither requires RPC, FFI, live beacon retrieval, the relayer, or a local round
clock.

From the repository root:

```sh
pnpm install --frozen-lockfile

pnpm test:quicknet-kat

forge test \
  --root contracts \
  --match-contract 'DrandQuicknetBeaconVerifier.*Test' \
  -vv
```

The Foundry command runs the verifier unit/fuzz/gas tests and the KAT suite.
To run only the Foundry corpus tests:

```sh
forge test \
  --root contracts \
  --match-contract DrandQuicknetBeaconVerifierKatTest \
  -vv
```

The Foundry suites run through the existing `pnpm test:contracts` CI path.
The Noble audit is a private pnpm workspace package and runs through the
existing `pnpm -r test` path. Both are included in `pnpm check`.

The exact Noble version is declared in this directory's package manifest;
dependency resolution and integrity hashes are recorded in the root
`pnpm-lock.yaml`. The audit introduces no runtime dependency to the verifier,
SDK, or relayer.

The optional `verify-chain.mjs` runner is separate from these offline commands.

## Corpus and provenance

The 12 real Quicknet rounds are:

`1, 2, 255, 256, 1000, 13335, 65535, 65536, 16777215, 16777216, 20791007, 31089008`.

These cover early rounds, adjacent one/two/three-byte serialization boundaries,
the constructor and field-alias regression rounds, and later rounds.
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

This optional provenance check uses the network; the normal corpus audit does
not.

The two HTTP endpoints mirror the same drand network. Agreement is a retrieval
cross-check, not two independent cryptographic implementations. Independence
comes from running the corpus through Solidity/BLS2/EIP-2537 and
`@noble/curves` 2.4.0.

The Noble audit imports no project cryptographic helpers. It checks signatures
against the fixed Quicknet public key, using SHA-256 of the eight-byte
big-endian round and the explicit Quicknet G1 NUL DST. See the
[drand protocol specification](https://docs.drand.love/docs/specification/) and
[Noble implementation](https://github.com/paulmillr/noble-curves/tree/2.4.0).

The fixture's `uncompressed` coordinates were generated using Noble,
independently of the Solidity implementation. Foundry compares BLS2
decompression against those fixed bytes, and Noble repeats the comparison.

These coordinates are raw 48-byte x followed by 48-byte y. Both verifier entry
points require a 48-byte compressed signature. The witness entry point accepts
y separately as `uint128 yHi` and `uint256 yLo`.

## Compressed-signature rejection coverage

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

For these corpus tests, rejected verifier calls must complete with
`(false, bytes32(0))` under the supplied gas budget. A revert fails the test.
Insufficient gas and execution errors are covered separately; verification
calls are not guaranteed never to revert.

Encoding canonicality is checked separately from verification. Canonicality
alone does not establish curve membership, subgroup membership, or a valid
signature equation.

Each implementation also tests eight round mutations and one sign-bit flip
per positive signature: 108 derived compressed-signature negatives.

The existing Foundry compressed suite uses `round + 2^(8*i)`.
The Noble audit uses `round XOR 2^(8*i)`, as does the Foundry witness suite,
for byte indices 0 through 7. These exercise all eight serialized round-byte
positions, but the addition-based and XOR-based variants are not necessarily
identical rounds.

These are intentionally invalid verification attempts, not invented future
Quicknet beacons.

The Noble audit enforces fixed corpus counts and contiguous vector keys.
Foundry also checks the fixed positive and negative counts. Expected outputs
must be reviewed against upstream responses and the independent audit when
updating fixtures. Never regenerate expected answers by calling the Solidity
verifier.

## Witness verification coverage

The Foundry KAT suite obtains witness y coordinates directly from the fixed
`uncompressed` fixture bytes. It does not use BLS2 decompression to generate
positive witnesses.

For all 12 published rounds, the suite requires:

- Acceptance through both entry points.
- Identical randomness matching the published answer.
- Rejection after mutations in each serialized round-byte position.
- Rejection before pairing for an original signature with the opposite root.
- Rejection before pairing for a sign-flipped signature with the original root.
- Pairing-equation rejection for a sign-flipped signature with the opposite
  root, which is a consistently encoded negative signature.

The constructor signature, randomness, and witness constants are also compared
against the fixture.

The Foundry witness corpus tests reuse the 31 fixed negatives. For canonical
negative encodings, BLS2 supplies a candidate y. Those cases are regression
checks, not independent witness-generation evidence. Positive witness
coordinates remain independently sourced from the fixture.

The verifier unit suite separately covers:

- Zero rounds, invalid lengths and flags, and `x >= p`.
- Witness field bounds, including `y = p` and `y = p + 1`.
- Explicit rejection of the `(0, 0)` infinity representation.
- Sign binding and limb subtraction boundaries.
- Off-curve witnesses and non-subgroup points, including `(0, 2)`,
  `(0, p - 2)`, and the fixed `x = 4` point.
- Caller gas handling and pairing gas-guard boundaries.

Call-count assertions establish that tested early rejections do not reach
the pairing precompile.

### Independent Noble witness audit

`verify.mjs` checks the supplied integer y against Noble's decoding of the
compressed signature, then verifies the decoded point.

This provides an independent acceptance oracle without copying the Solidity
limb subtraction or sign-comparison implementation. Solidity ABI limb handling
is covered by the Foundry suite.

For each published round, the audit checks one witness acceptance and
15 rejections:

- Eight mutated rounds.
- Three invalid signature/root combinations.
- Round zero.
- `y = p`.
- `y = p + 1`.
- `y + 1`.

The total is 12 witness acceptances and 180 witness rejections.

Point-decoding and point-validation errors are treated as rejection.
Hashing, serialization, and pairing errors are not caught as ordinary negative
results; they fail the audit.

This oracle checks acceptance behavior. It does not establish Solidity
execution order, precompile call status, or gas consumption.

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

Both Noble and Solidity require rejection under the Quicknet key. The Foundry
corpus tests also check encoding canonicality and rejection without a revert.

Source-key acceptance runs explicitly for `v30` and cannot be skipped by
removing its source metadata. This vector is included in the 31 fixed
negatives; source-key acceptance is one additional check.

## Read-only target-chain conformance

`verify-chain.mjs` executes compiled candidate bytecode through the supplied
EVM RPC endpoint using `eth_call`, `debug_traceCall`, and temporary state
overrides.

The runner is chain-agnostic. It queries `eth_chainId` and records the returned
chain ID in the report. It does not infer the chain from the URL or require an
expected-chain-ID setting.

It requires:

- `QUICKNET_RPC_URL` set to the target endpoint.
- Support for code overrides in `eth_call`.
- Support for `debug_traceCall` with `callTracer`, state overrides, and
  precompile frames.
- Fresh verifier and harness artifacts under `contracts/out`.
- Execution compatibility with the compiled bytecode and the verifier's
  required SHA-256, ModExp, and EIP-2537 precompiles.

The runner requires no private key and broadcasts no transactions. Temporary
code and balance overrides apply only to the simulations. Precompile addresses
are never overridden.

With `QUICKNET_RPC_URL` set, run from the repository root:

```sh
pnpm run build:contracts &&
node scripts/quicknet-kat/verify-chain.mjs \
  > quicknet-conformance.json
```

The runner records the chain ID reported by the endpoint. Check that ID before
attributing the results to an intended network.

Calls are pinned to one block number. The runner checks afterward that its
block hash has not changed; a changed hash fails the run.

It separately simulates creation bytecode, exercising both constructors and
checking the returned runtime against the compiled artifacts. Injecting
runtime code alone would not execute constructor self-tests.

The current runner produces 85 result rows:

| Coverage | Rows |
| --- | ---: |
| Verifier and harness constructors | 2 |
| Five checks for each of 12 published rounds | 60 |
| Additional early-rejection cases | 11 |
| Six raw pairing cases and their verifier-wrapper counterparts | 12 |

The six raw cases are:

| Case | Expected raw call status | Expected pairing result |
| --- | --- | --- |
| Valid KAT | Success | One |
| Consistently encoded negative KAT | Success | Zero |
| Off-curve witness | Failure | Not decoded |
| Order-three point `(0, 2)` | Failure | Not decoded |
| Order-three point `(0, p - 2)` | Failure | Not decoded |
| Fixed non-subgroup point with `x = 4` | Failure | Not decoded |

All pairing calls must receive exactly 500,000 gas. Invalid-point failures must
consume that full forwarded budget. Successful pairing gas consumption is
recorded rather than required to equal a fixed price.

These checks evaluate compatibility with the candidate verifier's fixed gas
budget on the selected chain.

The valid KAT is the passing control under the same budget. Wrapper-level
`false` alone does not establish that the precompile rejected an invalid point.

The target-chain runner uses a selected conformance matrix. It does not rerun
every offline negative, fuzz property, or gas-boundary test.

## Saved reports

Commit successful reports under `scripts/quicknet-kat/reports/`, using
`<network>-<block>.json`. Take the block number from the report and choose a
network label consistent with its recorded chain ID.

For example:

```text
scripts/quicknet-kat/reports/
└── robinhood-mainnet-70229401.json
```

Preserve earlier reports rather than overwriting them.

A report is successful only if the command exits successfully and its JSON
contains `"status": "PASS"`. Errors are written to stderr; the runner avoids
printing RPC URLs and raw provider error messages.

Each report records:

- Chain ID, block number, and block hash.
- SHA-256 fingerprints of verifier and harness initcode and runtime.
- Verification results, pairing call status, and pairing-frame gas summaries.

These fingerprints identify the tested bytecode. They are not Ethereum
Keccak-256 runtime codehashes and must not be copied into deployment manifests
as codehash values. Reports contain checked summaries, not complete raw traces.

Record the tested source revision and toolchain versions in the accompanying
PR or release notes.

### Recorded validation: Robinhood mainnet

[Block 70229401 report](reports/robinhood-mainnet-70229401.json), chain ID 4663:

- All 85 result rows passed.
- Both entry points accepted all 12 published rounds.
- All 35 tested early rejections avoided pairing.
- Successful pairing calls consumed 102,900 gas.
- Tested off-curve and non-subgroup calls failed and consumed the full
  500,000-gas budget.
- Constructor simulations returned the expected runtime bytecode.

This is evidence for the recorded candidate artifacts and the RPC node's
execution at that block. It is not a deployed-transaction receipt or a claim
that another chain has identical execution behavior or pricing.

## Scope and limitations

Offline Foundry execution, including a local fork, does not by itself establish
the target chain's native precompile behavior. The RPC conformance runner adds
target-node execution evidence for the tested cases.

Known-answer tests and selected adversarial vectors do not prove complete
precompile conformance or replace independent review, deployment verification,
and recurring acceptance/rejection canaries.

A failed verification attempt is not a permanent verdict that a round has no
valid beacon. Integrations must allow retry with corrected input.

This suite does not establish consumer timing, settlement, or relayer safety.
Those require their own integration tests and review.

A third implementation such as drand's Go stack can be added later; no Go
differential run is claimed here.