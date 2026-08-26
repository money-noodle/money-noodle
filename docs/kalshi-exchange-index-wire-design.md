# Kalshi dynamic exchange-index wire identity

> **Document type:** Safety design
> **Design status:** Accepted
> **Implementation:** Complete
> **Created:** 2026-08-25
> **Canonical requirements:** [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md), [`spec/providers-and-market-data.md`](../spec/providers-and-market-data.md)
> **Decision record:** [`DEC-20260825-02`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

> **Status: approved implementation design.** Written 2026-08-25 after the operator approved an immediate
> fail-closed repair and funded automation was paused/drained at revision 6,633. This changes venue wire routing
> identity only; it does not change forecast, entry, route, price, quantity, fee, exit policy, capital, or paper.

## 1. Problem and current evidence

Every Kalshi event-order body in `src/lib/live-orders.ts` hardcodes `exchange_index: 0`: maker create, maker amend,
taker IOC entry, and reduce-only IOC exit. The exact market response already owns this field, but the signed
pre-submit read discards it.

A current-session reconstruction at 2026-08-25T08:06Z found:

- the last accepted Money Noodle live order was created at 03:51:23Z;
- the following **15 consecutive create attempts**, from 04:11:24Z through 08:03:48Z, returned
  `market_not_found · market not found` and later reconciled absent;
- fresh public exact-market responses for the active BTC, ETH, SOL, DOGE, BNB, and HYPE 08:30Z contracts all
  returned `exchange_index: 2`;
- exact BNB and DOGE 08:15Z responses likewise returned active status and index 2 while Money Noodle sent index 0.

This is strong same-session evidence that the hardcoded wire index is stale. It is not permission to replace one
constant with another: exchange index is venue-owned exact-contract identity and may change again.

## 2. Classification

This is a **safety and venue-target-integrity invariant**. Success is exact routing and fail-closed behavior, not
higher return or an automatically increased fill rate. A wrong or unknown index must never be guessed.

## 3. Decision

### 3.1 Validate identity at ingest

The signed exact-market response used immediately before submission must contain:

- `market.ticker` exactly equal to the requested ticker;
- `market.status === 'active'`;
- finite usable bid/ask when the path requires a quote;
- `market.exchange_index` as a non-negative safe integer.

Missing, string-coerced, fractional, negative, non-finite, or mismatched values fail before wire submission. There
is no fallback to 0, 2, a registry value, or a previous contract.

### 3.2 Capture one index per transaction

- **Maker create:** each refreshed create quote carries its exact exchange index. The first create attempt captures
  it. A post-only retry may refresh price but must return the same index; a changed index fails closed rather than
  sending another create.
- **Maker amend:** every management quote must retain the accepted create's index. Amend uses that captured index;
  mismatch aborts management and enters the existing cancellation/uncertainty path.
- **Taker entry:** its exact pre-submit quote supplies the index used by the IOC body.
- **Reduce-only exit:** perform a fresh signed exact-market identity read immediately before the IOC and use its
  validated index. Exit remains reduce-only and keeps its caller-approved quantity and minimum price.

Cancellation and authoritative reconciliation continue to use venue order/client identity and require no exchange
index guess.

### 3.3 Durable audit identity

Persist the accepted entry index as optional `venueExchangeIndex` and accepted exit index as optional
`exitVenueExchangeIndex` on the owning local order. Historical rows remain valid without either field. Entry
execution observations also carry the exact index read at create/management time. These fields are audit evidence;
they do not authorize reconciliation, sizing, settlement, or policy.

## 4. Wire boundaries

Pure maker-create, maker-amend, taker-entry, and reduce-only-exit body builders must all require a validated
`exchangeIndex` argument and place exactly that integer in `exchange_index`. Prices and counts remain fixed-decimal
strings formatted only in these wire builders. No arithmetic or existing side conversion changes.

The exact market identity and index are provider-specific mechanics and remain inside `src/lib/live-orders.ts`; they do
not enter generic strategy, market registry, paper simulation, or prediction types beyond optional execution audit
fields.

## 5. Failure behavior

- A missing/malformed/mismatched exact market fails before any order request and retains existing caller handling.
- A create or exit transport failure after submission remains ambiguous; reservation and reconciliation semantics
  do not change.
- A definitive post-only crossing retains its existing bounded retry behavior, provided refreshed identity remains
  unchanged.
- `market_not_found` is not reclassified by this change. If it persists after the wire index is corrected, the
  existing 30-second consistency and authoritative reconciliation path remains in force and the diagnosis reopens.

## 6. Acceptance gates

1. Pure validation rejects absent, string, fractional, negative, infinite, unsafe, ticker-mismatched, and inactive
   market identity.
2. Every create/amend/taker/exit body carries an injected nonzero index exactly; source contains no
   `exchange_index: 0` fallback.
3. UP/DOWN price and side translation remains exactly unchanged for every body.
4. Maker post-only retry retains one captured index; changed refreshed identity sends no retry.
5. Maker management sends no amend under changed identity and still confirms cancellation or becomes uncertain.
6. Taker and exit read exact identity before submission and persist accepted index with venue order identity.
7. Missing index produces no signed write in mocked runtime tests.
8. Existing live-order audit, target-integrity, reconciliation, budget-ledger, mirror, strategy-isolation, and
   policy-manifest invariants remain unchanged and pass.
9. Typecheck, full tests, lint, production build, execution-ledger verification, source search, and diff check pass.
10. Activation requires the already-established operator pause, build first, built-worker restart, authoritative
    READY startup reconciliation, explicit Resume, and monitoring of natural opportunities. No artificial funded
    test order is permitted.

## 7. Rollback

Rollback is code-only while paused: restore the prior build, restart, reconcile, and leave funded automation
manually paused. Do not restore the stale constant as an operational workaround. If the venue omits index again,
Money Noodle stays fail-closed until a separately verified wire design exists.
