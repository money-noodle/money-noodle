# Requalifying maker entry episodes

> Approved by the maintainer on 2026-08-19 as a restrictive amendment to
> [`high-edge-execution-reduced-sizing-design.md`](high-edge-execution-reduced-sizing-design.md).
> This changes execution sequencing, not the shared buy rule or sizing policy.

## 1. Decision

An authoritative maker zero-fill ends one entry **episode**, not the asset/side/window for its entire life.
The same side may receive another attempt without first becoming nonqualifying, but only after it earns the
ordinary production persistence checks again from observations strictly after the preceding maker completed.

This is not an immediate maker retry. The completed maker contributes no authority to the next episode, and
a continuously qualifying signal must still collect two new qualifying snapshots spanning at least 15 seconds.
At most three episodes may be issued per asset/side/window.

## 2. Rearming conditions

Episode 1 uses the ordinary production path. Episode 2 or 3 may open only when all of the following hold:

1. every prior order for the logical asset/side/window is definitively terminal and spent no money;
2. the immediately preceding order is an authoritative `unfilled` managed maker stamped with the current
   execution generation;
3. no prior order has any fill, open remainder, pending reservation, or uncertain state;
4. the current persistence evaluator sees the normal required observations strictly after the preceding
   maker's `makerCompletedAt` boundary;
5. the normal buy, portfolio, funding, rate, exposure, live-risk, quote, and reconciliation gates all pass;
6. the final 30-second entry cutoff has not begun; and
7. fewer than three episodes have been issued for the asset/side/window.

A nonqualifying observation is not required. If one occurs, the existing persistence reducer resets the
streak in the ordinary way. If the signal remains qualified, only post-completion observations count.

## 3. Route and size

Every episode is a new decision, not a continuation of stale execution authority. Its current issuance edge
runs `entry-sizing-reduce30-below-edge30-v1` again and selects the current v5 route:

- below 30pp: one managed maker;
- at least 30pp: one fresh-quote capped IOC evaluation under all existing high-edge gates.

There is no taker fallback. A refreshed taker refusal or accepted IOC zero-fill remains terminal for the
whole asset/side/window in this generation; only an authoritative maker zero-fill can rearm. Any partial fill
also ends rearming because the account now owns exposure.

## 4. Durable identity and display

The stable logical order ID continues to group the asset/side/window. Episode 1 retains the historical base
ID; later episodes use `:episode:2` and `:episode:3`. Each order stamps its episode number and predecessor.
Historical `:retry:` IDs remain readable but cannot authorize a current episode.

The dashboard reports `maker missed · requalifying · n of 2`, `maker missed · checks pending`, or
`maker missed · episode ready`; it reports `sequence ended` only after episode 3, a non-maker terminal
result, a fill, or an unsafe/ambiguous state.

## 5. Track separation and evidence

Paper uses the same three-episode requalification definition and relative sizing, with its independent maker
simulation and bankroll. Its managed-maker execution identity advances so v2 one-window-attempt rows are not
pooled with the new cohort. Live and paper outcomes remain separate.

This deployment is an operator execution decision. It is not supported by a measured requalification cohort:
v4 had only four live attempts at the decision read, three authoritative maker zero-fills and one fill, with
no prospective episode-2 observations because v4 prohibited them. The main risk is repeated adverse-selection
exposure after a signal that never weakened. The mitigations are fresh post-completion persistence, the
three-episode cap, unchanged reduced sizing, and the rule that any fill stops the sequence.

## 6. Tests and deployment

Tests must pin:

- no immediate episode after maker completion;
- exactly two post-completion observations spanning 15 seconds requalify even without a nonqualifying gap;
- pre-completion observations supply no authority;
- episode IDs and predecessor stamps are unique and durable;
- fills, partial fills, uncertainty, rejection, stale-policy rows, and taker terminal results never rearm;
- episode 3 is the hard ceiling;
- paper and live use the same episode boundary while retaining track-specific execution;
- current sizing and fresh high-edge taker gates rerun for every episode; and
- dashboard labels distinguish requalification from an ended sequence.

Funded deployment follows the ordinary quiescent procedure: typecheck and full tests, build, manual pause and
drain, restart, startup reconciliation, and explicit resume only when all readiness gates pass.
