# Adaptive entry execution and one-miss taker fallback

> **Superseded on 2026-08-19 by**
> [`high-edge-execution-reduced-sizing-design.md`](high-edge-execution-reduced-sizing-design.md). Historical
> v3 orders retain these semantics; v4 permits one attempt and no fallback.
>
> Design agreed with the maintainer on 2026-08-19 before implementation. This changes funded execution,
> not the buy rule. The mirror invariant remains intact: live and paper still make the same entry decision;
> execution style and capital remain track-specific under SPEC §12.3.

## 1. Decision

Live edge-policy entry uses `adaptive` execution. A choice is local to one logical entry sequence — asset,
side, settlement window, and entry generation — and never changes a global mode.

Attempt 1 evaluates the existing six taker gates at its fresh issuance quote:

1. current ask-side net edge at least 15 percentage points after the configured entry fee;
2. persistence-median net edge at least 10 points;
3. estimate quality at least 65%;
4. selected-side spread no wider than 2¢;
5. at least 30 accepted comparable maker attempts; and
6. taker expected captured edge at least 2 points above the empirical maker estimate.

All six pass: submit one price-capped taker IOC. Any fails: submit the managed post-only maker. The 2¢ gate
is a bound on the price concession paid for immediacy; it is not a claim that narrow spreads predict maker
fills. The separate general 10¢ spread ceiling still rejects an entry entirely.

## 2. Fallback after a maker miss

Only an authoritative zero-fill maker result may open attempt 2. A partial fill, taker IOC no-fill,
rejection, working order, or uncertain state never does.

There is no fixed retry cooldown. Cancellation confirmation is the safety boundary; freshness is evidence,
not elapsed wall time. After `makerCompletedAt`, the same logical sequence must collect two new qualifying
snapshots spanning at least 15 seconds. Pre-completion observations cannot count. The normal 90-second
warm-up, 30-second entry cutoff, snapshot-age rule, entry policy, classified-path and adaptive-regime gates,
portfolio constraints, funding, rate limit, stake cap, and reconciliation readiness all run again. The
existing retry cutoff also refuses attempt 2 inside the final 120 seconds.

At the fresh attempt-2 quote, the four absolute taker gates still apply: 15-point current edge, 10-point
post-miss median edge, 65% quality, and spread no wider than 2¢. The prior authoritative maker miss replaces
only the two comparative gates — maker cohort sample count and estimated taker advantage. If an absolute
gate fails, no second maker order is submitted; the sequence keeps waiting for fresh qualifying evidence
until it expires.

When the four gates pass, attempt 2 is one IOC limit under the current all-in cap. Fill or no-fill ends the
sequence; there is no third attempt.

## 3. Bounded quote movement before taker submission

> Added by maintainer decision on 2026-08-19 after the first v2 smoke trace separated maker misses from a
> taker decision that was never submitted because the ask moved from 28¢ to 29¢.

Both immediate and fallback takers may accept at most **1.0¢** of selected-side ask movement between the
issuance decision and the signed fresh quote. This is a bounded limit, not an instruction to pay the full
cent: the IOC limit is the refreshed ask actually observed. The relaxed maximum is also capped at the buy
policy's 97¢ price ceiling.

The order is sized and fees reserved at the worst permitted price so the existing all-in stake ceiling
cannot be exceeded. At the signed refresh, the applicable execution policy is evaluated again using the
fresh bid, ask, spread, fee, and maker cohort: spread must still be no wider than 2¢, current net edge must
still clear 15pp, and every other attempt-1 or fallback gate remains in force. Movement beyond 1¢ or a fresh
gate failure refuses submission. Quote movement after the final refresh can still leave an accepted IOC
unfilled; the limit never chases it.

Reporting distinguishes three outcomes without rewriting history: a quote/gate refusal before submission,
an accepted IOC with zero fill, and a maker that rested with zero fill. Historical `Taker not submitted:`
rows are corrected only in the bounded read model.

The live dashboard separates execution-confirmed/current-window attempts from raw base-edge signals. Raw
signals awaiting persistence are hidden behind an explicit secondary control rather than presented as
buys. Snapshot requirements come from `productionSignalPersistence` through the authenticated execution
read model; the client never hardcodes a denominator. Attempt ceilings remain audit detail, not progress:
a maker miss is labelled by its actual next state — collecting fresh fallback evidence, checks pending,
eligible but awaiting operational execution, or sequence ended.

## 4. Reset and recovery semantics

Fallback is never sticky. Other assets, sides, settlement windows, and later entry generations begin at
attempt 1 and evaluate all six adaptive gates again. A new process recovers attempts from the durable shared
ledger, so restart cannot erase the first maker miss or manufacture retry capacity.

The paper lane remains an independent managed-maker simulation. It records the same buy decision but does
not pretend a historical ask was executable; authoritative live fills continue to attach as a separate
matched-live overlay.

## 5. Audit requirements

Each live order stamps the execution-policy version, configured mode, recommended and executed style, gate
reason, attempt number, logical order id, and retry parent. Attempt 2 additionally stamps that it is a
post-maker-miss fallback and the maker order it follows. Reports must not pool execution-policy versions.

Tests must pin:

- all six attempt-1 gates independently fail safe;
- 2¢ passes and a value above 2¢ fails with tolerance against taking;
- only an authoritative maker zero-fill can open fallback;
- two post-completion snapshots spanning 15 seconds are required without a fixed cooldown;
- pre-completion snapshots cannot count;
- all four absolute fallback gates remain mandatory;
- the two comparative gates alone are waived on fallback;
- taker no-fill, partial fill, uncertainty, attempt 2, and the final 120 seconds prohibit another attempt;
- a different logical sequence starts adaptive attempt 1 anew; and
- one-cent movement is capped at 97¢, sized all-in at the worst price, and re-runs the applicable gates;
- pre-submit quote refusal is distinct from accepted IOC no-fill and rested maker no-fill; and
- live rate, budget, portfolio, and reconciliation guards remain unchanged.
