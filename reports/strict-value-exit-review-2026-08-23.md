# Strict-value exit review — 2026-08-23

## Question and deciding corrections

Does current evidence still support `strict-value-v1`, and does any tested replacement beat the complete live
rule strongly enough to authorize a policy change?

Recalculated at **2026-08-23T08:24:32Z** from **3,937 execution orders and 77,056 forecasts** with:

- `npm run analyze:positive-edge-current`;
- `npm run analyze:exit-counterfactuals`;
- `npm run analyze:exit-alternatives`.

The current-policy report separates live and paper, scopes entry rows to active buy policy
`buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22`, separately narrows the
current execution subset to `maker-high30-requalify3-fresh1c-idv2-v6`, and clusters normalized incremental
return by settlement window. The broad alternative replay scores all 795 positions with retained paths,
including both positions held to settlement and positions where the live rule sold, first-to-fire winning.
This avoids flattering an early exit by ignoring the strict-value sales it would pre-empt.

The caveats that most threaten the decision are selection and replay fidelity. The current cohort is inspected
after its reversal was noticed. Candidate margins and 26 alternative rules are multiple retrospective comparisons,
not committed prospective arms. Candidate live sales use recorded executable bids but optimistically assume the
counterfactual IOC fills. Recorded paths stop after a production sale, making later counterfactual triggers
unobservable; the broad replay conservatively treats those as no trigger. Paper and live share signals and are not
independent replications.

## Current strict-value result

The adverse current-policy result strengthened materially since the 2026-08-22 read:

| Cohort | Exits | Windows | Beat hold | Clustered incremental return | ±SE | Raw exit-minus-hold |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Active buy v22 · live | 32 | 28 | **0** | **−11.17%** | 3.28pp | **−115.569¢** |
| Active buy v22 · paper | 25 | 21 | 1 | −15.82% | 10.37pp | −152.316¢ |
| Active execution v6 · live | 21 | 17 | **0** | **−10.36%** | 4.17pp | **−80.799¢** |

All 32 active-v22 live exits later settled on the owned side. Loss is not confined to a narrow trigger-margin
band: 0–5¢, 5–10¢, and 10¢+ production margins contributed −55.083¢, −9.645¢, and −50.841¢ respectively.
The current v6 subset has the same direction. Paper now also moves against strict exit in normalized and raw-cash
views, although its uncertainty is wider.

Lifetime history disagrees with the current regime. Across all generations, live strict value had 126 exits in
114 windows and earned +773.0¢ versus hold, with clustered +5.3% ±7.3pp; paper had 269 exits in 205 windows,
+3,085.2¢, and +15.8% ±7.1pp. Current failure therefore does not prove that early liquidation is universally bad.
It shows that carrying the lifetime insurance claim forward to the active policy is unsupported.

## Margin replay

The current-v22 replay scores every eligible position, not just exited rows. Relative to what production actually
did:

| Live candidate | Positions / windows | Candidate fires | Raw change | Clustered incremental | ±SE |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1¢ margin (current threshold shape) | 120 / 91 | 57 | −1.838¢ | +1.86% | 4.10pp |
| 3¢ margin | 120 / 91 | 32 | +120.481¢ | +5.26% | 3.53pp |
| 10¢ margin | 120 / 91 | 8 | +172.367¢ | +4.09% | 1.93pp |
| 20¢ margin | 120 / 91 | 2 | +161.761¢ | +3.95% | 1.80pp |
| Hold / disable strict exit | 120 / 91 | 0 | +115.569¢ | +2.77% | 0.96pp |

The active-v6-only hold arm similarly improved production by +80.799¢ and +2.39% ±1.15pp over 68 windows.
Paper's hold arm improved raw cash by +152.316¢ but its +2.43% ±2.18pp clustered result remained uncertain.
The 10¢ and 20¢ margins look best in this read, but seven related margins were inspected after observing the
problem; neither is promotion evidence. A no-exit arm is exact for already settled positions but changes binary
risk and loss concentration, so it is not automatically the safer operational choice.

## Broader alternative replay

Across 795 path-bearing positions (543 held, 252 sold), baseline was −5,255¢ on 58,710¢ staked. Of 26 candidates,
take-profit +2% had the largest raw improvement, +3,280¢, but its clustered t was only 0.48. Take-profit rules
were raw-positive for 6/8 variants, yet the group's mean clustered movement was only +0.4%. Stop-loss,
profit-reversal, and time groups moved negatively as groups; trailing variants were raw-positive but averaged
−1.0% on the clustered per-stake measure. With 26 comparisons, no isolated best row is persuasive.

The broad production sales themselves earned 16,474¢ versus 15,247¢ from holding, +1,227¢. This is another view
of the lifetime/current disagreement: replacing the complete historical exit chain is not supported even though
the active cohort is consistently adverse.

## Finding, uncertainty, and authorization

**Finding:** `strict-value-v1` is now a high-priority active-policy concern. The current live result is 0/32 against
hold over 28 independent windows, the current execution subset agrees, and paper has moved in the same adverse
direction. The prior 15-exit warning did not regress toward the lifetime result as the cohort grew.

**Unknown:** whether this is a temporary regime, a model-probability failure near exit, or a stable interaction
between the active entry/execution population and strict value. A prospective arm or committed decision-time
sentinel followed to settlement is required to distinguish those explanations without selecting the margin after
seeing outcomes.

**What the evidence authorizes:** prioritize a policy design decision and prospective comparison. It does **not**
authorize automatic replacement with a 10¢/20¢ margin, fixed take-profit, trailing rule, or disabled exit. Any
production change must preserve reduce-only execution, bump the policy version and manifest history, hold the
paper/live mirror invariant, and state how additional hold-to-settlement downside is bounded. Until that design is
approved, production remains unchanged.

## Same-day follow-up at 16:09Z

A fresh `npm run analyze:positive-edge-current` reload over **4,028 orders and 80,612 forecasts** did not regress
toward the lifetime result. Active-v22 live reached **0/34 exits beating hold across 30 windows**, −128.2834¢ raw
and −11.97% ±3.11pp clustered. Active-v6 live reached **0/23 across 19 windows**, −93.5138¢ and −11.71% ±3.84pp.
Paper reached one of 28 beating hold across 24 windows, −165.652¢ and −15.88% ±9.11pp. This is a sequential look
at the same selected cohort, not a new independent experiment; it strengthens prioritization but does not turn a
retrospectively chosen replacement into prospective evidence.
