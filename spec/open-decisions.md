# Open decisions

> **Status:** Canonical unresolved-decision index · **Authority:** Non-authorizing · **Parent:** [`SPEC.md`](../SPEC.md) · **Structurally verified:** 2026-08-26
> **Canonical for:** unresolved product, provider, security, model, policy, and operational questions.
> **Read with:** [`SPEC.md`](../SPEC.md) and whichever domain module owns the eventual decision.
>
> This module contains requirements extracted from the former monolithic `SPEC.md`. Product behavior was not
> changed by the extraction. If this module appears to conflict with `SPEC.md` or another canonical module, stop
> and resolve the specification conflict rather than choosing one silently.

## 13. Open decisions

Each question carries a stable `OD-<n>` identifier so it can be cited, tracked, and closed by name. Identifiers are
permanent: resolve a question by recording the decision in [`decision-log.md`](decision-log.md) and removing its
entry here, and never reuse the number.

All fifteen were carried forward from the pre-modularization specification on 2026-08-25 and none has an
independently recorded opened date. Several state what evidence would settle them and several do not; supplying the
missing settlement criteria is itself maintainer work, and this module does not invent them.

An open decision authorizes nothing. Until it is resolved and recorded, the safe behavior is whatever the canonical
module already requires.

### OD-1 — Redundant fallback for the primary Kraken series

> **Owning module:** [`providers-and-market-data`](providers-and-market-data.md)

Redundant fallback for the primary Kraken cycle-reference/current-price/volatility series without introducing cross-source basis offsets.

### OD-2 — Cross-provider market sets that match the 15-minute target

> **Owning module:** [`providers-and-market-data`](providers-and-market-data.md)

Exact cross-provider market sets that semantically match each normalized 15-minute target, without assuming equal settlement rules.

### OD-3 — Whether an official ForecastEx event-contract API exists

> **Owning module:** [`providers-and-market-data`](providers-and-market-data.md)

Which official ForecastEx API/product permits event-contract market data, paper modeling, and eventual automated live trading for the operator's account and jurisdiction. *(Crypto.com and Robinhood both resolved 2026-08-13: neither exposes an event-contract API — see [`providers-and-market-data.md` §5](providers-and-market-data.md#5-data-sources-and-integrations).)*

### OD-4 — Investigate Tradier, Alpaca, and IBKR against the venue checklist

> **Owning module:** [`providers-and-market-data`](providers-and-market-data.md)

**To investigate: Tradier, Alpaca, IBKR.** Apply the checklist the previous three investigations produced, in this order, because each earlier candidate failed at a different step and the cheap questions come first: (1) is there an official API for the instrument actually traded, since Crypto.com and Robinhood both have crypto APIs and no event-contract API; (2) is there a central limit order book with limit and post-only orders, since Robinhood has none and managed post-only maker placement is where the live edge comes from; (3) what is the measured round-trip spread, taken from the API rather than assumed, since Robinhood's ~1.9% erases any edge while Crypto.com's is $0.01; (4) is market data readable without credentials, which decides whether research can begin before an account exists; (5) does settlement reference make contracts comparable to the 15-minute cycle-open target, or is this a separate market; (6) jurisdiction, eligibility, and whether automated trading is permitted for the operator's account type. Unverified priors to check rather than trust: Tradier appears to be equities and options only; Alpaca appears to be equities plus spot crypto with a documented market-data API; IBKR is already partially known as the ForecastEx route, whose contracts are macro and climate rather than crypto, so the open question there is whether anything else IBKR offers reaches a market Money Noodle can forecast. None of these priors has been checked against official documentation, and every previous investigation contradicted at least one summary that sounded authoritative.

### OD-5 — Whether a `crypto-spot` or `crypto-perp` market is worth pursuing

> **Owning module:** [`providers-and-market-data`](providers-and-market-data.md)

Whether a `crypto-spot` or `crypto-perp` market is worth pursuing at all, given that the current forecast assumes zero drift and therefore produces no directional signal. Perpetual funding rates are the one observable drift term available from either provider's API and are the natural first candidate.

### OD-6 — Historical backfill vendor and retention/cost target

> **Owning module:** [`providers-and-market-data`](providers-and-market-data.md), [`storage-and-architecture`](storage-and-architecture.md)

Historical backfill vendor and retention/cost target beyond the current Kraken weekly feed.

### OD-7 — Whether live signing should move off file-based RSA keys

> **Owning module:** [`trading-risk-and-budget`](trading-risk-and-budget.md)

Whether live signing should move from file-based Kalshi RSA keys to hardware/OS-keychain custody.

### OD-8 — Whether a market-wide dollar exposure ceiling is needed

> **Owning module:** [`trading-risk-and-budget`](trading-risk-and-budget.md)

Whether a market-wide dollar exposure ceiling across providers should complement the existing position and correlation caps, or whether per-trade sizing plus those caps remain sufficient. *(Deferred: unnecessary while one live provider exists.)*

### OD-9 — Whether the signed dashboard should be reachable from the public host

> **Owning module:** [`product-and-surfaces`](product-and-surfaces.md), [`trading-risk-and-budget`](trading-risk-and-budget.md)

Whether the signed dashboard should be reachable from the public host at all. Nothing on `noodle.money` requires a session, so `/login` and `/api/auth/*` are pure attack surface there; removing them is stronger than any throttle. The alternatives are a shared-state lockout counter, which would require write access from a role deliberately kept read-only, or edge/WAF rate limiting ahead of the function.

### OD-10 — Whether to pin dependency versions explicitly

> **Owning module:** [`storage-and-architecture`](storage-and-architecture.md)

Whether to pin dependency versions explicitly. 21 of 24 entries in `package.json` are `"latest"`, including `next`, `react`, and `typescript`. The lockfile keeps current installs reproducible, but any lockfile refresh can pull new majors silently and a compromised release of any of those packages would land automatically in a process that signs live orders.

### OD-11 — Alert channels

> **Owning module:** [`product-and-surfaces`](product-and-surfaces.md)

Alert channels (in-app, desktop, email, SMS/Telegram).

### OD-12 — Manual model-promotion criteria

> **Owning module:** [`forecasting-and-evidence`](forecasting-and-evidence.md)

Manual model-promotion criteria after the automatic 100-window walk-forward evaluation.

### OD-13 — Promotion thresholds for a policy candidate

> **Owning module:** [`policy-and-track-separation`](policy-and-track-separation.md)

Promotion thresholds for a **policy** candidate: how many independent settlement windows of committed sentinel evidence, and what clustered return margin over production, before a candidate becomes promotable. The model-promotion constants (60 held-out trades, 4 positive folds, 4 beating baseline, 2pp mean-window gap) are the obvious starting point but were tuned for a different question.

### OD-14 — Whether a candidate should emit sentinels for windows it refuses

> **Owning module:** [`policy-and-track-separation`](policy-and-track-separation.md)

Whether a candidate should also emit sentinels for windows it *refuses* that production takes. Recording only the extra trades measures the upside of a loosening but leaves a tightening with no forward evidence at all, which is the shape of every change adopted on 2026-08-13.

### OD-15 — Whether the adaptive regime gate should stay scoped to the policy version

> **Owning module:** [`policy-and-track-separation`](policy-and-track-separation.md)

Whether the adaptive regime gate should keep scoping its evidence to the buy policy version once policies become values. Three version bumps on 2026-08-13 each reset the gate to warming, leaving it inert for most of the day it was most needed.
