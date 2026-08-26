# Long-shot v2 final prospective review — 2026-08-26

## Decision

Retire `long-shot-round-trip-buy12-sell97-win600-v2` and the long-shot strategy lane. Remove its paper/live execution, polling, evidence collection, allocation split, dashboard/API surface, and strategy-specific estimation tools. Do not arm a live lane and do not transfer a former strategy allocation into a larger edge-policy limit.

This is a manual retirement and simplification decision, not an automatic promotion response. The prospective evidence establishes that the 97¢ exit reduced value on this cohort. It does **not** precisely refute every cheap-contract entry strategy: the clustered hold estimate remains broad. Earlier wide parameter screens found no profitable region, however, and this completed forward cohort supplies no positive evidence worth the runtime, venue traffic, storage, UI, and maintenance burden of a separate strategy.

Historical strategy identity and ledger attribution remain. Durable data is not deleted or rewritten.

## Question and precommitted boundary

The active paper rule bought the selected side at an executable ask of at most 12¢, after mandatory trailing confirmation, with at least 600 seconds remaining, and attempted a reduce-only target exit at 97¢. `long-shot-hold-v2` committed the same triggers to settlement as the primary exit counterfactual.

The 2026-08-21 amendment in `docs/long-shot-policy-design.md` §14 required **60 independent settlement windows** before the first manual review. Attempt count alone could not unlock it. No interim return changed the rule or stopped collection.

## Inputs and method

Recalculated at **2026-08-26T01:37:23.326Z** from the persistent worker's durable production report path, then independently checked against the hydrated execution-ledger v9 read path (`scripts/lib/read-execution-ledger.mjs`).

- policy: `long-shot-round-trip-buy12-sell97-win600-v2`;
- sentinel: `long-shot-hold-v2`;
- track: paper only;
- included: terminal v2 entry orders and matching resolved v2 trigger sentinels;
- excluded: prior 10¢→90¢ and v1 cohorts, exit child rows, open/unresolved rows, and all edge-policy orders;
- cluster: UTC contract close; multiple assets sharing one close count as one independent window;
- execution P&L: exact `actualPnlCents` for reporting;
- bankroll check: whole-cent `pnlCents`, summed separately and never substituted for exact P&L;
- no-fill treatment: zero spend, though this cohort had no unfilled attempts;
- paired exit comparison: realized exit lifecycle minus settlement hold on the identical order; unsold positions contribute exactly zero;
- source fingerprints at the read: `paper-orders.json` SHA-256 `744da7f98c20bc6e4a5a7ae8b6b3b4313cb384d223639c1d8ad09fc57ed045b6`; `hold-sentinels.json` SHA-256 `839edaa0b1afab37d0cfd7563f5e58b53b89d5a29ec5d3993ba304c29538246f`.

The main ledger fingerprint covers compact control rows whose archived evidence references are individually checksum-verified by the hydrated reader.

## Auditable totals

| Measure | Result |
| --- | ---: |
| Resolved attempts | 150 / 150 |
| Independent settlement windows | **76** |
| Unexecuted sentinel triggers | 0 |
| Missing peak observations | 0 |
| Unresolved exit counterfactuals | 0 |
| Unscorable/partial exit records | 0 |
| Entry stake | 4,979¢ |
| Exact realized P&L | **−1,410.93¢** |
| Whole-cent bankroll P&L | **−1,415¢** |
| Exact capital ROI | **−28.34%** |
| Clustered round-trip return | **−17.18% ±26.75pp SE** |
| Clustered hold return | **−14.71% ±27.56pp SE** |
| Settlement wins under hold | 13 / 150 (8.67%) |
| 97¢ target exits | 11 / 150 (7.33%) |
| First-generation attempts | 150 |
| Re-entries | 0 |
| Live attempts | 0 |

The exact and whole-cent P&L views differ by 4.07¢ because reporting preserves legitimate fractional cents while bankroll control quantizes per order. They agree on direction and neither is used in place of the other.

## Primary finding: the 97¢ exit hurt

| Paired exit-minus-hold measure | Result |
| --- | ---: |
| Attempts / windows | 150 / 76 |
| Mean difference per $1 staked | **−2.47pp ±0.85pp SE** |
| Distance from zero | −2.91 SE |
| Cash difference | **−98.93¢** |
| Exit-fired attempts | 11 |
| Difference when fired | **−28.68pp ±0.85pp SE** |
| Exit-fired contracts later settling in the owned side | **11 / 11** |

This was the single precommitted hold comparison, not the best result selected from a new exit grid. Positions that did not exit have the same realized and hold result and correctly contribute zero. Every one of the 11 positions sold at 97¢ subsequently settled in the owned side, so the target consistently exchanged a near-certain 100¢ settlement for lower proceeds and another fee. The exit reduced cohort cash by 98.93¢.

The result rejects the claim that the 97¢ target improved this strategy. It does not authorize selecting a different target from historical paths; that would require a new committed prospective generation.

## Entry finding: no positive evidence, but broad uncertainty

The hold arm is the clean entry test because it removes the target-exit decision. Its clustered estimate was −14.71% with a 27.56pp standard error across 76 windows. That interval is broad and spans materially negative and positive returns. Therefore this review does not claim a precise universal refutation of buying every cheap early contract.

The evidence still does not support continuing this implementation:

1. exact paper P&L was −1,410.93¢ on 4,979¢ staked;
2. the prospective hold estimate was negative rather than positive;
3. all 150 attempts were first entries, so the intended profitable re-entry mechanism never occurred;
4. the pre-existing 131-cell banded gap screen found no uncorrected profitable cell, and the selected 12¢→97¢ rule itself came from a 50-cell retrospective sweep rather than promotion-grade evidence;
5. continuing would retain one-second quote polling, target polling, path/sentinel stores, a separate budget layer, and dedicated UI/analysis code for a strategy with no funded use and no demonstrated edge.

The strongest caveat is the wide window-clustered uncertainty on the hold arm. More windows could narrow it. Retirement chooses lower complexity and lower operational load over paying that evidence cost; it is not a declaration that a future, independently designed hypothesis can never be tested.

## Segment diagnostics

No segment authorizes rescue or tuning. The seven asset estimates are small and noisy; one positive XRP slice appeared among seven assets, while six assets lost cash. Regime labels overlap in settlement windows and were not precommitted selectors. Reading either as a new rule would incur multiple-comparison and outcome-selection costs.

Both directions were negative on the clustered estimate:

- DOWN: 87 attempts, 46 windows, −1,055.33¢ exact P&L, −17.45% ±37.43pp SE;
- UP: 63 attempts, 31 windows, −355.60¢ exact P&L, −19.44% ±35.73pp SE.

These slices are diagnostics only and are not evidence for an inverse trade, an asset exclusion, or a regime filter.

## Authority and safety consequences

Authorized by this review:

- retire long-shot execution and collection;
- remove the long-shot dashboard/API and its strategy-specific estimators;
- remove strategy-level allocation splitting from active controls;
- stop long-shot Postgres replication and high-frequency polling;
- retain the applied database migration and worker-local durable files as historical evidence;
- retain `long-shot-round-trip` as a retired ledger identity so historical P&L cannot enter edge-policy accounting.

Not authorized:

- any edge forecast, admission, execution, exit, sizing, market, or capital change;
- reallocating former long-shot capacity to increase funded edge risk;
- deleting or rewriting ledger, sentinel, path, candidate, or projection history;
- claiming the negative return proves every long-shot formulation fails;
- selecting a replacement mark, stop, filter, or asset from this known-outcome cohort.

Nothing here is financial advice.
