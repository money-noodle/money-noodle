# Trading, risk, and budget

> **Status:** Normative · **Parent:** [`SPEC.md`](../SPEC.md) · **Structurally verified:** 2026-08-26
> **Canonical for:** market/budget keying, account funding, paper/live orchestration, entries, exits,
> reconciliation, auditability, and trading security controls.
> **Read with:** [`policy-and-track-separation.md`](policy-and-track-separation.md) and
> [`providers-and-market-data.md`](providers-and-market-data.md).
>
> This module states durable funded and simulated-trading requirements. Version history, implementation progress,
> and measurements belong in the policy manifest, `STATUS.md`, decisions, designs, and reports.

## 3. Product surfaces

### 3.6 Budget and automated-trading control

The trading system has an independent durable working-budget ledger. Venue cash never silently increases the
amount automation may risk; the operator explicitly allocates it.

<a id="req-trading-market-keying"></a>

#### Markets and keying rules

A market is an instrument class plus horizon and settlement semantics. Every budget, order, forecast/policy row,
position, and summary carries explicit `marketId`, `providerId`, `providerVariantId`, and `strategyId` identities as
applicable. Adding a market is additive rather than a reinterpretation of historical rows.

Concerns are keyed by their actual dependency:

| Concern | Key | Requirement |
| --- | --- | --- |
| Budget | provider, allocated across enabled markets | Cash at one provider cannot authorize an order elsewhere. |
| Forecast model/calibration | market | Providers in one normalized market receive the same venue-independent probability. |
| Entry/sizing/execution policy | provider × market | Fees, ticks, quantity, and market structure are provider-specific. |
| Position/correlation caps | market, global across providers | One economic exposure cannot multiply because several providers list it. |

Provider capability is declared independently for every provider × market pair. Configuration cannot promote an
unimplemented capability, and capability for one market never unlocks another.

Market allocations are percentages of current provider equity: available plus reserved plus realized P&L.
Allocations are hard caps, sum to no more than 100% of enabled markets, and leave any remainder uncommitted. A
market's spendable amount is its own cap minus its own reservations, never total provider cash.

Candidate selection applies this order: shared forecast → provider/market policy → provider readiness →
provider/market funding → global exposure limits → expected dollar contribution at fundable/fillable size.
Reliability is a hard gate, not a ranking weight. Venue preference uses an explicit cents margin so negligible quote
noise cannot flip selection.

The accepted hourly threshold market activates in capability stages. H1 is public research only:
`marketData: true, paper: false, live: false`. Its ABOVE and BELOW rows are independent YES contracts with distinct
strikes, tickers, probabilities, quotes, and outcomes; neither may be inferred from the other's NO side. Assign
`crypto-1h` only when exact venue timestamps establish a 3,600-second open-to-close duration. H2 durable observation
and H3 paper capability require their own accepted ownership, outcome, policy, accounting, and isolation gates;
live remains withheld until a separate promotion. Exact implementation semantics live in
[`docs/second-market-hourly-crypto-design.md`](../docs/second-market-hourly-crypto-design.md).

<a id="req-trading-budget-model"></a>

#### Budget model

- Configured budgets and conservative reservations are durable safe integer cents.
- Venue-authoritative principal, fee, fill price, quantity, payout, and reporting P&L preserve legitimate
  fractional-cent precision.
- Starting budget, available budget, reservations, realized P&L, and working equity are tracked per provider; each
  market reports its allocation and reservations within that provider.
- The operator configures provider budget, market allocation percentages, and a fixed all-in purchase cap.
  Principal plus conservative fee reserve may not exceed that cap, market allocation, provider availability, or
  environment ceiling.
- Quantity rounds down on the venue lattice until principal plus conservative fee reserve fits. Venue fills/fees
  replace estimates; unused reserve releases without artificial P&L.
- Placement reserves planned all-in spend. Settlement releases payout and applies `payout − actual stake` to
  realized P&L.
- Budget changes require paused, quiescent state with no unresolved reservation conflict. Every configuration creates
  a durable epoch retained by reservations, orders, fills, settlements, and reconciliation adjustments.
- Closed-epoch and lifetime-live results are immutable and separately reportable. Reconfiguration cannot erase
  evidence used by lifetime safety limits.

<a id="req-trading-account-funding"></a>

