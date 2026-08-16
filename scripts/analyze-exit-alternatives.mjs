/**
 * Replays candidate exit rules over recorded position paths.
 *
 *   npm run analyze:exit-alternatives
 *
 * Every filled position records a `positionObservations` path: the executable bid, the net liquidation
 * value, the owned-side probability and the seconds remaining, sampled through its life. That is enough
 * to ask what a different exit rule would have done, without re-running the desk.
 *
 * **A candidate must be scored on every position, not only the ones currently held.** This is the
 * correction that decides the answer. Scoring candidates only against positions held to settlement
 * flatters anything that sells early, because it counts the losses such a rule avoids and never counts
 * the strict-value exits it would have pre-empted. A take-profit at +5% looks worth +3,699c on the held
 * cohort alone and is worth +979c once the 59 of 64 strict-value sales it front-runs are included.
 *
 * So every candidate runs over both cohorts, alongside the live rule, first-to-fire winning:
 *
 *   - fires before the position ended  -> the candidate's sale price is what the position earns
 *   - never fires                      -> today's outcome stands, settlement or strict-value exit alike
 *
 * On a position the live rule sold, the recorded path stops at the sale, so a candidate that would only
 * have fired *later* is invisible and is conservatively treated as never firing. That direction of error
 * understates candidates that sell late and cannot manufacture a winner, which is the safe way round.
 *
 * Two cautions carried from the rest of this review. Intervals are clustered on the settlement window.
 * And this script tests many rules against one small sample — see the multiple-comparison note at the
 * end, which is not decoration: with this many candidates the best-looking one is expected to look good.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');

const ledger = JSON.parse(await readFile(path.join(DATA, 'paper-orders.json'), 'utf8'));
const orders = (Array.isArray(ledger) ? ledger : Object.values(ledger).find(Array.isArray))
  .filter((o) => o.strategyId !== 'long-shot-round-trip' && !o.id.includes(':exit:'));

const withPath = orders.filter((o) => o.positionObservations?.length
  && ['won', 'lost', 'sold'].includes(o.status));
/** Held to settlement: the path is complete. */
const held = withPath.filter((o) => o.status === 'won' || o.status === 'lost');
/** Sold by the live rule: the path stops at the sale, which is enough to detect pre-emption. */
const sold = withPath.filter((o) => o.status === 'sold');

const cost = (o) => o.actualStakeCents ?? o.stakeCents;
/** What the position actually earned today — settlement for a held position, the sale for a sold one. */
const actualPnl = (o) => Number(o.actualPnlCents) || 0;

/**
 * A candidate rule sees observations in order and returns the index it sells at, or null to hold.
 *
 * Rules are written over `unrealizedPnlCents` and `netLiquidationCents` as recorded, so the exit fee and
 * the executable bid are the real ones rather than a reconstruction.
 */
const RULES = [];
const rule = (name, group, make) => RULES.push({ name, group, make });

