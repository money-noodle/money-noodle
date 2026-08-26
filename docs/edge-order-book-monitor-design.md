# Edge order-book monitor and stable signal transitions

> **Document type:** Product design
> **Design status:** Accepted
> **Implementation:** Complete
> **Created:** 2026-08-20
> **Canonical requirements:** [`spec/product-and-surfaces.md`](../spec/product-and-surfaces.md), [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md)
> **Decision record:** [`spec/decision-log.md`](../spec/decision-log.md)
> **Design index:** [`docs/README.md`](README.md)

> Approved by the maintainer on 2026-08-20. This is an authenticated, observation-only UI change. It adds
> no durable store, execution input, policy gate, sizing input, order action, or public hosted polling.

## 1. Goal

The positive-edge surface should expose enough of Kalshi's displayed ladder to inspect price, level size,
and cumulative depth while a signal is being monitored. The same surface should preserve the human learning
context after a signal stops qualifying: cards reserve a stable minimum height, awaiting-confirmation signals
are shown by default, and every signal observed in the mounted dashboard remains visible through its market
window.

## 2. Data boundary

The monitor reads the public Kalshi order-book endpoint through a new authenticated Node route. It is
available only on the stateful operator dashboard; unauthenticated and stateless requests fail before any
venue read.

Only one book may be expanded at a time. The client fetches immediately when expanded and then every two
seconds measured from completion, not from request start. Polling pauses while the document is hidden and
stops when the panel closes or the component unmounts. This bounds one browser to at most one public depth
request per two seconds and prevents a slow request from building a backlog.

The route validates a length-bounded Kalshi ticker and `UP`/`DOWN` side, fetches 20 raw YES/NO bid levels,
normalizes them into the selected side, and returns only ten bids and ten asks. It sets
`Cache-Control: private, no-store`; a failed or malformed book returns an error and cannot fail the dashboard.

The monitor uses a new uncached read helper that deliberately does **not** populate the execution depth
cache. Opening a UI panel therefore cannot alter live/paper queue telemetry, order pricing, or fill evidence.

## 3. Ladder semantics

Kalshi publishes YES and NO bids. For the selected side:

- bids are that side's own bid ladder, best price first;
- asks are `1 − opposite-side bid`, best price first;
- each row shows price, displayed quantity at that level, and cumulative quantity from the touch;
- the spread is selected-side best ask minus best bid;
- the timestamp and age remain visible, and old data is labelled stale rather than silently presented as
  current.

This is the **raw displayed book**. It does not claim individual-order visibility, FIFO rank, hidden size,
or an ex-self counterfactual. Exact own-order queue position and future self-subtraction remain separate
work after order identity is repaired.

## 4. UI behavior

Each authenticated positive-edge card gets an `Order book` disclosure. Expanding one closes the previously
expanded card. The panel has a fixed minimum height and stable loading/error/empty states so each two-second
refresh does not resize the grid.

Positive-edge cards and the signal body reserve minimum heights. Awaiting-confirmation signals are visible
by default; the existing control still allows the operator to hide them.

When an active signal disappears from the current qualified set, its last qualified snapshot remains fully
visible with a `signal expired` label and an explicit note that it is retained until market close. It moves
below current signals rather than being discarded. Its ladder remains available while the market window is
open, so the operator can inspect how displayed depth evolves after qualification ended.

At `market.closesAt`, not at qualification loss, the retained card begins the 2.4-second opacity/blur fade
and is then removed. If the same asset/window requalifies before close, its current snapshot replaces the
retained snapshot and the expired indication clears. Retention is browser-session UI state only: it creates
no durable history, and a page reload does not reconstruct a signal absent from the current dashboard.

## 5. Safety and privacy

- Auth is checked in the route, close to the venue read.
- Hosted/stateless mode receives no monitoring authority.
- No signed Kalshi endpoint, credentials, account position, order ID, or execution state is returned.
- The ladder is never attached to `Prediction`, dashboard persistence, policy manifests, forecasts, or
  order records.
- Missing, stale, crossed, or malformed levels are displayed as unavailable and never substituted into a
  decision.
- The existing repeated-episode client-ID defect is unaffected and remains higher-priority execution work.

## 6. Verification

Tests pin selected-side UP/DOWN normalization, sorting, level bounds, and cumulative-depth semantics. The
full typecheck, test suite, and production build must pass. Manual UI verification covers one-active-book
polling, hidden-tab pause, stable loading/error heights, default-visible awaiting signals, retention after
qualification loss, market-close fade, and re-entry replacement of the retained snapshot.
