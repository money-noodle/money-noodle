/**
 * Why the entry gate's counterfactual return does not arrive in the book.
 *
 *   npm run analyze:entry-realization
 *
 * `analyze-edge-gates.mjs` scores the rows the gate admits, held to settlement, bought at the recorded
 * ask. It reports a healthy number. The realized ledger under the same policy is negative. This script
 * decomposes that difference into the three steps between "a row qualifies" and "a position settles":
 *
 *   1. WINDOW SELECTION  — of the admitted contract-windows, which ones did the desk order at all?
 *   2. FILL SELECTION    — of the orders it placed, which ones did a resting maker limit actually fill?
 *   3. SIGNAL FRESHNESS  — was the edge it fired on its own persistent level, or a spike above it?
 *
 * **The correction that decides the answer is deduplication.** Live and paper run one policy on the same
 * signals in the same windows, so pooling them counts each decision twice and halves every standard
 * error. Every cross-track figure here is one row per `(symbol, closesAt, side)`, preferring the live
 * record. Per-track figures are reported alongside so agreement is visible as agreement rather than
 * being silently used as corroboration — it is not corroboration, for the same reason.
 *
 * Intervals are clustered on the settlement window throughout: the desk issues a forecast every few
 * seconds and one fifteen-minute window is one coin flip. Win-rate differences between order cohorts
 * are quoted unclustered and labelled as such, because the desk places at most about one order per
 * contract-window, so there the row and the cluster are nearly the same unit.
 *
 * Biases, all of which run one way:
 *
 * - The step-1 counterfactual is fill-optimistic by construction — it is the quantity being explained,
 *   not a P&L forecast. Steps 2 and 3 are what remove that optimism.
 * - `secondsRemaining`, budget, pause state and the hourly order ceiling all decide whether a window is
 *   ordered, and none of them is a judgement about the window. Step 1 therefore separates "the desk was
 *   active at that close and passed on this contract" from "the desk placed no order at that close",
 *   because only the first is a selection decision.
 * - The step-3 threshold was chosen after looking at the bins. That makes it retroactive screening,
 *   which under §5.5 of the agent rules can motivate a prospective test and can never promote anything.
 *   The multiple-comparison arithmetic is printed with the result rather than left to the reader.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');
const SHARDS = path.join(DATA, 'forecast-history-shards');

/**
 * The policy under review and the moment it became active, from lib/policy-manifest.ts.
 *
 * Pinned to v17 rather than tracking BUY_POLICY_VERSION: v17 is the closed cohort this measurement
 * describes, and its successor v18 exists *because* of it. Following the live constant would silently
 * re-point the report at a cohort chosen by the very gate the report motivated.
 */
const POLICY = 'buy-binary-edge-net5to35-quality50-owned55-price5to97-v17';
const POLICY_ACTIVE_FROM = Date.parse('2026-08-14T01:05:00.000Z');
/** Kalshi charges `0.07 * p * (1 - p)` per contract on entry; Polymarket `0.01 * p`. Settlement is free. */
const feeRate = (venue, price) => (venue === 'kalshi' ? 0.07 * price * (1 - price) : 0.01 * price);
/** The gate as `admissibleEntry` + `qualifiesAsBuyEdge` express it in lib/prediction-policy.ts. */
const admits = (r) => r.ask >= 0.05 && r.ask <= 0.97 && r.probability >= 0.55
  && r.netEdge >= 0.05 && r.netEdge < 0.35 && r.confidence >= 0.5;

const rows = [];
const outcomes = new Map();
function take(list) {
  for (const row of list) {
    if (row.status !== 'resolved' || !row.outcome) continue;
    outcomes.set(`${row.symbol}|${row.closesAt}`, row.outcome);
    const ask = row.entryAsk;
    if (!(ask > 0) || ask >= 1) continue;
    const side = row.entrySide ?? 'UP';
    const probability = side === 'UP' ? row.probabilityUp : 1 - row.probabilityUp;
    const fee = row.entryFeeRate ?? feeRate(row.entryVenue ?? 'kalshi', ask);
    rows.push({ closesAt: row.closesAt, symbol: row.symbol, side, ask, fee, probability,
      confidence: row.confidence, netEdge: probability - ask - fee, won: row.outcome === side });
  }
}
const index = JSON.parse(await readFile(path.join(SHARDS, 'index.json'), 'utf8'));
for (const shard of index.shards) take(JSON.parse(await readFile(path.join(SHARDS, shard.file), 'utf8')));
if (existsSync(path.join(SHARDS, 'open.json'))) take(JSON.parse(await readFile(path.join(SHARDS, 'open.json'), 'utf8')));

