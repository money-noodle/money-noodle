# Paper bankroll fundings

> Design written before the code, 2026-08-17. Agreed in prose: detach paper from the live epoch, and give
> paper a history by reset that mirrors live's history by epoch. **No code changes with this document.**

## 1. What exists today

**Live has real funding epochs.** `nextBudgetEpoch` (`lib/budget-epoch.ts`) mints `epochId`,
`epochSequence` and `epochStartedAt` on every reconfiguration of the trading control. Orders are stamped,
and the id is load-bearing: `live-risk-policy` scopes drawdown by it, `stake-expansion-policy` scores per
epoch, and `/api/performance` publishes `liveEpochs` and `liveLifetimePnlCents`.

**Paper has a reset counter, which is not the same thing.** `resetPaperBudget` rebuilds the bankroll as
`{ startingCents, availableCents, realizedPnlCents: 0, resets: +1, startedAt }`. No identity is minted and
nothing is stamped on an order.

**Paper orders nonetheless carry a `budgetEpochId` — the live control's.** `buildOrder` stamps
`status.control.epochId` regardless of execution mode, so 216 paper orders are labelled with a live
funding funding that never funded them. That is the detachment this design removes.

## 2. Why it matters now rather than eventually

`resets` is 0: the paper bankroll has never been reset, so every paper order belongs to the original
bankroll and the reconciliation established on 2026-08-17 holds by accident.

**The first reset breaks it silently.** `resetPaperBudget` zeroes `realizedPnlCents` and sets a new
`startingCents`, while `correctedPaperPnlCents` sums every settled paper order — and no paper order can be
attributed to a bankroll funding, because the stamped id belongs to live and does not change on a paper
reset. The budget panel would immediately show its "does not reconcile" notice with the entire pre-reset
P&L as the residual. The defect is armed, not firing.

## 3. The model

One idea, expressed twice, because the two budgets are funded by different acts:

| | live | paper |
| --- | --- | --- |
| what opens a funding | reconfiguring the trading control | resetting the paper bankroll |
| identity | `epoch-{sequence}-{startedAt}` | `paper-{sequence}-{startedAt}` |
| stamped on the order as | `budgetEpochId` | `paperBankrollId` |
| orders predating identity | `LEGACY_BUDGET_EPOCH_ID` | `LEGACY_PAPER_BANKROLL_ID` |

`orderEpochId(order)` becomes the single mode-aware accessor and everything downstream is unchanged:

```
paper -> order.paperBankrollId ?? LEGACY_PAPER_BANKROLL_ID
live  -> order.budgetEpochId   ?? LEGACY_BUDGET_EPOCH_ID
```

`epochResults(orders, mode, currentId)` and `lifetimeRealizedPnlCents(orders, mode)` are already
mode-generic and only ever called with `'live'`. They need no change — they start working for paper the
moment paper orders carry an identity.

### Why a separate field rather than reusing `budgetEpochId`

Order records are append-only evidence and are never rewritten, so the 216 paper orders already stamped
with a live epoch id are permanent. Overloading one field would leave those records ambiguous forever —
unreadable without knowing the date the meaning changed. A distinct field makes the old stamp harmless
metadata (which live epoch happened to be current) and the new one unambiguous from its first write.

Paper orders stop being stamped with `budgetEpochId` going forward. Nothing reads it for paper.

### Why the legacy constant rather than a migration

Every existing paper order belongs to the original bankroll, because paper has never been reset. Naming
that funding explicitly is exact, needs no ledger rewrite, and reuses the pattern
`LEGACY_BUDGET_EPOCH_ID` already established for live's pre-epoch orders.

## 4. Reconciliation after a reset

Paper's reconciling P&L becomes funding-scoped, exactly as live's is epoch-scoped:
`startingCents + realizedPnlCents == equity` holds across a reset, because both sides restart together.
`lifetimePnlCents` keeps summing every funding and continues to tie to nothing, by design.

The maker-fee and drift corrections stay attached to the bankroll rather than to a funding. They
adjust what the *records* imply, which is a property of the orders, not of the funding that bought them.
A reset after a correction must therefore not re-apply it — the correction's `orderIds` already make it
idempotent, and this design does not change that.

## 5. Scope question this design does not settle

**Live's history is computed and rendered nowhere.** `/api/performance` has published `liveEpochs` and
`liveLifetimePnlCents` for some time and no component reads either. So "give paper a history like live"
currently means "give paper an invisible history like live's".

Two ways to finish, and this is the decision to take before coding:

1. **Data only.** Mint paper fundings, stamp them, publish `paperEpochs` and `paperLifetimePnlCents`
   beside the live pair. Symmetric, small, and the histories stay unrendered until something needs them.
2. **Data and surface.** The same, plus one history table in the Performance dialog listing both tracks'
   fundings — started, trades, settled, staked, realized, and which is current.

Option 2 is what makes the feature real; option 1 is what makes it correct. They are not in conflict, and
option 1 is a prerequisite either way.

**Decided 2026-08-17: option 2.** Both tracks' fundings are published and rendered in one Funding
history table in the Performance dialog, which also gives live's history its first surface. The table
shows `budgetPnlCents`, the whole-cent view that reconciles with a funding's starting balance;
`realizedPnlCents` stays the exact reporting view because `stake-expansion-policy` reads it and its
definition must not drift without that gate being re-evidenced.

## 6. What this design deliberately does not do

- **It does not rewrite a single order record.** §3 of the agent rules forbids it and the existing stamps
  are evidence of what the desk actually did.
- **It does not touch live.** Live's epochs are correct and load-bearing; this only stops paper borrowing
  their identity.
- **It does not change any reset behaviour.** `resetPaperBudget` still refuses while paper positions are
  open, still preserves order history, and still zeroes only the bankroll.
- **It does not make paper's funding load-bearing for risk.** Live's epoch gates drawdown and stake
  expansion. Paper's funding is for attribution and reporting only; no gate should read it without its
  own evidence and decision.

## 7. Verification

1. `orderEpochId` returns the legacy paper identity for every order written before this change, and the
   minted identity after — over a grid of modes and missing fields, not a fixture.
2. `epochResults(orders, 'paper', currentId)` groups the existing 856-order history into one funding
   and marks it current.
3. A simulated reset opens a second funding, and `startingCents + realizedPnlCents == equity` holds on
   both sides of it while `lifetimePnlCents` spans both.
4. Live figures are byte-identical before and after: no live order's attribution may move.
