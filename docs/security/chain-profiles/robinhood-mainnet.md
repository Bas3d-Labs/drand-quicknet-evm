# Robinhood Mainnet Security Profile

Configuration: [`robinhood-mainnet.yaml`](./robinhood-mainnet.yaml)

<a id="security-assumptions"></a>
## Security assumptions

Robinhood Mainnet uses the sequencer-clock fast path
(`sequencer` timestamp authority, `trusted-sequencer` history integrity).

### A1: Protocol timestamp validity

The configured Nitro time-variation envelope is:

```text
delayBlocks:   28800
futureBlocks:    300
delaySeconds: 345600
futureSeconds:  3600
```

With Ethereum mainnet's 12-second slots, the block- and second-based limits
agree; the backward protocol-valid allowance is 96 hours.

These timestamp semantics were source-traced at Nitro commit `dfab1de`,
including `arbstate/inbox.go` and `arbos/block_processor.go`, as part of the
consensus-v61/ArbOS 61 provenance reviewed for the existing testnet profile.

The mainnet configuration snapshot at Ethereum block 25985428 reported the
same consensus-v61 module root and the envelope above. This connects the
observed mainnet configuration to that existing provenance review; it does
not constitute a separate source review.

The approved `consensus-v61` root in `chainAdapter.config` is the committed
expected value for the separate live consensus-root check.

### A2: Sequencer timestamp freshness

For Quicknet period 3 seconds and `minimumLeadRounds = 3`, the reference
consumer's mechanical chain-clock lead at commitment inclusion is 7–9 seconds.

With `timestampFreshnessReserveSeconds = 3`, the timestamp-skew violation
boundary is 4 seconds.

A1 does not establish A2: the protocol-valid 345,600-second backward allowance
exceeds this boundary by a factor of 86,400.

The warning (2 seconds) and critical (3 seconds) thresholds drive the skew
canary. They are intentionally close to the 4-second violation boundary.
Normal integer `block.timestamp` truncation contributes up to almost one second
of measured wall-clock skew before observation/network propagation is added, so
warning-tier observations may be materially noisier than under a larger lead.
Observed compliance is a canary for A2, not proof that the assumption always
holds.

The initial mainnet observation run included returned block timestamp ages
above the 4-second boundary. These observations do not isolate sequencer
timestamp lag from RPC staleness and observation delay. They do not establish
compliance with the configured freshness budget. Further commitment-timing
assessment was deferred.

### B: Sequencing and history integrity

This profile assumes that protocol-valid sequencing, withholding, ordering, and
history-selection discretion is not conditioned on subsequently learned drand
outputs.

### Mainnet acceptance

A2 and B are explicitly accepted for Robinhood Mainnet by the project owner.
Fraud-proof availability does not by itself discharge either assumption.

This acceptance records the chosen trust model. Deployment verification and
successful relayer smoke tests do not establish A2 or B, and the three-round
timing policy has not been empirically validated for applications involving
real value.

This profile does not claim sequencer-independent unpredictability or fairness.
Increasing `minimumLeadRounds` alone does not remove the sequencing/history
assumption.