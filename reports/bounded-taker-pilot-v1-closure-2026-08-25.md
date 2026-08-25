# Bounded taker pilot v1 closure — 2026-08-25

> **Decision:** close `bounded-taker-pilot-v1` at its compiled 10-authorization / 300¢ ceiling without extension.
> The pilot established bounded signed IOC operation with no treatment safety stop, but treatment did not beat
> control in either live or paper and uncertainty remains large. `reviewUnlocked` is false. No unconditional taker
> route, new efficacy generation, buy-policy change, or stake increase is authorized.

## Question and fixed cohort

The pilot asked whether a preassigned, capped taker IOC could operationally convert a subset of moderate-edge maker
intents without weakening the production buy rule, money controls, or reconciliation. It was an operational pilot,
not a promotion trial; [`docs/bounded-taker-experiment-design.md`](../docs/bounded-taker-experiment-design.md) §7
explicitly prevents v1 outcomes from serving as untouched efficacy evidence for a later generation.

This review loaded the authenticated read-only performance report at **2026-08-25T14:43Z**. Assignment began at
**2026-08-24T18:31:40.507Z** and ended automatically when the tenth treatment authorization consumed the compiled
**300¢ cumulative authorization ceiling**. Settlement timestamp is the economic cluster. Every assignment remains
in the intent-to-treat denominator; pre-submit refusals and no-fills spend zero.

The caveat that most threatens efficacy interpretation is sample size and treatment realization: only 16 live
intents were assigned to treatment, ten were authorized, and only three reached signed IOC submission and venue
acceptance. The pilot was sized for bounded operation, not a reliable return comparison.

## Bounds and operational result

| Bound or event | Result |
| --- | ---: |
| All assigned live intents | 70 / 80 ceiling |
| Treatment assignments | 16 |
| Treatment authorizations | 10 / 10 ceiling |
| Cumulative authorization | 300¢ / 300¢ ceiling |
| Gross realized treatment losses | 28¢ / 150¢ stop |
| Signed IOC submissions / acceptances | 3 / 3 |
| Treatment pre-submit refusals | 7 |
| Treatment assignments withheld to incumbent maker | 6 |
| IOC partial fills | 0 |
| Treatment safety stops | 0 |
| Final state | `completed` — authorization ceiling reached |

The three submitted IOCs were accepted and reached ordinary terminal handling. No treatment ambiguity, sticky
safety stop, cap overrun, or reconciliation contradiction occurred. This establishes only that the narrowly bounded
wire/accounting path operated; it does not establish an execution advantage.

## Intent-to-treat economics

### Live

| Arm | Assignments | Filled sequences | Profitable | Authorization | Exact P&L | Clustered mean ± SE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Incumbent maker control | 54 | 25 | 14 | 1,620¢ | +108.3577¢ | +11.06% ±10.35pp |
| Taker-assigned treatment | 16 | 5 | 2 | 480¢ | +21.8605¢ | +3.94% ±14.19pp |

Treatment minus control was **−7.12pp ±17.56pp**. The treatment-assigned arm includes actual outcomes after
pre-submit refusal or capacity withholding as required by intent-to-treat; its five filled sequences must not be
misreported as five signed IOC fills.

### Paper

| Arm | Assignments | Filled sequences | Profitable | Authorization | Exact P&L | Clustered mean ± SE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Independent maker control | 52 | 20 | 11 | 1,560¢ | +63.204¢ | +7.72% ±8.50pp |
| Independent IOC treatment | 16 | 4 | 1 | 480¢ | −20.912¢ | −0.16% ±9.37pp |

Paper treatment minus control was **−7.88pp ±12.65pp**. Live and paper are not pooled, and neither reads the
other's fill. Both estimates include zero-spend refusals/no-fills.

## Interpretation

- **Safety/operational:** the bounded signed IOC path completed without a treatment safety stop. This is useful
  engineering evidence.
- **Economic:** neither track shows a positive treatment-minus-control estimate, and both intervals are too broad
  to identify a reliable effect.
- **Capital:** consuming the authorization ceiling is a terminal condition, not evidence to enlarge it.
- **Promotion:** v1 has no promotion state and the current report remains `reviewUnlocked: false`.

The correct null disposition is to let subsequent eligible entries use incumbent execution, preserve all v1
stamps and outcomes, and make no route change. A future efficacy trial would require a new design and generation
with sample size, clustered test, downside budget, and promotion criterion committed before its first assignment;
this closure does not propose one.
