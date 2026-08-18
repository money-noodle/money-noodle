/**
 * Counterfactual: what if the desk took the ask instead of resting a maker order?
 *
 *   npm run analyze:take-the-ask
 *
 * WHY
 *   `analyze:entry-realization` measures the leak; this prices the obvious response to it. Under v17 the
 *   orders that filled won 25 points less than the orders that did not (t = −3.6 live, −3.8 paper), while
 *   the desk captured a ~4c maker discount. A resting buy fills when someone sells into it, so buying
 *   lower and being wrong are the same event. Taking the ask pays that 4c and the taker fee, and in
 *   exchange fills everything — including the trades the maker approach was missing, which are the winners.
 *
 * WHAT IT MEASURES, PER POLICY COHORT AND TRACK
 *   A. as traded            — what actually happened, realized, filled orders only.
 *   A2. as filled, held      — the same maker fills, settled instead of exited. **A2 is the control that
 *      makes B readable**: A includes the standalone exits and B does not, so A-to-B mixes the price
 *      change with the exit rule. A2-to-B is the price change alone.
 *   B. take the ask, filled only — the same fills, repriced at the issuance ask with the taker fee. This
 *      isolates the **price** effect: what the discount was worth, ignoring the fill-rate effect.
 *   C. take the ask, every decision — every decision filled at the issuance ask, held to settlement. This
 *      is the actual alternative policy, and the difference between C and B is the fill-rate effect.
 *
 * THE CORRECTIONS THAT DECIDE THE ANSWER
 *   1. **Return per $1 staked flatters the maker**, because a decision that never fills stakes nothing and
 *      silently leaves the average. Total P&L per 100 decisions is reported beside it: a budget-constrained
 *      desk cares what its capital earns per opportunity, not per fill.
 *   2. **Decisions are deduplicated** to one per (symbol, window, side). The maker path issues several
 *      orders per decision as it reprices; a taker issues one. Counting retries as separate takes would
 *      multiply the counterfactual's fees and stake.
 *   3. Returns are clustered on the settlement window, error over windows (AGENTS §5.1).
 *
 * BIASES AND LIMITS
 *   - **The exit is not modelled in the counterfactual.** Arm A includes whatever the standalone exits did;
 *     B and C are held to settlement. The comparison is therefore policy-vs-policy, not fill-vs-fill, and a
 *     profitable exit rule would be credited to A only.
 *   - **Capacity is assumed.** Filling every decision means more orders than the hourly ceiling and the
 *     budget would have allowed. C is an upper bound on deployment, not a schedule the desk could run.
 *   - Taking is assumed to fill at the issuance ask in full. A thin book fills worse.
 *   - Settlement joined per window from the resolved forecast history.
 *   - Read-only; places no order and writes nothing. Nothing here promotes anything (AGENTS §5.5).
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');
const SHARDS = path.join(DATA, 'forecast-history-shards');
const COHORTS = ['-v17', 'fresh2pp-v18'];

/** Kalshi charges nothing on a resting fill and `0.07 * p * (1 - p)` on a taking one. */
const takerFeeCents = (venue, priceCents, quantity) => venue === 'polymarket'
  ? Math.max(1, Math.ceil(100 * quantity * 0.01 * (priceCents / 100) - 1e-9))
  : Math.max(1, Math.ceil(100 * quantity * 0.07 * (priceCents / 100) * (1 - priceCents / 100) - 1e-9));

/** Largest 0.01-increment purchase fitting the all-in cap; mirrors `estimatePaperFill`. */
function fill(stakeLimitCents, askCents, venue) {
  if (!(askCents > 0) || askCents > 99) return null;
  const step = venue === 'polymarket' ? 1 : 0.01;
  const maximumUnits = Math.floor((stakeLimitCents / askCents + 1e-9) / step);
  for (let units = maximumUnits; units > 0; units -= 1) {
    const quantity = Number((units * step).toFixed(2));
    const purchase = Math.ceil(quantity * askCents - 1e-9);
    const stake = purchase + takerFeeCents(venue, askCents, quantity);
    if (stake <= stakeLimitCents) return { quantity, stakeCents: stake };
  }
  return null;
}

