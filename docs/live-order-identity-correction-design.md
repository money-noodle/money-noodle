# Collision-resistant live entry identity and HYPE ledger correction

> **Document type:** Safety design
> **Design status:** Accepted
> **Implementation:** Complete
> **Created:** 2026-08-20
> **Canonical requirements:** [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md)
> **Decision record:** [`spec/decision-log.md`](../spec/decision-log.md)
> **Design index:** [`docs/README.md`](README.md)

> Approved by the maintainer on 2026-08-21 before implementation. This repairs the repeated-entry-episode
> identity defect recorded in `reports/kalshi-order-size-and-fill-mechanics-2026-08-20.md` §6. It changes
> identity and reconciliation safety, not the buy rule, episode policy, sizing, route selection, or exits.

## 1. Incident and authority

One Kalshi order and fill were attributed to all three local HYPE UP episodes for the
`2026-08-20T14:30:00Z` window. The signed venue order was accepted during episode 3 under client ID
`live:HYPE:UP:2026-08-20T14:30:-2`, venue order ID
`01a01f8a-3f48-7bce-9aeb-ceabbbdace9b`, and filled 0.47 contracts at 57¢. Episodes 1 and 2 retain complete
managed-maker observations ending in terminal zero fills of 0/0.58 and 0/0.55. Kalshi did not duplicate the
fill; local fuzzy matching did.

The cause has two halves:

1. acknowledgement-race retries used `${clientOrderId.slice(0, 30)}-${attempt}`, deleting the episode suffix;
2. reconciliation treated those same truncated forms as valid matches for every local episode sharing the
   first 30 characters.

The authoritative correction therefore keeps episode 3 as the sole fill and restores episodes 1 and 2 to
maker zero-fills. The two false whole-cent losses were 27¢ each, so live budget control receives +54¢.
Exact order reporting improves by 2 × 26.79¢ = 53.58¢. Those views remain separate.

## 2. New client identity

New live edge entries use a deterministic bounded identifier:

```text
live:v2:<first 32 lower-case hex characters of SHA-256(full local episode order ID)>
```

The base is 40 characters. Maker create attempts use the exact base for attempt 0 and append `-1` or `-2`
for acknowledgement-race retries, so the maximum is 42 characters. No component is truncated. The
human-readable `PaperOrder.id`, logical ID, episode suffix, and predecessor linkage remain unchanged.

The complete local episode ID is hashed only after episode numbering is final. Before reservation or
submission, another live order carrying the generated client ID is a hard error. A SHA-256 prefix collision
is therefore both cryptographically remote and fail-closed rather than silently shared.

Taker entries use the same base identity without a create-attempt suffix. Historical IDs remain readable;
there is no backfill of client IDs already sent to Kalshi. The live execution generation advances to
`maker-high30-requalify3-fresh1c-idv2-v6`, so a zero-fill from the unsafe identity generation cannot rearm
a v6 episode; the episode count, persistence rule, sizing, and route policy themselves are unchanged.

## 3. Exact reconciliation and one-to-one ownership

Reconciliation removes the 30-character legacy fallback.

- A historical order matches an exact client ID or its already-persisted venue order ID. A legacy
  30-character `-1`/`-2` record may be recognized only as a canceled zero-fill create rejection when its
  fill and remainder are both zero and its prefix belongs to a local legacy intent; it is never returned as
  a match and can supply no fill authority.
- A v2 order matches its exact base, exact `-1`/`-2` create-attempt IDs, or its persisted venue order ID.
- One local intent may own multiple venue order records (the existing amendment-chain case).
- One venue order may never belong to multiple local entry rows. Reconciliation detects that relation
  before applying fills, emits a blocking issue, and excludes the ambiguous venue order from every local
  fill calculation.
- A managed venue order with no exact owner remains a blocking orphan.

This preserves crash recovery for a v2 accepted response lost before `venueOrderId` was persisted while
preventing one later episode from repairing earlier rows.

## 4. Auditable historical correction

Ledger envelope v8 adds append-only `liveCorrections`. The dedicated correction generation is
`live-order-identity-correction-v1` with stable ID
`live-order-identity-correction:hype-up:2026-08-20T14:30:00Z`.

The correction tool is report-only by default and requires `--write`. It refuses unless:

- the local server is stopped;
- control is operator-paused with zero reservation;
- all three exact local rows and the canonical venue ID exist;
- episodes 1 and 2 contain terminal zero-fill observations;
- episode 3 contains the 0.47 terminal fill;
- the three corresponding 27¢ settlement audit events exist; and
- the live budget identity `starting + realized == available + reserved` holds.

On application it:

1. records before/after snapshots and the canonical episode/venue identity in `liveCorrections`;
2. restores episodes 1 and 2 to `unfilled`, `filledCount: 0`, original requested quantities and 30¢ issuance
   stakes, removes copied venue/fill/settlement/P&L fields, and stamps the correction ID;
3. leaves episode 3 unchanged as the sole real fill and loss;
4. adds 54¢ to whole-cent live `availableBudgetCents` and `realizedPnlCents`; and
5. appends a stable `corrected` trading-control audit event citing both false rows and the canonical row.

The correction preserves the original wrong values inside its before snapshots and preserves every
execution observation. It is an idempotent two-projection transaction: the ledger projection is written
atomically first, then control. If the process stops between them, rerunning recognizes the stable correction
ID and applies only the missing projection. No journal is truncated or rewritten.

## 5. Deployment and safety

1. Keep operator intent paused and confirm zero live positions/reservations.
2. Typecheck, lint, run all tests and invariants, and build.
3. Stop the worker so no paper cycle can rewrite `paper-orders.json` during correction.
4. Run the correction dry-run, apply with `--write`, and rerun dry-run to prove idempotence.
5. Restart the built worker and require startup reconciliation READY with zero positions.
6. Verify ledger v8, exactly one HYPE fill, +54¢ control correction, and no one-to-many ownership.
7. Push and deploy. Do not resume funded execution automatically.

Tests pin deterministic distinct IDs across episodes and create attempts, the 42-character bound, rejection
of non-v2 maker retries, exact legacy behavior, lost-response recovery, one-venue-to-one-local ambiguity,
correction preconditions, exact versus whole-cent deltas, and idempotence.