const admitted = rows.filter((r) => admits(r) && Date.parse(r.closesAt) >= POLICY_ACTIVE_FROM);

const allOrders = JSON.parse(await readFile(path.join(DATA, 'paper-orders.json'), 'utf8')).orders
  .filter((o) => !o.id.includes(':exit:') && o.strategyId !== 'long-shot-round-trip')
  .filter((o) => o.entryDecision?.policyVersion === POLICY);

const isFilled = (o) => ['won', 'lost', 'sold', 'open'].includes(o.status);
const wonSide = (o) => { const out = outcomes.get(`${o.symbol}|${o.closesAt}`); return out === undefined ? null : out === o.side; };
/** How far the firing edge sat above its own persistence median — the value `signalEligibility` already stamps. */
const spike = (o) => o.entryDecision.netEdge - (o.entryDecision.medianNetEdge ?? o.entryDecision.netEdge);
const stakeOf = (o) => o.actualStakeCents ?? o.stakeCents;
const pnlOf = (o) => o.actualPnlCents ?? o.pnlCents ?? 0;
/** Per dollar committed, held to settlement, net of the entry fee. */
const rowReturn = (r) => (r.won ? (1 - r.ask - r.fee) / (r.ask + r.fee) : -1);

/** Equal-weighted mean over settlement windows, so one window is one observation however many rows it has. */
function cluster(list, key, value) {
  if (!list.length) return null;
  const byWindow = new Map();
  for (const item of list) byWindow.set(key(item), [...(byWindow.get(key(item)) ?? []), value(item)]);
  const per = [...byWindow.values()].map((a) => a.reduce((s, x) => s + x, 0) / a.length);
  const mean = per.reduce((s, x) => s + x, 0) / per.length;
  const se = per.length > 1
    ? Math.sqrt(per.reduce((s, x) => s + (x - mean) ** 2, 0) / (per.length - 1) / per.length) : null;
  return { windows: per.length, mean, se };
}
const scoreRows = (list) => {
  const c = cluster(list, (r) => `${r.symbol}|${r.closesAt}`, rowReturn);
  return c && { ...c, rows: list.length, win: list.filter((r) => r.won).length / list.length };
};
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const line = (s, label) => s && console.log(`  ${label.padEnd(48)} rows ${String(s.rows).padStart(5)}  windows ${String(s.windows).padStart(4)}  win ${(s.win * 100).toFixed(1)}%  ${pct(s.mean).padStart(7)} ±${(s.se * 196).toFixed(1)}`);
/** Difference of two window-clustered means, treating the cohorts as independent. */
const diff = (a, b, label) => {
  if (!a || !b) return;
  const d = a.mean - b.mean, se = Math.sqrt(a.se ** 2 + b.se ** 2);
  console.log(`  ${label.padEnd(48)} ${pct(d).padStart(7)} ±${(se * 196).toFixed(1)}  t=${(d / se).toFixed(2)}`);
};
/**
 * Unclustered two-proportion difference, for order cohorts at roughly one order per window.
 *
 * A cohort whose proportion lands exactly on 0 or 1 has zero estimated variance, which turns any
 * difference into an infinite t. That is an artefact of the estimator, not a strong result, so such a
 * cell reports the proportions and withholds the interval rather than printing a number that flatters.
 */
const MIN_COHORT = 8;
const winDiff = (aList, bList, label) => {
  const s = (l) => { const x = l.map(wonSide).filter((v) => v !== null); const p = x.filter(Boolean).length / x.length; return { n: x.length, p, se: Math.sqrt(p * (1 - p) / x.length) }; };
  const a = s(aList), b = s(bList);
  if (!a.n || !b.n) return;
  const head = `  ${label.padEnd(30)} ${String(a.n).padStart(4)} @ ${(a.p * 100).toFixed(1)}%  vs ${String(b.n).padStart(4)} @ ${(b.p * 100).toFixed(1)}%`;
  if (a.n < MIN_COHORT || b.n < MIN_COHORT || a.se === 0 || b.se === 0) {
    console.log(`${head}   (too few, or no variance to estimate — no interval)`);
    return;
  }
  const d = a.p - b.p, se = Math.sqrt(a.se ** 2 + b.se ** 2);
  console.log(`${head}   ${(d * 100).toFixed(1)}pp ±${(se * 196).toFixed(1)}  t=${(d / se).toFixed(2)}`);
};

