# Execution and position-path instrumentation — 2026-08-14

## Decision

Add prospective observation-only execution and position paths without changing entry prices, maker management, retries, sizing, exits, or gates. Existing historical records remain immutable legacy rows; fields are populated prospectively and authoritative reconciliation fills what it can without rewriting issuance evidence.

## Entry-price identity

New paper/live orders retain separate fields for:

- exact issuance ask, bid, and spread;
- edge-approved maximum entry price;
- first submitted selected-side limit;
- every create quote, acknowledgement race, acceptance, management quote, accepted/rejected amendment, cancellation request/confirmation, and terminal fill;
- authoritative average fill price and exact principal/fee/stake.

`askPrice` remains for compatibility but is no longer overwritten after a new live fill. It stays the issuance limit on new orders. Reporting prefers immutable `entryDecision.netEdge` and issuance fields; actual economics prefer exact principal/fee or authoritative fill fields. Startup reconciliation sets `authoritativeFillPrice` rather than destroying the original ask.

## Queue and depth observations

Kalshi's public fixed-point orderbook endpoint is sampled to 20 levels only for active managed entries and open positions, through a detached deduplicated cache that never delays the signed quote path. It is normalized into YES/NO bid ladders; the opposite bid ladder maps to the selected side's ask. For each managed live entry and simulated paper submission the ledger can retain:

- selected-side best bid/ask and spread;
- submitted/amended limit;
- displayed quantity at the limit;
- total displayed selected-side bid quantity at that price or better;
- best bid and ask displayed depth and simple depth imbalance;
- quote touches, partial/full fill count, remaining quantity;
- resting duration and bounded cancellation-confirmation latency.

Displayed size is explicitly a **queue-ahead proxy**, never exact private priority. Hidden liquidity, order age within a level, cancellations, and other participants' amendments remain unknown. Orderbook failures omit these optional fields and cannot suppress a valid best bid/ask or alter execution.

## Position lifecycle

Every fresh collector cycle appends one observation to each open paper/live position, including positions retained after a no-fill standalone exit attempt:

- executable selected-side bid/ask/spread and displayed best-level depth;
- exact cost, estimated exit fee, net liquidation value, unrealized P&L and return;
- independent owned-side probability, estimate quality, basis, cycle regime, and seconds remaining.

These are fixed-horizon counterfactual liquidation samples: each row answers what full liquidation would have returned at that observation. Existing peak liquidation/probability and profit-lock state continue to update from the same quote, but the full path now survives rather than only its latest/high-water summaries.

## Surfaces and safeguards

- Open-order and Decision history details show issuance, approved, initial-submitted, and authoritative-fill prices separately.
- Expandable execution and position paths expose the raw audit sequence.
- Signed Performance → Maker execution reports path/depth coverage, repricing, displayed-ahead proxy, resting duration, cancellation latency, and position snapshot counts.
- Public paper projections remain sanitized and omit depth, client/venue IDs, decision snapshots, and lifecycle paths.
- Observation callbacks are best-effort for telemetry and can never prevent remainder cancellation. Durable venue/client IDs remain the fail-closed execution control, and the completed path is written again with the final fill result.

No execution policy or real-money behavior changed.
