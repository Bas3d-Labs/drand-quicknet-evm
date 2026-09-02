# Robinhood Testnet Security Profile

Configuration: [`robinhood-testnet.yaml`](./robinhood-testnet.yaml)

<a id="security-assumptions"></a>
## Security assumptions

Robinhood Testnet uses the sequencer-clock fast path
(`sequencer` timestamp authority, `trusted-sequencer` history integrity).

### A1: Protocol timestamp validity

The configured Nitro time-variation envelope is:

```text
delayBlocks:   28800
futureBlocks:    300
delaySeconds: 345600
futureSeconds:  3600
```

With Ethereum Sepolia's 12-second slots, the block- and second-based limits
agree; the backward protocol-valid allowance is 96 hours.

These timestamp semantics were source-traced at Nitro commit `dfab1de`,
including `arbstate/inbox.go` and `arbos/block_processor.go`, as part of the
consensus-v61/ArbOS 61 provenance reviewed for this profile.

The approved `consensus-v61` root in `chainAdapter.config` is the committed
expected value for the separate live consensus-root check.

### A2: Sequencer timestamp freshness

For Quicknet period 3 seconds and `minimumLeadRounds = 5`, the reference
consumer's mechanical chain-clock lead at commitment inclusion is 13–15
seconds.

With `timestampFreshnessReserveSeconds = 3`, the timestamp-skew violation
boundary is 10 seconds.

A1 does not establish A2: the protocol-valid backward allowance exceeds this
boundary by a factor of 34,560.

The warning (5 seconds) and critical (8 seconds) thresholds drive the skew
monitor. Observed compliance is a canary for A2, not proof that the assumption
always holds.

### B: Sequencing and history integrity

This profile assumes that protocol-valid sequencing, withholding, ordering, and
history-selection discretion is not conditioned on subsequently learned drand
outputs.

### Testnet acceptance

A2 and B are explicitly accepted for Robinhood Testnet. Fraud-proof
availability does not by itself discharge either assumption.

### Mainnet gate

A production deployment must either explicitly accept the equivalent A2 and B
assumptions or use the parent-chain-anchored model:

```yaml
securityModel:
  timestampAuthority: parent-chain-consensus
  historyIntegrityAssumption: parent-chain-precommitted
```

Increasing `minimumLeadRounds` alone does not remove the sequencing/history
assumption.