// Take profit: sell the first time the position is up by k of its cost.
// The low thresholds matter: on the held cohort alone the gain rises monotonically the earlier you sell,
// all the way down to +2%, which is exactly the shape pre-emption then cancels.
for (const k of [0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5]) {
  rule(`take-profit +${(100 * k).toFixed(0)}%`, 'take-profit', () => (obs, o) =>
    obs.unrealizedPnlCents >= k * cost(o));
}
// Stop loss: sell the first time the position is down by k of its cost.
for (const k of [0.25, 0.4, 0.5, 0.6]) {
  rule(`stop-loss -${(100 * k).toFixed(0)}%`, 'stop-loss', () => (obs, o) =>
    obs.unrealizedPnlCents <= -k * cost(o));
}
// Trailing stop: arm at +arm, then sell if net liquidation gives back `give` of its peak.
for (const [arm, give] of [[0.25, 0.2], [0.5, 0.2], [0.5, 0.35], [0.75, 0.2], [0.75, 0.35]]) {
  rule(`trail arm+${(100 * arm).toFixed(0)}% give${(100 * give).toFixed(0)}%`, 'trailing', () => {
    let peak = null;
    return (obs, o) => {
      if (peak === null && obs.unrealizedPnlCents >= arm * cost(o)) peak = obs.netLiquidationCents;
      if (peak === null) return false;
      peak = Math.max(peak, obs.netLiquidationCents);
      return obs.netLiquidationCents <= peak * (1 - give);
    };
  });
}
// The withheld production rule: arm at +75%, sell on a joint decline in value and owned-side probability.
for (const arm of [0.5, 0.75, 1.0]) {
  rule(`profit-reversal +${(100 * arm).toFixed(0)}%`, 'profit-reversal', () => {
    let armed = false, peakValue = null, peakProbability = null;
    return (obs, o) => {
      if (!armed && obs.unrealizedPnlCents >= arm * cost(o)) { armed = true; peakValue = obs.netLiquidationCents; peakProbability = obs.ownedSideProbability; return false; }
      if (!armed) return false;
      const reversed = obs.netLiquidationCents < peakValue && obs.ownedSideProbability < peakProbability;
      if (obs.netLiquidationCents > peakValue) { peakValue = obs.netLiquidationCents; peakProbability = obs.ownedSideProbability; }
      return reversed;
    };
  });
}
// Close out near expiry rather than carrying binary risk into settlement, if it can be done at a profit.
for (const seconds of [60, 120, 300]) {
  rule(`flat-by-${seconds}s if up`, 'time', () => (obs) =>
    obs.secondsRemaining <= seconds && obs.unrealizedPnlCents > 0);
}
for (const seconds of [60, 120, 300]) {
  rule(`flat-by-${seconds}s always`, 'time', () => (obs) => obs.secondsRemaining <= seconds);
}

/** What one rule earns on one position: the sale it triggers, or today's outcome if it never fires. */
function replay(candidate, order) {
  const fires = candidate.make();
  for (const observation of [...order.positionObservations].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (!Number.isFinite(observation.unrealizedPnlCents) || !Number.isFinite(observation.netLiquidationCents)) continue;
    if (fires(observation, order)) return { pnl: observation.unrealizedPnlCents, fired: true };
  }
  return { pnl: actualPnl(order), fired: false };
}

/** Mean incremental return per stake, clustered on the settlement window. */
function score(rows) {
  if (!rows.length) return null;
  const clusters = new Map();
  for (const row of rows) {
    const key = `${row.order.symbol}|${row.order.closesAt}`;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(row.incremental / cost(row.order));
  }
  const means = [...clusters.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  const mean = means.reduce((a, b) => a + b, 0) / means.length;
  const variance = means.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, means.length - 1);
  const stderr = Math.sqrt(variance / means.length);
  return { windows: means.length, mean, stderr, t: stderr > 0 ? mean / stderr : 0 };
}

const S = (v) => `${v >= 0 ? '+' : ''}${(100 * v).toFixed(1)}%`;

console.log(`positions with a recorded path: ${withPath.length}`);
console.log(`  held to settlement: ${held.length}  —  ${held.filter((o) => o.status === 'won').length} won, ${held.filter((o) => o.status === 'lost').length} lost`);
console.log(`  sold by the live rule: ${sold.length}`);
console.log(`  path range: ${withPath.map((o) => o.createdAt).sort()[0]} to ${withPath.map((o) => o.createdAt).sort().at(-1)}`);

const baseline = withPath.reduce((a, o) => a + actualPnl(o), 0);
const staked = withPath.reduce((a, o) => a + cost(o), 0);
console.log(`\nbaseline — what these positions actually earned: ${baseline.toFixed(0)}c on ${staked.toFixed(0)}c staked = ${S(baseline / staked)}`);
console.log(`  of which held cohort ${held.reduce((a, o) => a + actualPnl(o), 0).toFixed(0)}c, sold cohort ${sold.reduce((a, o) => a + actualPnl(o), 0).toFixed(0)}c`);