function clustered(rows) {
  const windows = new Map();
  for (const row of rows) windows.set(row.key, [...(windows.get(row.key) ?? []), row.value]);
  const perWindow = [...windows.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  if (!perWindow.length) return { mean: null, standardError: null, windows: 0 };
  const mean = perWindow.reduce((a, b) => a + b, 0) / perWindow.length;
  return {
    mean,
    standardError: perWindow.length > 1
      ? Math.sqrt(perWindow.reduce((s, v) => s + (v - mean) ** 2, 0) / (perWindow.length - 1) / perWindow.length) : null,
    windows: perWindow.length,
  };
}

const outcomes = new Map();
const absorb = (list) => {
  for (const row of list) if (row.status === 'resolved' && row.outcome) outcomes.set(`${row.symbol}|${row.closesAt}`, row.outcome);
};
const index = JSON.parse(await readFile(path.join(SHARDS, 'index.json'), 'utf8'));
for (const shard of index.shards) absorb(JSON.parse(await readFile(path.join(SHARDS, shard.file), 'utf8')));
if (existsSync(path.join(SHARDS, 'open.json'))) absorb(JSON.parse(await readFile(path.join(SHARDS, 'open.json'), 'utf8')));

const allOrders = JSON.parse(await readFile(path.join(DATA, 'paper-orders.json'), 'utf8')).orders
  .filter((o) => !o.id.includes(':exit:') && o.strategyId !== 'long-shot-round-trip');

const wasFilled = (o) => ['won', 'lost', 'sold', 'open'].includes(o.status);
const stakeOf = (o) => o.actualStakeCents ?? o.stakeCents;
const pnlOf = (o) => o.actualPnlCents ?? o.pnlCents ?? 0;

const signed = (value, digits = 1) => value === null ? '—' : `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`;

for (const cohort of COHORTS) {
  const orders = allOrders.filter((o) => (o.entryDecision?.policyVersion ?? '').endsWith(cohort));
  if (!orders.length) continue;
  console.log(`\n================ ${cohort.replace(/^-/, '')} ================`);

  for (const mode of ['live', 'paper']) {
    // One decision per (symbol, window, side): the maker path reprices, a taker would issue once.
    const decisions = new Map();
    for (const order of orders.filter((o) => o.executionMode === mode)) {
      const key = `${order.symbol}|${order.closesAt}|${order.side}`;
      const seen = decisions.get(key);
      // Prefer a filled order as the representative, else the earliest attempt.
      if (!seen || (wasFilled(order) && !wasFilled(seen)) || Date.parse(order.createdAt) < Date.parse(seen.createdAt)) {
        decisions.set(key, order);
      }
    }
    const rows = [...decisions.values()].filter((o) => outcomes.has(`${o.symbol}|${o.closesAt}`));
    if (rows.length < 10) { console.log(`${mode}: too few decisions (${rows.length})`); continue; }

    const traded = [];
    const makerHeld = [];
    const takeFilled = [];
    const takeAll = [];
    let tradedPnl = 0, makerHeldPnl = 0, takeFilledPnl = 0, takeAllPnl = 0;
    let tradedStake = 0, takeAllStake = 0, takeable = 0;

    for (const order of rows) {
      const won = outcomes.get(`${order.symbol}|${order.closesAt}`) === order.side;
      const askCents = (order.issuanceAskPrice ?? order.askPrice) * 100;
      const sized = fill(order.stakeCents, askCents, order.venue ?? 'kalshi');

      if (wasFilled(order)) {
        const stake = stakeOf(order);
        if (stake > 0) {
          traded.push({ key: order.closesAt, value: pnlOf(order) / stake });
          tradedPnl += pnlOf(order);
          tradedStake += stake;
          // The same fill, settled rather than exited: the control that isolates the price effect.
          const heldPayout = won ? (order.filledCount ?? order.quantity) * 100 : 0;
          makerHeld.push({ key: order.closesAt, value: (heldPayout - stake) / stake });
          makerHeldPnl += heldPayout - stake;
        }
      }
      if (!sized) continue;
      takeable += 1;
      const payout = won ? sized.quantity * 100 : 0;
      const value = (payout - sized.stakeCents) / sized.stakeCents;
      takeAll.push({ key: order.closesAt, value });
      takeAllPnl += payout - sized.stakeCents;
      takeAllStake += sized.stakeCents;
      if (wasFilled(order)) {
        takeFilled.push({ key: order.closesAt, value });
        takeFilledPnl += payout - sized.stakeCents;
      }
    }

    const a = clustered(traded), a2 = clustered(makerHeld), b = clustered(takeFilled), c = clustered(takeAll);
    const per100 = (pnl, n) => n ? (100 * pnl / n).toFixed(0) : '—';
    console.log(`${mode}: ${rows.length} decisions, ${traded.length} filled by the maker (${(100 * traded.length / rows.length).toFixed(0)}%)`);
    console.log('  arm                          n   windows   return/$1        total P&L   per 100 decisions');
    console.log(`  A as traded            ${String(traded.length).padStart(7)}${String(a.windows).padStart(10)}`
      + `   ${`${signed(a.mean === null ? null : 100 * a.mean)}%${a.standardError === null ? '' : ` ±${(100 * a.standardError).toFixed(1)}`}`.padEnd(16)}`
      + `${String(Math.round(tradedPnl)).padStart(7)}c${per100(tradedPnl, rows.length).padStart(15)}c`);
    console.log(`  A2 as filled, held     ${String(makerHeld.length).padStart(7)}${String(a2.windows).padStart(10)}`
      + `   ${`${signed(a2.mean === null ? null : 100 * a2.mean)}%${a2.standardError === null ? '' : ` ±${(100 * a2.standardError).toFixed(1)}`}`.padEnd(16)}`
      + `${String(Math.round(makerHeldPnl)).padStart(7)}c${per100(makerHeldPnl, rows.length).padStart(15)}c`);
    console.log(`  B take ask, filled only${String(takeFilled.length).padStart(7)}${String(b.windows).padStart(10)}`
      + `   ${`${signed(b.mean === null ? null : 100 * b.mean)}%${b.standardError === null ? '' : ` ±${(100 * b.standardError).toFixed(1)}`}`.padEnd(16)}`
      + `${String(Math.round(takeFilledPnl)).padStart(7)}c${per100(takeFilledPnl, rows.length).padStart(15)}c`);
    console.log(`  C take ask, every one  ${String(takeAll.length).padStart(7)}${String(c.windows).padStart(10)}`
      + `   ${`${signed(c.mean === null ? null : 100 * c.mean)}%${c.standardError === null ? '' : ` ±${(100 * c.standardError).toFixed(1)}`}`.padEnd(16)}`
      + `${String(Math.round(takeAllPnl)).padStart(7)}c${per100(takeAllPnl, rows.length).padStart(15)}c`);
    console.log(`  capital deployed: maker ${Math.round(tradedStake)}c vs taker ${Math.round(takeAllStake)}c on ${takeable} takeable decisions`);
  }
}

console.log('\nA includes the standalone exits; B and C are held to settlement, so a profitable exit is');
console.log('credited to A alone. C assumes capacity the hourly order ceiling and budget would not have given.');
console.log('Nothing here promotes anything: a live-money change needs a policy-manifest entry and a decision.');
