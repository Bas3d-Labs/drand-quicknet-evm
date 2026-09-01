# Chain Security Profile Template

This document defines the required structure and semantics for chain security profiles used by `drand-quicknet-evm`.

A chain profile records the chain-specific security assumptions, timing policy, mutable external dependencies, and evidence required to justify deployment of the Quicknet infrastructure on a particular EVM network.

## Normative configuration

The YAML front matter is normative for machine consumers.

The Markdown body explains and justifies the normative configuration.

Changes to expected state MUST update both the front matter and the corresponding security explanation in the same revision.

Derived quantities MUST NOT be duplicated in front matter when they can be computed from normative inputs.

Each normative value SHOULD have one authoritative home. Values mirrored from deployed infrastructure or external chain state are verified against their live source rather than duplicated into additional configuration files.

## Required front matter

A profile MUST define:

```yaml
profileVersion: 1

network: example-network
chainId: 12345
onboardingTier: 1

randomness:
  beacon: drand-quicknet
  periodSeconds: 3

timing:
  minimumLeadRounds: 5
  timestampFreshnessReserveSeconds: 3

securityModel:
  timestampAuthority: sequencer
  historyIntegrityAssumption: trusted-sequencer
  assumptionsSection: security-assumptions

monitoring:
  timestampSkewSeconds:
    warning: 5
    critical: 8

chainAdapter:
  type: arbitrum-nitro
  config: {}

deploymentManifest: '../../../deployments/example-network.json'
```

`timestampFreshnessReserveSeconds` belongs under `timing` because it is infrastructure security policy, not a property of the drand beacon.

`minimumLeadRounds` is the normative infrastructure floor. It MUST NOT be duplicated into the deployment manifest.

## Timing derivation

For beacon period `P` and registry floor `L`, the minimum chain-clock lead is:

```text
minimumChainClockLeadSeconds =
    P * L - (P - 1)
```

For timestamp freshness reserve `M`, the timestamp-skew violation boundary is:

```text
timestampSkewViolationSeconds =
    minimumChainClockLeadSeconds - M
```

The reserve MUST be smaller than the minimum chain-clock lead.

When timestamp-skew monitoring is configured:

```text
warning < critical < timestampSkewViolationSeconds
```

Derived values MUST be computed by tooling rather than independently stored in the profile.

## Registry-floor scope

The profile evaluates the registry floor as the weakest configuration permitted for consumers using the reference `DrandQuicknetRandomnessConsumer` integration.

A compliant reference consumer chooses:

```text
quicknetLeadRounds >= minimumLeadRounds
```

Larger values monotonically strengthen the chain-clock lead.

Bespoke consumers that bypass these safeguards are outside the profile's guarantee and cannot weaken the registry or other consumers.

Profiles MUST NOT enumerate permissionless downstream consumers.

## Explicit anchors

Machine-readable section references resolve only against explicit HTML anchors.

Anchor IDs MUST match:

```text
[a-z0-9-]+
```

Example:

```html
<a id="security-assumptions"></a>
```

Implicit Markdown or GitHub heading slugification MUST NOT be used by tooling.

Explicit anchors appearing inside fenced code blocks or inline code do not count.

Duplicate explicit anchor IDs are invalid.

A referenced anchor that does not resolve uniquely is invalid.

<a id="security-assumptions"></a>

## Security assumptions

Every profile MUST document the assumptions represented by its `securityModel`.

For the sequencer-clock fast path, distinguish at minimum:

### A1 — Protocol timestamp validity

The protocol rules that determine whether an L2 timestamp is valid.

### A2 — Sequencer timestamp freshness

The assumption that a protocol-valid sequencer keeps the L2 timestamp sufficiently close to real time that the selected future drand round remains unknown.

### B — Sequencing and history integrity

The assumption that protocol-valid sequencing, withholding, ordering, or history-selection discretion is not conditioned on subsequently learned drand outputs.

Assumptions A2 and B concern protocol-valid sequencer behavior. A fraud-proof regime, whether permissioned or permissionless, does not by itself discharge them.

## Chain adapters

Chain-family-specific fields belong beneath:

```yaml
chainAdapter:
  type: <family>
  config: {}
```

Generic profile validation MUST complete before chain-adapter-specific validation.

Both stages MUST complete before any network request occurs.

A formal generic adapter interface SHOULD NOT be introduced solely for hypothetical future chain families. Extract one once multiple materially different chain families require it.

## Deployment manifest

`deploymentManifest` MUST be a relative path resolved from the profile file's own directory.

Absolute paths are invalid.

The referenced file MUST:

* exist
* be a regular file
* contain valid JSON
* satisfy the strict deployment-manifest schema
* match the profile's `network`
* match the profile's `chainId`

Manifest resolution and validation are local operations and MUST complete before any RPC access.

The deployment manifest records only infrastructure owned by `drand-quicknet-evm`. It MUST NOT contain downstream consumer deployments.

## Evidence classes

Security evidence is divided into three classes.

### Live-state mirrors

Values whose expected state is committed and whose live value can be re-read and compared.

Examples include:

* registry runtime codehash
* verifier runtime codehash
* registry `minimumLeadRounds`
* mutable chain configuration
* active consensus module roots

### Historical provenance

Immutable facts about how or when an artifact or attestation was produced.

Examples include:

* deployment transaction hashes
* deployment block numbers
* dated evidence blocks

These are recorded once and are not treated as mutable live state.

### Re-executable attestations

Procedures whose initial execution is recorded as deployment evidence and whose equivalent verification can later be repeated.

The recurring drand KAT canary is the scheduled form of the deployment-time KAT attestation, not a distinct security procedure.

The gas attestation's recurring equivalent is normally the reference suite's gas-ceiling assertion in CI rather than an operations canary.

## Dated evidence

Evidence derived from chain state SHOULD record both:

```text
block number
block timestamp
```

All observations making up one evidence snapshot MUST be pinned to the same block.

A complete Nitro verification run therefore normally contains two snapshots:

```text
L2 snapshot
    deployment/configuration checks

parent-chain snapshot
    timestamp-envelope check
    consensus-root check
```

## Status taxonomy

Every live check reports one of:

```text
MATCH
DRIFT
ERROR
```

### MATCH

The observation succeeded and agrees with committed expected state.

Exit code:

```text
0
```

### DRIFT

The observation succeeded against the intended subject, but live state differs from committed expected state.

Exit code:

```text
2
```

### ERROR

A valid observation could not be made.

Examples include:

* invalid local profile or manifest
* missing files
* RPC failure
* decode failure
* unavailable pinned state
* observation against the wrong chain

Exit code:

```text
1
```

DRIFT describes the monitored subject.

ERROR describes inability to make a valid observation of that subject.

A successful read that invalidates the observation channel itself, including a chain-ID mismatch, is ERROR rather than DRIFT.

Live checks SHOULD continue collecting independent observations after discovering DRIFT whenever doing so remains semantically valid.

A later dependent operation MUST NOT erase or reclassify an earlier valid finding.

## Aggregate check behavior

Local validation runs before RPC access.

If local validation fails, the run ends as ERROR without performing live checks.

After successful local validation, every selected live check whose required observation instruments have been validated SHOULD run without fail-fast behavior.

Overall status precedence is:

```text
ERROR > DRIFT > MATCH
```

Therefore:

```text
any ERROR
    -> overall ERROR

otherwise any DRIFT
    -> overall DRIFT

otherwise
    -> overall MATCH
```

Per-check results MUST still be emitted so co-occurring DRIFT findings are preserved even when the aggregate status is ERROR.

## Observation instruments

Every RPC endpoint used by a selected check MUST have its chain identity established before substantive state is read from it.

An unused RPC instrument does not need to be supplied or validated.

Filtering checks through options such as `--only` MUST NOT bypass identity validation for an instrument actually used by the selected check.

Programmatic chain verification uses viem.

`cast` commands may be provided as operator-facing diagnostic equivalents but are not an implementation dependency of the security tooling.

## Onboarding tiers

### Tier 1 — Required

The profile is structurally and semantically complete.

Tooling MUST be able to establish locally that:

* the security model is declared
* the assumptions anchor resolves uniquely
* the beacon timing inputs are valid
* the minimum-lead derivation is valid
* required monitoring configuration exists
* the deployment manifest resolves and validates
* chain-adapter configuration validates

### Tier 2 — Attested

One-shot deployment and chain-state verification procedures exist and have been successfully exercised.

Tier 2 is an operational claim and cannot be proven solely by loading the profile.

### Tier 3 — Production hardening

Recurring watches and alerting are operational.

Tier 3 is an operational claim and cannot be proven solely by loading the profile.

A profile MUST NOT claim a higher tier until the corresponding operational state is actually true.

## Profile validation command

Running:

```text
pnpm security:profile
```

without a network filter MUST validate every committed chain profile and referenced deployment manifest.

The command performs no RPC calls.

A network filter may be provided for local debugging, but CI SHOULD validate all committed profiles.

## Live verification command

Running:

```text
pnpm security:check
```

performs the same complete local validation before establishing RPC instruments and executing live checks.

Live verification MUST NOT be included in deterministic repository checks that are expected to run without network access.
