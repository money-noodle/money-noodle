# External venue position ownership boundary

> **Document type:** Safety design
> **Design status:** Accepted
> **Implementation:** Complete
> **Created:** 2026-08-25
> **Canonical requirements:** [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md)
> **Decision record:** [`DEC-20260825-03`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

> **Status: approved implementation design.** Written 2026-08-25 after operator confirmation that venue positions
> created outside Money Noodle are acceptable. This narrows which local lifecycle states claim an exact contract;
> it does not import external activity into Money Noodle accounting or permit ambiguous shared ownership.

## 1. Problem

`reconcileExecutionLedger` currently builds `currentManagedTickers` from every local Kalshi entry whose contract has
not closed. Lifecycle status is ignored. A local create that is authoritatively rejected therefore continues to
claim its ticker until close. If an acceptable external venue position exists in that exact ticker, reconciliation
compares the full account position with local open quantity zero, blocks the desk, and cannot recover until the
external position disappears.

The 2026-08-25 BNB and SOL episodes exposed this ownership error. Money Noodle's local creates returned
`market_not_found` and later reconciled to rejected with no accepted client order or fill. Separate external venue
positions were temporally present. Those events had no causal order identity in common, but the ticker-wide check
kept treating each rejected local attempt as an owner.

Ignoring all position differences would be unsafe. A position can still be the only visible evidence of a lost
response or a local fill/exit contradiction, and venue netting makes simultaneous independent ownership of the same
binary contract unsafe to infer.

## 2. Decision

An exact ticker is Money Noodle-managed for current-position comparison only while a local live Kalshi entry can
still own current venue exposure:

- status `open`;
- status `pending_reservation`;
- status `uncertain`; or
- an entry with `exitPending === true`.

The contract must also remain before its authoritative UTC close, preserving the current temporal boundary.
Rejected, unfilled, sold, won, lost, and invalid rows do not claim current venue position merely because their close
is still in the future.

Expected Money Noodle quantity remains the signed sum of local `open` entries. Pending and uncertain rows claim the
ticker but add zero expected quantity until exact venue order/fill evidence recovers them. Thus any nonzero venue
position still blocks while a local create might have been accepted. Once reconciliation proves that create absent
and changes it to `rejected`, an unrelated external position no longer creates a local ownership contradiction.

## 3. Safety boundaries

This is an ownership correction, not a permissive account-wide bypass:

1. An external position that overlaps an `open`, `pending_reservation`, `uncertain`, or exit-pending Money Noodle
   entry in the same exact ticker still blocks reconciliation.
2. A local open quantity that differs from the full venue quantity in its claimed ticker still blocks. The system
   does not guess an external offset or silently net it against local exposure.
3. Unknown, duplicate, or one-to-many Money Noodle order identity still blocks.
4. Unrelated resting orders retain their existing blocker. This change concerns settled/current position ownership
   only; it does not permit unowned contingent exposure.
5. Venue cash must still cover Money Noodle's whole-cent uncommitted budget. External activity receives no local
   reservation, P&L, settlement, or budget authority.
6. Global risk, kill switch, rate limits, reconciliation fences, startup/Resume authority, and guarded recovery are
   unchanged.
7. No external order or fill is copied into the execution ledger. External causal state remains outside Money
   Noodle.

If simultaneous external and Money Noodle ownership of one exact ticker is later required, this correction is
insufficient. That would need a separate durable external-order/fill ownership design or isolated venue account,
plus netting, reduce-only, risk, cash, and concurrent-actor fault evidence.

## 4. Implementation

Add one pure status-and-time ownership predicate in `lib/execution-reconciliation.ts`. Use it to construct
`currentManagedTickers`; leave `expectedByTicker`, exact order/fill matching, reservations, and every other issue
unchanged.

No environment switch or operator-maintained allowlist is introduced. Fail-open configuration would make a missing
or malformed ownership declaration indistinguishable from safe external activity.

## 5. Acceptance gates

1. A future rejected local attempt plus a nonzero same-ticker external position passes current-position comparison.
2. Future unfilled and terminal local attempts likewise do not claim the ticker.
3. Future uncertain and pending-reservation local attempts plus a nonzero same-ticker position still block.
4. A future open local entry still requires exact signed venue quantity for both UP and DOWN.
5. An exit-pending entry still claims its ticker.
6. A rejected row cannot hide a contradiction on another actively owned ticker.
7. `venueManagedPositions` counts only tickers currently claimed by Money Noodle.
8. Unrelated resting orders, duplicate ownership, overfill, reservation ceilings, and cash-floor tests remain
   unchanged.
9. Typecheck, full tests, production build, execution-ledger verification, and invariant suites pass before rollout.
10. Activation uses build first, operator pause/drain, restart, authoritative READY startup reconciliation, explicit
    Resume, and a bounded live-control check.

## 6. Authority and evaluation

This is a **safety ownership invariant**. Higher return, uptime, or fewer pauses cannot justify it. Its authority is
the exact causal lifecycle definition and the fault grid above. It changes no forecast, entry rule, confirmation,
venue choice, portfolio ranking, size, price, fee, exit economics, paper behavior, or promotion state.
