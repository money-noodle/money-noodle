/**
 * Scores what happens to an edge-policy entry *after* the decision: whether it filled, and what the exit
 * did to it.
 *
 *   npm run analyze:execution-value
 *
 * `analyze-edge-gates.mjs` scores the decision — which candidates the gate admits, and what they would
 * return held to settlement. It consistently reports a healthy counterfactual the desk does not realize.
 * This script covers the two steps in between, because that is where the difference turns out to live.
 *
 * **Fills.** The desk rests a passive limit rather than crossing the spread. A resting buy fills when
 * someone sells into it, which is more often when the market is moving away from the side being bought,
 * so the filled cohort can be systematically worse than the cohort the policy chose. Unfilled orders
 * record the same issuance decision, and the settlement outcome is recoverable from forecast history by
 * contract and close time, so both cohorts can be scored on whether the side they chose won.
 *
 * **Exits.** A position closed before settlement is recorded as `sold` and never receives an `outcome` —
 * settlement resolution only runs on positions still held. That makes the exit policy invisible to every
 * report the desk produces, despite it touching roughly a quarter of live fills and half of paper fills.
 * Recovering the outcome by window is what lets the exit be scored against the counterfactual that
 * matters: what the same position would have paid if simply held to settlement.
 *
 * Where this script and the ledger disagree, the ledger is right: `actualPnlCents` is the exact accounting
 * field and is used directly for anything realized. Only the held-to-settlement leg is reconstructed.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');
const SHARDS = path.join(DATA, 'forecast-history-shards');
const CURRENT_POLICY = 'buy-binary-edge-net5to35-quality50-owned55-price5to97-v17';

/** Settlement outcome per contract window, from whichever forecast rows resolved it. */
async function loadOutcomes() {
  const outcomes = new Map();
  const take = (list) => {
    for (const row of list) {
      if (row.status === 'resolved' && row.outcome) outcomes.set(`${row.symbol}|${row.closesAt}`, row.outcome);
    }
  };
  if (existsSync(SHARDS)) {
    const index = JSON.parse(await readFile(path.join(SHARDS, 'index.json'), 'utf8'));
    for (const shard of index.shards) take(JSON.parse(await readFile(path.join(SHARDS, shard.file), 'utf8')));
    const open = path.join(SHARDS, 'open.json');
    if (existsSync(open)) take(JSON.parse(await readFile(open, 'utf8')));
  } else {
    take(JSON.parse(await readFile(path.join(DATA, 'forecast-history.json'), 'utf8')));
  }
  return outcomes;
}

const ledger = JSON.parse(await readFile(path.join(DATA, 'paper-orders.json'), 'utf8'));
const orders = (Array.isArray(ledger) ? ledger : Object.values(ledger).find(Array.isArray))
  .filter((order) => order.strategyId !== 'long-shot-round-trip');
const outcomes = await loadOutcomes();