console.log('\nEACH CANDIDATE RUN ALONGSIDE THE LIVE RULE, FIRST TO FIRE WINNING');
console.log('  rule                          fired    net vs today    on held    pre-empted   per stake       t');
const results = [];
for (const candidate of RULES) {
  const rows = withPath.map((order) => {
    const outcome = replay(candidate, order);
    return { order, pnl: outcome.pnl, fired: outcome.fired, incremental: outcome.pnl - actualPnl(order) };
  });
  const total = rows.reduce((a, r) => a + r.pnl, 0);
  const delta = total - baseline;
  const onHeld = rows.filter((r) => r.order.status !== 'sold').reduce((a, r) => a + r.incremental, 0);
  const preempted = rows.filter((r) => r.fired && r.order.status === 'sold');
  const preemptCost = preempted.reduce((a, r) => a + r.incremental, 0);
  const s = score(rows);
  results.push({ candidate, fired: rows.filter((r) => r.fired).length, total, delta, onHeld, preemptCost, preempted: preempted.length, s });
  console.log(`  ${candidate.name.padEnd(28)}${String(rows.filter((r) => r.fired).length).padStart(5)}`
    + `${((delta >= 0 ? '+' : '') + delta.toFixed(0)).padStart(14)}c${((onHeld >= 0 ? '+' : '') + onHeld.toFixed(0)).padStart(10)}c`
    + `${(String(preempted.length) + '/' + sold.length).padStart(12)}${S(s.mean).padStart(11)}${s.t.toFixed(2).padStart(8)}`);
}

const best = results.reduce((a, b) => (b.delta > a.delta ? b : a));
console.log(`\nbest by total: ${best.candidate.name} at ${(best.delta >= 0 ? '+' : '') + best.delta.toFixed(0)}c, t = ${best.s.t.toFixed(2)}`);
console.log(`candidates tested: ${RULES.length}. With that many, the best-looking result is expected to reach`);
console.log(`t ≈ 2 under a null of no effect, so a single t above 2 here is not evidence of anything.`);
console.log(`The figure to look at is whether a whole GROUP of related rules moves together:`);
const groups = [...new Set(RULES.map((r) => r.group))];
console.log('\n  group             rules   mean vs held   rules positive');
for (const group of groups) {
  const inGroup = results.filter((r) => r.candidate.group === group);
  const mean = inGroup.reduce((a, r) => a + r.s.mean, 0) / inGroup.length;
  console.log(`  ${group.padEnd(18)}${String(inGroup.length).padStart(5)}   ${S(mean).padStart(12)}   ${inGroup.filter((r) => r.delta > 0).length}/${inGroup.length}`);
}

// --- why pre-emption is the whole story ---------------------------------------------------------------
console.log('\n\nWHY THE HELD-ONLY VIEW MISLEADS');
console.log('  A candidate that sells early looks strong on positions held to settlement, because 43% of');
console.log('  the total losses in that cohort were at some point profitable. But the same trigger fires on');
console.log('  the positions strict-value sells well, and sells them for less. The two columns above are');
console.log('  the same rule measured with and without that cost:');
const shown = results.filter((r) => r.candidate.group === 'take-profit').slice(0, 3);
for (const r of shown) {
  console.log(`    ${r.candidate.name.padEnd(22)} on held ${((r.onHeld >= 0 ? '+' : '') + r.onHeld.toFixed(0)).padStart(7)}c`
    + `   after pre-emption ${((r.delta >= 0 ? '+' : '') + r.delta.toFixed(0)).padStart(7)}c`);
}

const soldScored = sold.filter((o) => o.counterfactualHoldPnlCents !== undefined);
if (soldScored.length) {
  const actual = soldScored.reduce((a, o) => a + actualPnl(o), 0);
  const holding = soldScored.reduce((a, o) => a + o.counterfactualHoldPnlCents, 0);
  console.log(`\n  That is what the live rule is defending: over ${soldScored.length} sales it earned ${actual.toFixed(0)}c `
    + `against ${holding.toFixed(0)}c for holding, worth ${(actual - holding >= 0 ? '+' : '') + (actual - holding).toFixed(0)}c.`);
  console.log('  A candidate is only an improvement if it beats that, not if it beats doing nothing.');
}