#### Account funding and capability

- Every provider has independent durable research visibility, paper permission, and `liveEnabled` control. Disabling
  live does not hide research quotes, stop paper variants, or abandon reduce-only lifecycle handling.
- Zero providers may be live-enabled. Resume requires at least one explicitly enabled and trade-ready provider.
- A trade-ready provider has independently verified authentication, eligibility/environment, cash/collateral,
  placement, cancellation, order, fill, position, and reconciliation paths.
- Credentials, visible quotes, public positions, or paper history never imply live capability.
- Enablement changes are provider-specific, fail closed, and require quiescent pause plus authoritative
  reconciliation. Enabling one provider never enables another.
- Global and correlation exposure apply across providers. The same economic contract cannot be bought twice merely
  through different providers/variants; opposite exposure uses the protected reduce-only switch path.
- Funds remain at providers. Money Noodle stores risk allocation, not custody.
- Private keys live outside the repository and are referenced by path. The browser receives readiness/status, never
  key material or secret values.

<a id="req-trading-pause-resume"></a>

#### Control state and pause/drain

States are `unconfigured`, `paused`, `active`, and `depleted`; operational suspension/draining metadata is separate
from persisted operator intent. Automation starts paused and off by default.

Pause performs a quiescent drain:

1. withdraw active operator intent and block new selection;
2. serialize behind the execution queue;
3. cancel and authoritatively confirm every managed remainder;
4. reconcile order, fill, position, cash, and reservations; and
5. verify no pending or uncertain entry/exit intent.

Only then may the API report `paused · quiescent · restart safe`. Filled positions may remain open and reserved while
monitoring, exits, and settlement continue.

Resume requires configured budgets, fresh account state, healthy connectors, an available engine, authoritative
reconciliation, and every risk/capability check. Depleted equity blocks entries until paused reconfiguration funds a
new positive budget. Kill switch, stale state, venue disconnect, failed reconciliation, or configured epoch/lifetime
loss or drawdown limits block resume and new exposure.

Manual pause, kill, reconfiguration, mode change, depletion, and conservatively migrated legacy pauses withdraw
auto-resume permission. A system-originated ambiguity may retain prior active intent. Successful authoritative
reconciliation may auto-resume only that eligible system suspension after every ordinary readiness check; a manual
pause during suspension cancels permission. Free-form reason text can never grant authority.

<a id="req-trading-paper-engine"></a>

#### Paper mirror and bankroll

