# Contract-target comparability review — 2026-08-14

## Decision

Keep Polymarket and Kalshi labeled **approximately comparable**, never exact. Their close times and published 60-second reference/settlement windows align, but their oracle and averaging definitions do not:

- Polymarket: Chainlink 60-second TWAP stream.
- Kalshi: simple average of 60 one-second CF Benchmarks RTI observations, with asset-specific decimal rounding.

The difference is measurable. It does not justify changing the forecast, execution gates, or venue outcomes; exact venue outcomes remain authoritative and separate.

## Rule metadata

`contract-provenance-v1` now deterministically parses and fingerprints:

- settlement method: simple average, time-weighted average, point-in-time, or unknown;
- opening-reference averaging window;
- closing-settlement averaging window;
- published decimal rounding precision.

Unknown wording remains unknown. Existing registry records are not rewritten: reports derive missing legacy metadata from their immutable full rules, while newly observed records carry the parsed fields in their own new fingerprint.

Current rules parse as:

| Venue | Oracle | Reference | Settlement | Method |
|---|---|---:|---:|---|
| Polymarket | Chainlink asset/USD TWAP stream | 60s | 60s | time-weighted average |
| Kalshi | CF Benchmarks asset/USD RTI | 60s | 60s | simple average of 60 observations |

The rule comparator returns `not-comparable` for close-time or known averaging-window mismatch, `exact` only when close/oracle/method/windows all match, and `approximate` when timing aligns but oracle or averaging method differs.

## Kraken reference drift

Across 1,100 Kalshi asset-window records that could be joined to aligned Kraken cycle paths and a published Kalshi floor strike:

- Mean signed Kraken-minus-Kalshi reference drift: **−0.0210%**.
- Mean absolute drift: **0.0268%**.
- Maximum absolute drift: **0.1943%**.

This is not negligible relative to a 15-minute contract move. Kraken remains internally consistent for the venue-independent model because its opening reference and current price come from one series, but it is a proxy rather than either venue's exact oracle.

Polymarket does not publish the opening Chainlink TWAP value in the Gamma contract metadata, so direct reference drift is unavailable and is reported as missing rather than inferred.

## Settlement-path proxy versus venue outcomes

Aligned 15-second Kraken path points were integrated over each contract's parsed final 60-second window. Coverage fails closed when either edge of the window is more than 20 seconds from an observation. The resulting Kraken average is compared with the venue reference proxy, while the venue's own final outcome remains authoritative.

| Venue | Proxy-scored asset-windows | Kraken proxy agreement |
|---|---:|---:|
| Polymarket | 839 | 92.8% |
| Kalshi | 800 | 93.6% |

Across 218 settlement timestamps with both venue outcomes, there were 28 asset-window Polymarket/Kalshi outcome disagreements in the current retained join. These are retained as exact venue-specific results; one venue is never substituted for the other.

The proxy agreement is descriptive, not forecast accuracy. Disagreement can come from oracle composition, opening-reference drift, averaging method, rounding, or sparse Kraken path approximation.

## Product surface and safety

Signed **Performance → Target integrity** reports:

- current rule-level comparison and reason;
- metadata coverage;
- paired exact-outcome windows and venue disagreements;
- Kraken/reference drift;
- Kraken settlement-path proxy agreement;
- recent exact-contract comparisons.

`targetComparison` is persisted prospectively on forecast observations. Settlement-average diagnostics now use the parsed window duration rather than assuming 60 seconds, while retaining 60 seconds as the explicit fallback for legacy/unknown rules.

The report and parser have no order, budget, sizing, gate, probability, or promotion consumer. Production changed: **no**.