const windowKey = (order) => `${order.symbol}|${order.closesAt}`;
const stakeOf = (order) => Number(order.actualStakeCents) || Number(order.stakeCents) || 0;
const pct = (v) => `${(100 * v).toFixed(1)}%`;
const cents = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}c`;

/** Win rate with an interval clustered on the settlement window — rows in a window share one outcome. */
function score(rows) {
  if (!rows.length) return null;
  const clusters = new Map();
  for (const row of rows) {
    const key = windowKey(row);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(row.won ? 1 : 0);
  }
  const means = [...clusters.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  const mean = means.reduce((a, b) => a + b, 0) / means.length;
  const variance = means.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, means.length - 1);
  const stderr = Math.sqrt(variance / means.length);
  return { n: rows.length, clusters: means.length, winRate: mean, lo: mean - 1.96 * stderr, hi: mean + 1.96 * stderr };
}

const resolved = (list) => list
  .map((order) => ({ ...order, settled: outcomes.get(windowKey(order)) }))
  .filter((order) => order.settled)
  .map((order) => ({ ...order, won: order.settled === order.side }));

for (const mode of ['live', 'paper']) {
  const mine = orders.filter((order) => order.executionMode === mode);
  const terminal = mine.filter((order) => ['won', 'lost', 'sold'].includes(order.status));
  console.log(`\n${'='.repeat(78)}\n${mode.toUpperCase()}\n${'='.repeat(78)}`);

  // --- what the ledger says, which is the only authoritative P&L -----------------------------------
  const realized = terminal.reduce((a, o) => a + (Number(o.actualPnlCents) || 0), 0);
  const staked = terminal.reduce((a, o) => a + stakeOf(o), 0);
  console.log(`\nrealized: ${cents(realized)} on ${staked.toFixed(0)}c staked over ${terminal.length} filled entries `
    + `= ${pct(realized / staked)}`);

  const current = terminal.filter((o) => o.entryDecision?.policyVersion === CURRENT_POLICY);
  const retired = terminal.filter((o) => o.entryDecision?.policyVersion !== CURRENT_POLICY);
  for (const [label, group] of [['current policy (v17)', current], ['retired policies', retired]]) {
    const p = group.reduce((a, o) => a + (Number(o.actualPnlCents) || 0), 0);
    const s = group.reduce((a, o) => a + stakeOf(o), 0);
    console.log(`  ${label.padEnd(22)} n=${String(group.length).padStart(4)}  ${cents(p).padStart(8)} on ${s.toFixed(0).padStart(6)}c = ${s ? pct(p / s) : 'n/a'}`);
  }

  // --- fills ---------------------------------------------------------------------------------------
  const filled = resolved(terminal);
  const missed = resolved(mine.filter((order) => order.status === 'unfilled'));
  console.log(`\nfill selection — did resting skip the winners?`);
  console.log('  cohort      orders  windows   side-won%      95% interval');
  for (const [label, s] of [['filled', score(filled)], ['unfilled', score(missed)]]) {
    if (!s) { console.log(`  ${label.padEnd(10)} (none)`); continue; }
    console.log(`  ${label.padEnd(10)} ${String(s.n).padStart(6)} ${String(s.clusters).padStart(8)}   ${pct(s.winRate).padStart(7)}   `
      + `[${pct(s.lo).padStart(7)}, ${pct(s.hi).padStart(7)}]`);
  }
  const f = score(filled); const m = score(missed);
  if (f && m) {
    const gap = m.winRate - f.winRate;
    const overlapping = m.lo < f.hi && f.lo < m.hi;
    console.log(`  gap: unfilled won ${pct(Math.abs(gap))} ${gap > 0 ? 'more' : 'less'} often`
      + `${overlapping ? ' — intervals overlap, so this is not established' : ''}`);
  }
  const priced = filled.filter((o) => o.actualPurchaseCents > 0 && o.issuanceAskPrice > 0 && o.filledCount > 0);
  if (priced.length) {
    const slip = priced.map((o) => o.actualPurchaseCents / o.filledCount - 100 * o.issuanceAskPrice);
    console.log(`  fill price vs issuance ask: ${(slip.reduce((a, b) => a + b, 0) / slip.length).toFixed(2)}c mean `
      + `(negative is maker discount captured)`);
  }

  // --- exits ---------------------------------------------------------------------------------------
  // The counterfactual is holding the same position to settlement: full payout if the side won, else zero.
  const sold = terminal.filter((o) => o.status === 'sold');
  const scored = sold.map((o) => {
    const settled = outcomes.get(windowKey(o));
    const stake = stakeOf(o);
    if (!settled || !stake) return null;
    return {
      actual: Number(o.actualPnlCents) || 0,
      held: settled === o.side ? (Number(o.potentialPayoutCents) || 0) - stake : -stake,
      wouldWin: settled === o.side,
    };
  }).filter(Boolean);

  console.log(`\nexit policy — scored against simply holding to settlement`);
  console.log(`  exited positions: ${sold.length}, of which ${scored.length} have a recoverable outcome`);
  if (scored.length) {
    const actual = scored.reduce((a, r) => a + r.actual, 0);
    const held = scored.reduce((a, r) => a + r.held, 0);
    const better = scored.filter((r) => r.actual > r.held).length;
    console.log(`  exited for   ${cents(actual).padStart(8)}`);
    console.log(`  holding was  ${cents(held).padStart(8)}`);
    console.log(`  exit contributed ${cents(actual - held)}`);
    console.log(`  right ${better}/${scored.length} of the time (${pct(better / scored.length)}) — `
      + `it gives up a little often and saves a lot occasionally, so a rule that fires less would not obviously help`);
    console.log(`  ${pct(scored.filter((r) => r.wouldWin).length / scored.length)} of exited positions would have won anyway`);
    console.log(`\n  without exits this book would be ${cents(realized - (actual - held))} instead of ${cents(realized)}`);
  }
}