Paper uses the identical entry decision and relative sizing policy required by
[`policy-and-track-separation.md` req-policy-mirror-invariant](policy-and-track-separation.md#req-policy-mirror-invariant),
with separate execution, bankroll, ledger, P&L, positions, and report.

- The background cycle settles due paper positions before new entries, including while funded automation is paused.
- Paper is not serialized to live's one-order path; it may submit every independently selected candidate fitting its
  own funding and exposure state.
- Every eligible provider/variant runs continuously in an isolated paper account even when live-disabled. No variant
  consumes another's opportunity or conceals its return.
- Each paper order retains provider/variant, market/contract target, forecast, buy, execution, strategy, and exact
  provenance identities and settles against its own provider contract.
- Fills use venue quantity granularity, all-in cap, conservative fees, durable states, idempotent budget hooks, and
  configured position/correlation ceilings.
- Invalid/unsupported final outcomes return reserved stake as invalid rather than manufacturing P&L.
- Paper depletion/reset never pauses, resumes, funds, or mutates live state.

Independent maker simulation refreshes the exact contract, uses the shared pure price/reprice transitions and
issuance-sized quantity, and polls every two seconds over the same six-check/12-second managed horizon. It evaluates
public aggressor prints against displayed queue ahead. Ask touch alone is not a fill. Missing terminal evidence makes the attempt unavailable rather than a manufactured miss. A matched-live
overlay may report contemporaneous authoritative fill terms but cannot alter independent paper status, bankroll,
or P&L. Any calibration is versioned, manually adopted on held-out evidence, and cannot read the live result of the
row being simulated. Public trade evidence is eligible only when its venue event time lies in the exact inclusive
maker interval `[submittedAt, restingUntil]`; response time cannot extend that interval. A historical timing row
that consumed later evidence is unavailable rather than rewritten. Unaffected evidence may cross a corrective
execution generation only under a pre-outcome invariant filter, exact behavioral-equivalence proof, explicit
generation strata, and the original expected-coverage denominator.

The adaptive regime gate is a shared production-entry rule, not a cash/control state. It records at most one
highest-edge exact-contract recommendation per correlated settlement window after ordinary gates, measures bounded
fee-aware return with empirical variance and a default 12-window half-life, and remains permissive during its default
12-window current-policy warm-up. At 99% default estimated probability of negative return it closes entries; below
75% it reopens. A policy change starts fresh evidence. Closed state preserves operator intent and continues
collection, reconciliation, position monitoring, and reduce-only exits while blocking new/replacement exposure.
Manual pause and hard loss breakers retain non-auto-resume semantics.

<a id="req-trading-entry-maturity"></a>

#### Entry qualification and maturity

- Entry consumes the active manifest policy and a calculation no older than one 15-second observation window.
- Side-specific evidence cannot authorize the opposite side; selection cannot hold both sides of one asset/window.
- Provider selection requires fresh side-specific bid/ask, exact capability, funding, selected-side ask within the
  active policy band, spread no wider than 10¢, supported quantity, and provider-specific qualification. A quote on
  another provider cannot authorize the order.
- Raw signals remain immediately visible, but execution requires the first 90 seconds blocked, a currently qualified
  snapshot, at least two qualifying snapshots spanning 15 seconds, median net edge at least −5pp, quality at least
  50%, and no new entry in the final 30 seconds.
- A failed current snapshot resets persistence. Reprocessing one timestamp cannot manufacture observations.
- Signal qualification, maturity, portfolio selection, live authorization, venue attempt, and actual position are
  separate typed states on read surfaces.

<a id="req-trading-entry-route"></a>

#### Entry route, episodes, and sizing

Live entry receives at most three episodes per asset/side/window. A managed maker joins or improves the selected-side
bid, never crosses the issuance cap, manages for the bounded horizon, confirms cancellation, accepts partial fills,
and reconciles exact fees. YES/NO wire translation may use the venue's complementary book, but all limits, costs,
fills, P&L, and UI remain selected-side denominated.

An authoritative maker zero-fill may rearm only after ordinary persistence is recollected strictly after completion.
No nonqualifying gap is required. Any fill, working/uncertain state, rejection, taker result, stale policy, or third
episode ends rearming.

The production execution policy reruns route selection for every episode. The established high-edge route spends
the spread only when issuance and fresh taker net edge are each at least 30pp after fees, persistence-median edge is
at least 10pp, quality is at least 65%, and selected-side spread is no wider than 2¢. Every taker is a marketable IOC
**limit**, never an uncapped market order; it reruns the complete provider buy rule against a fresh quote, permits at
most 1.0¢ ask movement from issuance without exceeding the active entry ceiling, reserves at the worst permitted
price, and has no fallback after refusal or no-fill. The closed
bounded-taker pilot grants no new authorization; a future experiment requires a new decision and generation.

Entry sizing is `entry-sizing-reduce30-below-edge30-v1`: below 30pp issuance net edge, quantize the base all-in cap
to `ceil(base × 0.30 − 1e-9)`; at 30pp or above retain 1×. There is no arbitrary minimum or multiplier above one.
Refuse when the sized cap cannot fund venue minimum quantity plus fee reserve. Every order stamps base cap, issuance
edge, multiplier, and sized cap; all other funding/risk/reconciliation ceilings remain binding.

<a id="req-trading-intent-identity"></a>

#### Durable intent, identity, and uncertainty

- Persist client intent and reservation before submission; persist venue ID immediately after acceptance.
- Every episode has collision-resistant identity, predecessor/generation linkage, and separate durable recovery
  evidence. Presentation may group episodes by stable asset/window intent but cannot merge authority rows.
- Distinguish never-accepted post-only race, accepted/rested no-fill, pre-submit refusal, IOC no-fill, partial fill,
  full fill, rejection, and uncertainty.
- Non-definitive request/schema/amend/cancel/exit errors retain reservation, enter `uncertain`, safety-suspend, and
  launch authoritative reconciliation after the serialized operation.
- Only a definitive rejected post-only cross may release immediately. Venue absence is not rejection until the
  30-second consistency/reconciliation search passes.
- Every order captures an immutable entry-decision snapshot joining forecast, qualification, persistence, provider
  quote/cost, route, sizing, model/policy identities, basis/replay inputs, and factor explanations.
- Legacy rows retain original identity and are labeled when evidence was unavailable; they are never rewritten into
  the current generation.

<a id="req-trading-cancellation"></a>

#### Cancellation confirmation

DELETE success is not cancellation evidence. Bounded confirmation requires terminal canceled state, zero remainder,
absence from the complete resting-order set, and refreshed fills. Unknown/resting state, nonzero remainder,
contradictory fills/positions, or timeout fails closed and triggers full reconciliation.

<a id="req-trading-reconciliation"></a>

#### Reconciliation

Startup, manual, and pause/drain barriers perform a full current-account audit before funded exposure. They fetch
complete paginated cash, positions, orders, fills, and resting orders; match client and venue IDs; cancel and confirm
managed remainders; recover missing/partial entry and reduce-only fills; validate quantities; and align whole-cent
reservations without manufacturing P&L.

Unknown managed orders, unrelated resting orders, malformed/incomplete history, contradictory positions,
insufficient cash, external/local ownership ambiguity, or unconfirmed cancellation blocks and suspends execution.

Periodic reconciliation runs independently of collection every 300 seconds by default, configurable and clamped to
60–3,600 seconds. It reads current cash,
nonzero/unsettled positions, all resting orders, a checkpointed orders/fills interval with overlap and deduplication,
and exact state for every local nonterminal/uncertain/exit transaction. Known nonterminal orders refresh by ID; a
lost-response intent searches by durable client ID.

The checkpoint advances only after every page, pure comparison, ledger/budget commit, and recovered settlement
succeeds. Missing/malformed state or an unsafe venue-history watermark escalates to full audit. Venue reads occur
outside the ledger serializer while a `running` fence blocks new exposure; compare-and-commit rejects a stale
snapshot if local authority changed during reads.

First periodic failure blocks and retries after 30 seconds without changing operator intent; a second consecutive
failure safety-suspends and audits. Successful recovery may resume only under the system-suspension rule above. Unchanged successful passes do
not create redundant audit events. See
[`docs/incremental-background-reconciliation-design.md`](../docs/incremental-background-reconciliation-design.md).

<a id="req-trading-observation-isolation"></a>

#### Observation-only evidence isolation

Trajectory, settlement-average, maker-touch, queue/depth, direction, and open-position liquidation observations are
prospective immutable evidence. They may use already-authorized bounded reads but cannot alter forecast probability,
confidence, qualification, ranking, route, price, retry, size, selection, exit, budget, or reconciliation before a
separate held-out review and manual versioned promotion.

Ask touch is not queue fill. Displayed depth is a queue-ahead proxy, never exact priority. Missing optional depth
cannot authorize or block production behavior. Reports separate submission, acknowledgement race, accepted order,
rested no-fill, partial/full fill, and settlement and compare fill versus accepted-no-fill cohorts without assigning
spend to zero-fill rows.

<a id="req-trading-portfolio-switch"></a>

#### Portfolio selection and protected switching

Standalone qualification precedes constrained selection. Candidates rank by expected dollar profit after principal
and fees, then apply account-wide position, window, correlation, provider-funding, and risk ceilings. Source defaults
are nine total positions, six in one settlement window, and three per correlation group/window; total positions have
a hard configurable maximum of ten. Effective configuration may tighten source ceilings and is stamped as runtime
evidence; it cannot exceed hard maxima.

A replacement requires liquidation-plus-replacement future wealth to exceed optimistic hold after every spread,
fee, uncertainty, and configured minimum-gain margin. It also requires replacement probability at least 15pp above
the owned side, three distinct qualifying snapshots spanning 30 seconds, hysteresis, cooldown, and fresh readiness.
Same-asset opposite-side replacement additionally requires at least a 20pp probability advantage and positive net
future wealth; it can never coexist with the incumbent. When the portfolio is full, replacement value must exceed
incumbent hold by at least 1¢ after all exit and entry costs. Original cost is sunk for future action but retained in
realized P&L.

Switch exit is reduce-only IOC at the owned-side actionable bid. Zero fill keeps the incumbent; partial fill
reconciles and blocks replacement; only complete close may submit replacement. No replacement follows ambiguous
exit. Switching is disabled in the final 120 seconds and limited to one completed switch per settlement window.
The filled-order ceiling reserves capacity for both potential switch legs and counts only unique orders with nonzero
fills.

<a id="req-trading-reduce-only-sells"></a>

#### Reduce-only sell recommendations

`SELL` reduces the owned side and never opens reverse exposure. New DOWN/NO exposure is a separately qualified buy.
The action set is:

- **HOLD:** retain the incumbent to settlement.
- **EXIT TO CASH:** reduce held quantity without replacement.
- **SWITCH:** reduce incumbent, then conditionally buy a superior replacement only after complete exit.
- **BUY:** add a selected position when capital and exposure allow.

For held quantity `q` and owned-side probability `P(side)`, expected hold payout is
`H = q × 100¢ × P(side)`. Executable liquidation is `L = q × owned-side bid − exit fee`, adjusted for depth and
partial-fill risk. Entry cost is sunk for deciding future action but remains in P&L. With probability uncertainty
`u`, optimistic hold is `H⁺ = q × 100¢ × min(1, P(side)+u)`. A value exit requires `L − H⁺` to exceed the configured
minimum after spread, fee, persistence, and freshness. Probability below 50%, unrealized profit, or a prior winning
streak alone cannot trigger sale.

Sell families are separately versioned:

1. **Upgrade switch:** liquidation plus replacement beats hold under the protected-switch requirements.
2. **Thesis-break/value exit:** one fresh snapshot may exit when executable net cash exceeds uncertainty-adjusted
   optimistic hold by the required margin.
3. **Profit reversal:** after executable net profit reaches +75%, one later fresh snapshot may exit only when both
   executable value and owned-side probability decline from durable high-water observations.

Winning streaks across trades are forbidden inputs. Recommendations rank by risk-adjusted incremental expected cents
versus no action.

Standalone exits use fresh quote, reduce-only IOC quantity no greater than held amount, bounded owned-side price,
durable intent/client ID before submission, and exact fill/fee reconciliation. Zero/partial fill never authorizes
replacement or automatic retry. Ambiguity retains state and safety-suspends.

A completed standalone exit clears prior persistence and starts a 60-second cooldown. Any later same-window
re-entry requires three newly collected qualifying snapshots and all ordinary policy, timing, portfolio, budget,
risk, and reconciliation gates under a new durable generation.

<a id="req-trading-audit"></a>

#### Auditability

Persist every budget configuration, operator-intent/control transition, reservation, order, fill, cancellation,
settlement, P&L adjustment, depletion, connector failure, reconciliation result, and guarded recovery. Events retain
timestamp, typed reason, prior/new state, related forecast/order IDs, provider/market/strategy identity, budget
epoch, and model/policy versions where applicable. LLM output cannot configure, arm, resume, reconcile, or trade.

<a id="req-trading-security-controls"></a>

## 7. Security and trading controls

- Secrets live only in server environment variables or OS keychain/secret manager.
- No private key may exist inside the repository worktree, even ignored. Keys live outside it and are referenced by
  path; ignore rules are only a second line of defense.
- Key rotation requires worker restart so key ID and loaded material cannot diverge.
- Separate read and trading credentials/capabilities where supported. Read-only connectors contain no mutation
  methods; prefer venue-side read-only keys too.
- Authentication throttles failed guesses with a control effective across process/serverless fan-out.
- Browser responses contain capability/status only, never secrets or signed payloads.
- Every mutation and billable research route enforces authentication, same-origin/CSRF protection, and bounded input.
- Every order submission has an idempotency key and immutable preview/confirmation/response/fill/cancel/error audit.
- Configurable ceilings include order loss, epoch/lifetime loss and drawdown, exposure, filled-order rate, allowed
  providers/assets/markets, and price movement/slippage.
- Global kill switch is off by default and supersedes resume.
- Stale quote/account state, changed contract, disconnected provider, identity mismatch, or failed reconciliation
  blocks submission.
- Demo/paper capability precedes production placement.
- LLM output may draft research or a ticket but can never submit an order.
- Model promotion/rollback is a funded control: authenticated same-origin session, paused quiescent drain, zero
  reservation, written reason, typed phrase, exact runnable model identity, and immutable audit. Promotion cites an
  eligible run; rollback remains available without promotion eligibility because safety may require reverting.