console.log(`\npolicy ${POLICY}`);
console.log(`active from ${new Date(POLICY_ACTIVE_FROM).toISOString()}`);
console.log(`admitted rows in ${(() => { const s = scoreRows(admitted); return `${s.windows} settlement windows`; })()}, orders under this policy: ${allOrders.length}`);

console.log('\n================ 0. THE QUANTITY BEING EXPLAINED ================');
line(scoreRows(admitted), 'every admitted row, bought at the ask, held to settlement');
for (const mode of ['live', 'paper']) {
  const settled = allOrders.filter((o) => o.executionMode === mode && ['won', 'lost', 'sold'].includes(o.status));
  const stake = settled.reduce((s, o) => s + stakeOf(o), 0);
  const pnl = settled.reduce((s, o) => s + pnlOf(o), 0);
  console.log(`  ${mode} realized: ${pnl.toFixed(0)}c on ${stake.toFixed(0)}c over ${settled.length} settled entries = ${(100 * pnl / stake).toFixed(1)}%`);
}

console.log('\n================ 1. WINDOW SELECTION ================');
for (const mode of ['live', 'paper']) {
  const mine = allOrders.filter((o) => o.executionMode === mode);
  const ordered = new Set(mine.map((o) => `${o.symbol}|${o.closesAt}`));
  const activeCloses = new Set(mine.map((o) => o.closesAt));
  const inCohort = (r, f) => f(`${r.symbol}|${r.closesAt}`, r.closesAt);
  const A = admitted.filter((r) => inCohort(r, (k) => ordered.has(k)));
  const B = admitted.filter((r) => inCohort(r, (k, c) => !ordered.has(k) && activeCloses.has(c)));
  const C = admitted.filter((r) => inCohort(r, (k, c) => !activeCloses.has(c)));
  console.log(`${mode}:`);
  line(scoreRows(A), 'A) desk ordered this contract');
  line(scoreRows(B), 'B) desk was active at that close, passed on this one');
  line(scoreRows(C), 'C) desk placed no order at that close at all');
  diff(scoreRows(B), scoreRows(A), 'passed-over minus ordered (the selection cost)');
}
console.log('  Cohort C is downtime, budget and the order ceiling, not a judgement about the window.');

console.log('\n================ 2. FILL SELECTION ================');
for (const mode of ['live', 'paper']) {
  const mine = allOrders.filter((o) => o.executionMode === mode);
  console.log(`${mode}:`);
  winDiff(mine.filter(isFilled), mine.filter((o) => o.status === 'unfilled'), '  filled vs unfilled');
  const filled = mine.filter(isFilled);
  const disc = filled.map((o) => (o.authoritativeFillPrice ?? o.askPrice) - o.issuanceAskPrice).filter(Number.isFinite);
  if (disc.length) console.log(`    maker discount captured: ${(100 * disc.reduce((s, x) => s + x, 0) / disc.length).toFixed(2)}c against the issuance ask over ${disc.length} fills`);
}
console.log('  A resting buy fills when someone sells into it. Buying lower and being wrong are the same event.');

