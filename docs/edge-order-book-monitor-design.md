# Edge order-book monitor and stable signal transitions

> Approved by the maintainer on 2026-08-20. This is an authenticated, observation-only UI change. It adds
> no durable store, execution input, policy gate, sizing input, order action, or public hosted polling.

## 1. Goal

The positive-edge surface should expose enough of Kalshi's displayed ladder to inspect price, level size,
and cumulative depth while a signal is being monitored. The same surface should stop jumping when a signal
enters or leaves: cards reserve a stable minimum height, awaiting-confirmation signals are shown by default,
and a departing signal remains in place while fading before removal.

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

When an active signal disappears from the current qualified set, its last rendered snapshot remains for
2.4 seconds with a `leaving signal` label and a slow opacity/blur transition. It occupies its grid slot until
the fade completes, preventing an immediate reflow. If the same asset/window re-enters before expiry, the
fade is canceled and the current snapshot replaces it.

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
polling, hidden-tab pause, stable loading/error heights, default-visible awaiting signals, departure fade,
and re-entry cancellation of the fade.