console.log('\n================ 3. SIGNAL FRESHNESS ================');
const uniq = new Map();
for (const o of allOrders) {
  const key = `${o.symbol}|${o.closesAt}|${o.side}`;
  const prev = uniq.get(key);
  if (!prev || (prev.executionMode !== 'live' && o.executionMode === 'live')) uniq.set(key, o);
}
const deduped = [...uniq.values()];
console.log(`  ${allOrders.length} orders deduplicate to ${deduped.length} unique (symbol, window, side) decisions`);
const THRESHOLD = 0.02;
const orderScore = (list) => {
  const scored = list.filter((o) => wonSide(o) !== null);
  if (scored.length < 8) return null;
  const c = cluster(scored, (o) => `${o.symbol}|${o.closesAt}`, (o) => {
    const cost = o.entryDecision.actionableAsk + o.entryDecision.feeRate;
    return wonSide(o) ? (1 - cost) / cost : -1;
  });
  return { ...c, rows: scored.length, win: scored.filter(wonSide).length / scored.length };
};
for (const [label, list] of [['deduped, every decision', deduped], ['deduped, filled only', deduped.filter(isFilled)],
  ['live only', allOrders.filter((o) => o.executionMode === 'live')], ['paper only', allOrders.filter((o) => o.executionMode === 'paper')]]) {
  console.log(`${label}:`);
  const fresh = list.filter((o) => spike(o) < THRESHOLD), spiked = list.filter((o) => spike(o) >= THRESHOLD);
  line(orderScore(fresh), `edge within ${THRESHOLD * 100}pp of its persistence median`);
  line(orderScore(spiked), `edge ${THRESHOLD * 100}pp or more above its persistence median`);
  diff(orderScore(fresh), orderScore(spiked), 'fresh minus spiked');
  winDiff(fresh, spiked, '  win rate, unclustered');
}

console.log('\n  does it survive holding the edge level fixed?');
for (const [lo, hi] of [[0.05, 0.10], [0.10, 0.20], [0.20, 0.35]]) {
  const band = deduped.filter((o) => o.entryDecision.netEdge >= lo && o.entryDecision.netEdge < hi);
  winDiff(band.filter((o) => spike(o) < THRESHOLD), band.filter((o) => spike(o) >= THRESHOLD), `    netEdge ${lo}-${hi}`);
}
console.log('\n  does it point the same way on every asset?');
let lower = 0, assets = 0;
for (const symbol of [...new Set(deduped.map((o) => o.symbol))].sort()) {
  const g = deduped.filter((o) => o.symbol === symbol);
  const rate = (l) => { const x = l.map(wonSide).filter((v) => v !== null); return x.length ? x.filter(Boolean).length / x.length : null; };
  const a = rate(g.filter((o) => spike(o) < THRESHOLD)), b = rate(g.filter((o) => spike(o) >= THRESHOLD));
  if (a === null || b === null) continue;
  assets += 1; if (b < a) lower += 1;
  console.log(`    ${symbol.padEnd(6)} fresh ${(a * 100).toFixed(1)}%   spiked ${(b * 100).toFixed(1)}%   ${b < a ? 'lower' : 'higher'}`);
}
console.log(`    spiked is lower on ${lower}/${assets} assets; under no effect that happens with probability ${(2 ** -assets * 100).toFixed(1)}% for a clean sweep`);

console.log('\n  what the cut would have cost in realized cents (retroactive; cannot promote anything)');
for (const mode of ['live', 'paper']) {
  const filled = allOrders.filter((o) => o.executionMode === mode && ['won', 'lost', 'sold'].includes(o.status));
  const sum = (l, f) => l.reduce((s, o) => s + f(o), 0);
  const keep = filled.filter((o) => spike(o) < THRESHOLD), drop = filled.filter((o) => spike(o) >= THRESHOLD);
  const show = (l, label) => l.length && console.log(`    ${mode} ${label.padEnd(10)} ${sum(l, pnlOf).toFixed(0).padStart(6)}c on ${sum(l, stakeOf).toFixed(0).padStart(6)}c = ${(100 * sum(l, pnlOf) / sum(l, stakeOf)).toFixed(1)}%  (${l.length} entries)`);
  show(filled, 'as traded'); show(keep, 'kept'); show(drop, 'dropped');
}

console.log('\n================ MULTIPLE COMPARISONS ================');
console.log(`  Five decision-time dimensions were swept before this one separated: the spike itself, the`);
console.log(`  persistence median level, the recorded cycle regime, the qualifying-snapshot count, and`);
console.log(`  seconds remaining. Only the spike moved. With roughly twenty cells looked at, the best of`);
console.log(`  them is expected to reach about t = 2.2 under a null of no effect, so the single t below`);
console.log(`  that line is not what carries this. What carries it is that the direction repeats inside`);
console.log(`  every edge band and on every asset, and that there is a mechanism: an edge that has just`);
console.log(`  jumped above its own recent level is a price that has just moved, and the direction it`);
console.log(`  moved is against the side the jump makes attractive.`);
console.log(`\n  Sample: three days. Nothing here promotes anything; see reports/edge-policy-review-2026-08-17.md §6.\n`);
