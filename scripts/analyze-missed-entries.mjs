/**
 * Scores the entries the buy gate refuses: what the desk did not buy, and what it was worth.
 *
 *   npm run analyze:missed-entries
 *
 * **What it measures.** For every recorded 15-minute contract, every side, and every recorded calculation,
 * this replays the v19 entry rule from `lib/prediction-policy.ts` and a set of one-constant relaxations of
 * it. A relaxation's *increment* is the set of `(symbol, window, side)` decisions it admits and the live
 * rule never admits at any point in that window. The increment is scored three ways — held to settlement,
 * with the desk's own `strict-value-v1` exit replayed over the recorded price path, and at the best bid the
 * path ever printed — clustered on the settlement window.
 *
 * **The correction that decides the answer.** "Could have been sold at a profit" is close to useless as a
 * selection signal. It is measured here as `exit available`, and three in five live-rule entries that
 * expired *worthless* were sellable at a profit first — the capped-gain, uncapped-loss shape of
 * reports/swing-trading-2026-08-18.md §1. A cohort chosen because it was ever green keeps most of its
 * losses. What decides a gate change is the increment's return per dollar against the live rule's.
 *
 * A second correction: cohorts are built as **whole candidate rules**, not as "rows failing gate X". A
 * cohort defined by a failing gate has its entry time chosen by that definition, so slicing it by price
 * re-selects the entry and the parts stop summing to the whole. Every arm here enters at the first row its
 * own rule admits, which is what the desk would have done.
 *
 * **Biases, worst first.**
 *   - **Fill-optimistic.** Every entry is assumed bought at the recorded ask. Production rests a maker
 *     order, fills about half the time, and the fills it gets are adversely selected by roughly −19pp
 *     (reports/loss-decomposition-2026-08-18.md). What survives that bias is the ranking between arms and
 *     the sign, not the level.
 *   - **Fees are continuous rates**, not the whole-cent charge with its 1c floor (`venueFeeCents`). At a
 *     $5 ticket the floor is real and this is mildly optimistic, equally across arms.
 *   - **Persistence is not replayable at this cadence and is not modelled.** Production requires three
 *     qualifying dashboard snapshots spanning 30s (`REQUIRED_QUALIFYING_SNAPSHOTS`, `lib/signal-persistence.ts`)
 *     and the dashboard refreshes every few seconds; the forecast history records a calculation every 55s at
 *     the median. Imposing the rule on recorded rows would demand roughly 110s of continuous qualification,
 *     which is a different and much stricter gate. §3 reports it that way, as an upper bound on what
 *     persistence costs, never as a replay of it. The warmup and late-cutoff bounds *are* replayable from
 *     the clock and are applied throughout.
 *   - **The exit replay carries the model probability forward** from the last calculation row, which
 *     before 2026-08-18 is roughly one a minute, while the price path is sampled every 15s (2s from
 *     2026-08-18). The exit rule therefore acts on a slightly stale probability. It also fills exactly at
 *     the observed bid, which flatters every exit arm.
 *   - Kalshi only: the recorded paths are Kalshi contracts and it is the venue the desk trades live.
 *   - Settlement is authoritative, from the resolved forecast history.
 *   - Read-only. Places no order, writes nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { readForecastHistory } from './lib/forecast-history.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const SHARDS = path.join(DATA, 'forecast-history-shards');
const CYCLE_SECONDS = 900;

/** Kalshi taker rate per $1 of payout, matching the gate's immediate-execution admission semantics. */
const feeRate = (price) => 0.07 * price * (1 - price);
/** `exitUncertainty` in lib/paper-execution.ts. */
const uncertainty = (confidence) => Math.max(0.03, Math.min(0.15, (1 - confidence) * 0.25));

/** Live rule constants, read from lib/prediction-policy.ts at v19. */
const LIVE = { minEdge: 0.05, maxEdge: 0.35, minQuality: 0.5, minSideProbability: 0.55, minPrice: 0.05, maxPrice: 0.97 };
/** Execution window from lib/signal-persistence.ts. */
const WARMUP_SECONDS = 90, LATE_CUTOFF_SECONDS = 120, REQUIRED_SNAPSHOTS = 3, REQUIRED_SPAN_SECONDS = 30;

const admits = (rule, { probability, price, confidence, netEdge }) =>
  price >= rule.minPrice && price <= rule.maxPrice
  && probability >= rule.minSideProbability
  && netEdge >= rule.minEdge && netEdge < rule.maxEdge
  && confidence >= rule.minQuality;

// ------------------------------------------------------------------ recorded price paths
async function loadPaths() {
  const paths = new Map();
  const journal = path.join(DATA, 'contract-paths.journal.jsonl');
  if (!existsSync(journal)) return paths;
  const stream = readline.createInterface({ input: createReadStream(journal) });
  for await (const line of stream) {
    if (!line.trim()) continue;
    try {
      const [, symbol, closesAt, points] = JSON.parse(line);
      const parsed = points.map(([t, up, down]) => ({ t, upAsk: up / 100, downAsk: down / 100 })).sort((a, b) => a.t - b.t);
      const key = `${symbol}|${closesAt}`;
      const prior = paths.get(key);
      // The same window is journaled more than once; the longest record is the complete one.
      if (!prior || parsed.length > prior.length) paths.set(key, parsed);
    } catch { /* a damaged line is skipped rather than failing the whole read */ }
  }
  return paths;
}

// ------------------------------------------------------------------ resolved forecast history
async function loadWindows() {
  const windows = new Map();
  // Shards + open shard + journal patches. An earlier version read shards and `open.json` only, which on a
  // running collector is hours stale, so the newest policy era was missing from every table below.
  for (const row of await readForecastHistory(DATA)) {
    if (row.status !== 'resolved' || !row.outcome) continue;
    const quotes = row.actionableVenuePrices?.filter((quote) => quote.venue === 'kalshi');
    if (!quotes?.length) continue;
    const asks = {};
    for (const { side, price } of quotes) if (price > 0 && price < 1) asks[side] = price;
    if (asks.UP === undefined || asks.DOWN === undefined) continue;
    const key = `${row.symbol}|${row.closesAt}`;
    const window = windows.get(key)
      ?? { key, symbol: row.symbol, closesAt: row.closesAt, outcome: row.outcome, day: row.closesAt.slice(0, 10), rows: [] };
    window.rows.push({
      t: CYCLE_SECONDS - (row.secondsRemaining ?? 0),
      probabilityUp: row.probabilityUp, confidence: row.confidence ?? 0, asks,
    });
    windows.set(key, window);
  }
  for (const window of windows.values()) {
    window.rows.sort((a, b) => a.t - b.t);
    window.rows = window.rows.filter((row, index) => index === 0 || row.t > window.rows[index - 1].t);
  }
  return windows;
}

const PATHS = await loadPaths();
const WINDOWS = await loadWindows();

/**
 * First entry this rule would take on one side of one window, honouring the execution window and the
 * persistence requirement: three consecutive qualifying calculations spanning at least 30 seconds.
 */
function firstEntry(window, side, rule, {
  requirePersistence = false, executionWindow = true,
  warmup = WARMUP_SECONDS, cutoff = LATE_CUTOFF_SECONDS,
} = {}) {
  let streak = [];
  for (const row of window.rows) {
    const price = row.asks[side];
    const probability = side === 'UP' ? row.probabilityUp : 1 - row.probabilityUp;
    if (!(price > 0) || price >= 1) { streak = []; continue; }
    const candidate = { probability, price, confidence: row.confidence, netEdge: probability - price - feeRate(price) };
    if (!admits(rule, candidate)) { streak = []; continue; }
    streak.push(row);
    if (streak.length > REQUIRED_SNAPSHOTS) streak.shift();
    const persisted = streak.length >= REQUIRED_SNAPSHOTS && row.t - streak[0].t >= REQUIRED_SPAN_SECONDS;
    if (requirePersistence && !persisted) continue;
    if (executionWindow) {
      if (row.t < warmup) continue;
      if (CYCLE_SECONDS - row.t < cutoff) return null;
    }
    return { ...candidate, t: row.t, side, window };
  }
  return null;
}

/** Held to settlement, with the desk's exit replayed over the path when one is recorded. */
function outcomeOf(entry) {
  const { window, side } = entry;
  const cost = entry.price + feeRate(entry.price);
  const settled = window.outcome === side ? 1 : 0;
  const result = {
    window: window.key, day: window.day, symbol: window.symbol, side, cost, won: settled === 1,
    holdReturn: settled / cost - 1,
    hasPath: false, exitAvailable: false, strictFired: false,
    strictReturn: settled / cost - 1, bestReturn: settled / cost - 1,
  };
  const samples = PATHS.get(window.key)?.filter((sample) => sample.t >= entry.t);
  if (!samples?.length) return result;
  result.hasPath = true;

  let rowIndex = 0;
  let probability = entry.probability;
  let confidence = entry.confidence;
  let bestBid = 0;
  let strictProceeds = null;
  for (const sample of samples) {
    while (rowIndex < window.rows.length && window.rows[rowIndex].t <= sample.t) {
      const row = window.rows[rowIndex];
      probability = side === 'UP' ? row.probabilityUp : 1 - row.probabilityUp;
      confidence = row.confidence;
      rowIndex += 1;
    }
    const bid = side === 'UP' ? 1 - sample.downAsk : 1 - sample.upAsk;
    if (!(bid > 0) || bid >= 1) continue;
    if (bid > bestBid) bestBid = bid;
    if (strictProceeds === null) {
      const netLiquidation = bid - feeRate(bid);
      // strict-value-v1: executable cash must beat the optimistic hold value by at least 1c per $1.
      if (netLiquidation >= Math.min(1, probability + uncertainty(confidence)) + 0.01) strictProceeds = netLiquidation;
    }
  }
  if (bestBid > 0) {
    result.exitAvailable = bestBid - feeRate(bestBid) > cost;
    result.bestReturn = Math.max(bestBid - feeRate(bestBid), settled) / cost - 1;
  }
  if (strictProceeds !== null) { result.strictFired = true; result.strictReturn = strictProceeds / cost - 1; }
  return result;
}

/** Mean with an interval clustered on the settlement window: rows in one window share one coin flip. */
function clustered(results, select) {
  if (!results.length) return null;
  const groups = new Map();
  for (const result of results) groups.set(result.window, [...(groups.get(result.window) ?? []), select(result)]);
  const means = [...groups.values()].map((list) => list.reduce((a, b) => a + b, 0) / list.length);
  const mean = means.reduce((a, b) => a + b, 0) / means.length;
  const standardError = means.length > 1
    ? Math.sqrt(means.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (means.length - 1) / means.length) : 0;
  return { mean, standardError, windows: means.length, t: standardError ? mean / standardError : 0 };
}

/** Total profit over total cost: the view a budget sees. Reported beside the clustered mean because the
 *  two disagree whenever a cohort mixes price levels, and the disagreement is the finding. */
function stakeWeighted(results, select) {
  const cost = results.reduce((sum, r) => sum + r.cost, 0);
  return results.reduce((sum, r) => sum + select(r) * r.cost, 0) / cost;
}

function daysPositive(results, select) {
  const byDay = new Map();
  for (const r of results) {
    const day = byDay.get(r.day) ?? { profit: 0, cost: 0 };
    day.profit += select(r) * r.cost; day.cost += r.cost; byDay.set(r.day, day);
  }
  return { positive: [...byDay.values()].filter((d) => d.profit > 0).length, total: byDay.size };
}

const pct = (value) => `${value >= 0 ? '+' : '−'}${Math.abs(100 * value).toFixed(1)}%`;
const pad = (value, width) => String(value).padStart(width);

function report(label, results) {
  if (!results.length) return console.log(`${label.padEnd(26)} | no decisions`);
  const withPath = results.filter((r) => r.hasPath);
  const hold = clustered(results, (r) => r.holdReturn);
  const strict = withPath.length ? clustered(withPath, (r) => r.strictReturn) : null;
  const best = withPath.length ? clustered(withPath, (r) => r.bestReturn) : null;
  const days = daysPositive(results, (r) => r.holdReturn);
  const available = withPath.length ? withPath.filter((r) => r.exitAvailable).length / withPath.length : null;
  console.log(
    `${label.padEnd(26)} | ${pad(results.length, 5)} ${pad(hold.windows, 5)} ${pad((100 * results.reduce((a, r) => a + r.cost, 0) / results.length).toFixed(0), 4)}c `
    + `| ${pad(pct(hold.mean), 7)} ±${pad((196 * hold.standardError).toFixed(1), 5)} t=${pad(hold.t.toFixed(2), 6)} `
    + `| ${pad(pct(stakeWeighted(results, (r) => r.holdReturn)), 7)} ${days.positive}/${days.total} `
    + `| ${strict ? `${pad(pct(strict.mean), 7)} ±${pad((196 * strict.standardError).toFixed(1), 5)}` : '      —      '} `
    + `| ${available === null ? ' — ' : pad(`${(100 * available).toFixed(0)}%`, 4)} ${best ? pad(pct(best.mean), 7) : '   —   '}`,
  );
}

const HEADER = `${'arm'.padEnd(26)} |     n  wins cost | held to settlement                | stake-wtd  d+ `
  + `| strict-value exit  | exit avail / perfect`;

// ------------------------------------------------------------------ arms
const relax = (label, change, options = {}) => ({ label, rule: { ...LIVE, ...change }, options });
const ARMS = [
  relax('live rule (v19)', {}),
  relax('edge floor 3pp', { minEdge: 0.03 }),
  relax('edge floor 0pp', { minEdge: 0 }),
  relax('edge floor −5pp', { minEdge: -0.05 }),
  relax('edge ceiling 45pp', { maxEdge: 0.45 }),
  relax('edge ceiling off', { maxEdge: 1 }),
  relax('side probability 52.5%', { minSideProbability: 0.525 }),
  relax('side probability 50%', { minSideProbability: 0.5 }),
  relax('quality 40%', { minQuality: 0.4 }),
  relax('price band 2–99c', { minPrice: 0.02, maxPrice: 0.99 }),
  relax('late cutoff 30s', {}, { cutoff: 30 }),
  relax('warmup 30s', {}, { warmup: 30 }),
  // Every relaxation whose increment scored positive, applied together. The side-probability floor and the
  // warmup are excluded: their increments are negative and near-zero respectively.
  relax('COMBINED floor 0pp + cutoff 30s', { minEdge: 0 }, { cutoff: 30 }),
  relax('COMBINED floor −5pp + cutoff 30s + ceiling off', { minEdge: -0.05, maxEdge: 1 }, { cutoff: 30 }),
];

const sides = ['UP', 'DOWN'];
const windows = [...WINDOWS.values()];
const withPathCount = windows.filter((w) => PATHS.has(w.key)).length;
console.log(`resolved windows ${windows.length}, of which ${withPathCount} have a recorded price path`);
console.log(`calculations ${windows.reduce((sum, w) => sum + w.rows.length, 0)}, days ${new Set(windows.map((w) => w.day)).size}`);
{
  const gaps = [];
  for (const window of windows) for (let i = 1; i < window.rows.length; i += 1) gaps.push(window.rows[i].t - window.rows[i - 1].t);
  gaps.sort((a, b) => a - b);
  console.log(`calculation cadence: median gap ${gaps[Math.floor(gaps.length / 2)]}s, ${(100 * gaps.filter((g) => g <= 30).length / gaps.length).toFixed(0)}% of gaps within the 30s persistence span\n`);
}

const liveEntries = new Map();
for (const window of windows) {
  for (const side of sides) {
    const entry = firstEntry(window, side, LIVE);
    if (entry) liveEntries.set(`${window.key}|${side}`, entry);
  }
}

console.log('=== 0. was a profitable exit available? the premise this script exists to test ===');
{
  const admitted = [...liveEntries.values()].map(outcomeOf).filter((result) => result.hasPath);
  const share = (list) => `${(100 * list.filter((r) => r.exitAvailable).length / Math.max(1, list.length)).toFixed(0)}%`;
  const losers = admitted.filter((r) => !r.won);
  const winners = admitted.filter((r) => r.won);
  console.log(`Of ${admitted.length} live-rule entries with a recorded path, ${share(admitted)} could have been sold`);
  console.log(`at a profit at some point after entry. Split by how they settled:`);
  console.log(`  settled in the money  ${String(winners.length).padStart(4)}  exit was available ${share(winners)}`);
  console.log(`  settled worthless     ${String(losers.length).padStart(4)}  exit was available ${share(losers)}`);
  console.log('Availability does separate winners from losers, but three in five positions that expired');
  console.log('worthless were sellable at a profit first, so a cohort selected on it still carries most of');
  console.log('the losses — the capped-gain, uncapped-loss shape of reports/swing-trading-2026-08-18.md §1.');
  console.log('Every arm below reports it, and decides on return per dollar instead.\n');
}

console.log('=== 1. every arm, its whole admitted population ===');
console.log(HEADER);
const armResults = new Map();
for (const arm of ARMS) {
  const results = [];
  const increment = [];
  for (const window of windows) {
    for (const side of sides) {
      const entry = firstEntry(window, side, arm.rule, arm.options);
      if (!entry) continue;
      const outcome = outcomeOf(entry);
      results.push(outcome);
      if (!liveEntries.has(`${window.key}|${side}`)) increment.push(outcome);
    }
  }
  armResults.set(arm.label, { results, increment });
  report(arm.label, results);
}

console.log('\n=== 2. the increment: decisions the live rule never admits in that window ===');
console.log(HEADER);
for (const arm of ARMS.slice(1)) {
  report(arm.label, armResults.get(arm.label).increment);
}

console.log('\n=== 2c. what the increment is worth in cents, at one ticket per decision ===');
console.log('Total profit the increment would have produced over the whole sample, at the ask, held to');
console.log('settlement, one entry per decision. This is the number that answers "is admitting more worth it".');
console.log(`${'arm'.padEnd(38)} ${'decisions'.padStart(9)} ${'cost'.padStart(8)} ${'profit'.padStart(9)} ${'per day'.padStart(8)}`);
{
  const days = new Set(windows.map((w) => w.day)).size;
  for (const arm of ARMS.slice(1)) {
    const increment = armResults.get(arm.label).increment;
    if (!increment.length) { console.log(`${arm.label.padEnd(38)} ${'0'.padStart(9)}`); continue; }
    const cost = increment.reduce((sum, r) => sum + r.cost, 0);
    const profit = increment.reduce((sum, r) => sum + r.holdReturn * r.cost, 0);
    console.log(`${arm.label.padEnd(38)} ${String(increment.length).padStart(9)} ${`${cost.toFixed(0)}c`.padStart(8)} `
      + `${`${profit >= 0 ? '+' : ''}${profit.toFixed(0)}c`.padStart(9)} ${`${(profit / days).toFixed(0)}c`.padStart(8)}`);
  }
}

console.log('\n=== 2d. where the combined increment\'s money actually comes from ===');
console.log('Per-window mean and stake-weighted disagree whenever a cohort mixes price levels, so both are');
console.log('shown with the cents each slice contributes. A slice carrying the mean on a small stake is');
console.log('fragile; one carrying it on real stake is not.');
{
  const increment = armResults.get('COMBINED floor −5pp + cutoff 30s + ceiling off')?.increment ?? [];
  const total = increment.reduce((sum, r) => sum + r.holdReturn * r.cost, 0);
  const slice = (label, rows) => {
    if (!rows.length) return console.log(`${label.padEnd(26)} none`);
    const cost = rows.reduce((sum, r) => sum + r.cost, 0);
    const profit = rows.reduce((sum, r) => sum + r.holdReturn * r.cost, 0);
    const per = clustered(rows, (r) => r.holdReturn);
    console.log(`${label.padEnd(26)} n=${String(rows.length).padStart(4)} cost=${`${cost.toFixed(0)}c`.padStart(6)} `
      + `perWindow=${`${per.mean >= 0 ? '+' : ''}${(100 * per.mean).toFixed(1)}%`.padStart(8)} `
      + `stakeWtd=${`${profit / cost >= 0 ? '+' : ''}${(100 * profit / cost).toFixed(1)}%`.padStart(8)} `
      + `profit=${`${profit >= 0 ? '+' : ''}${profit.toFixed(0)}c`.padStart(7)} ` 
      + `share=${`${(100 * profit / total).toFixed(0)}%`.padStart(5)}`);
  };
  console.log(`total increment profit ${total.toFixed(0)}c over ${increment.length} decisions\n`);
  for (const [lo, hi] of [[0, 0.15], [0.15, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.85], [0.85, 1]]) {
    slice(`  cost ${(100 * lo).toFixed(0)}-${(100 * hi).toFixed(0)}c`, increment.filter((r) => r.cost >= lo && r.cost < hi));
  }
  console.log('');
  slice('  won', increment.filter((r) => r.won));
  slice('  lost', increment.filter((r) => !r.won));
  console.log('');
  const sorted = [...increment].sort((a, b) => b.holdReturn * b.cost - a.holdReturn * a.cost);
  const top = sorted.slice(0, 10).reduce((sum, r) => sum + r.holdReturn * r.cost, 0);
  const top50 = sorted.slice(0, 50).reduce((sum, r) => sum + r.holdReturn * r.cost, 0);
  console.log(`  best 10 decisions contribute ${top.toFixed(0)}c = ${(100 * top / total).toFixed(0)}% of the total`);
  console.log(`  best 50 decisions contribute ${top50.toFixed(0)}c = ${(100 * top50 / total).toFixed(0)}% of the total`);
}

console.log('\n=== 2b. the same increments, demanding the durability proxy of both rules ===');
console.log('If an increment is a real repricing it survives being asked to persist. If it lives only in');
console.log('transient quote states it does not, which is the signature of a quote that cannot be filled.');
console.log(HEADER);
{
  const liveDurable = new Set();
  for (const window of windows) for (const side of sides) {
    if (firstEntry(window, side, LIVE, { requirePersistence: true })) liveDurable.add(`${window.key}|${side}`);
  }
  for (const arm of ARMS.slice(1)) {
    const increment = [];
    for (const window of windows) for (const side of sides) {
      const entry = firstEntry(window, side, arm.rule, { ...arm.options, requirePersistence: true });
      if (entry && !liveDurable.has(`${window.key}|${side}`)) increment.push(outcomeOf(entry));
    }
    report(arm.label, increment);
  }
}

console.log('\n=== 3. what the timing gates cost, on the live entry rule ===');
console.log('Persistence here is the over-strict proxy described in the header: three recorded calculations');
console.log('spanning 30s, which at a 55s median cadence is roughly 110s of continuous qualification. Read it');
console.log('as an upper bound on the cost of demanding durability, not as a replay of the production gate.');
console.log(HEADER);
const timingArms = [
  ['warmup+cutoff (as run)', { requirePersistence: false, executionWindow: true }],
  ['no execution window', { requirePersistence: false, executionWindow: false }],
  ['+ durability proxy', { requirePersistence: true, executionWindow: true }],
  ['durability, no window', { requirePersistence: true, executionWindow: false }],
];
const timingResults = new Map();
for (const [label, options] of timingArms) {
  const results = [];
  for (const window of windows) {
    for (const side of sides) {
      const entry = firstEntry(window, side, LIVE, options);
      if (entry) results.push({ ...outcomeOf(entry), enteredAt: entry.t });
    }
  }
  timingResults.set(label, results);
  report(label, results);
}

console.log('\n--- the same arms, restricted to entries taken 90-300s into the window ---');
console.log('Entry time is the confound: a looser timing gate enters earlier, at a price nearer 50c and with');
console.log('more time to run. Holding the entry window fixed removes it.');
console.log(HEADER);
for (const [label] of timingArms) {
  report(label, timingResults.get(label).filter((r) => r.enteredAt >= 90 && r.enteredAt <= 300));
}

console.log('\n--- admitted decisions by entry time, live rule, no execution window ---');
console.log(HEADER);
for (const [lo, hi] of [[0, 90], [90, 300], [300, 500], [500, 700], [700, 780], [780, 900]]) {
  report(`  entered ${lo}-${hi}s`, timingResults.get('no execution window').filter((r) => r.enteredAt >= lo && r.enteredAt < hi));
}

console.log('\n=== 3b. the venue price as a forecast: realized settlement by ask, every recorded side ===');
console.log('This is the market\'s own calibration, not the desk\'s. A band whose win rate exceeds its all-in');
console.log('cost is one where buying the favourite at the ask pays, whatever the model says about it.');
{
  const bands = new Map();
  for (const window of windows) {
    for (const side of sides) {
      // One observation per contract-side per window, taken mid-window, so a window contributes once.
      const row = window.rows.find((candidate) => candidate.t >= 300) ?? window.rows.at(-1);
      if (!row) continue;
      const price = row.asks[side];
      if (!(price > 0) || price >= 1) continue;
      const band = Math.floor(price * 10) / 10;
      const probability = side === 'UP' ? row.probabilityUp : 1 - row.probabilityUp;
      const entry = bands.get(band) ?? { n: 0, won: 0, cost: 0, model: 0, agree: { n: 0, won: 0, cost: 0 } };
      entry.n += 1; entry.won += window.outcome === side ? 1 : 0;
      entry.cost += price + feeRate(price); entry.model += probability;
      if (Math.abs(probability - price) <= 0.05) {
        entry.agree.n += 1; entry.agree.won += window.outcome === side ? 1 : 0; entry.agree.cost += price + feeRate(price);
      }
      bands.set(band, entry);
    }
  }
  console.log(`${'ask band'.padEnd(10)} ${'n'.padStart(5)} ${'all-in'.padStart(7)} ${'model'.padStart(7)} ${'realized'.padStart(9)} ${'return/$1'.padStart(10)} | model agrees within 5pp: n, realized, return`);
  for (const [band, entry] of [...bands].sort((a, b) => a[0] - b[0])) {
    const cost = entry.cost / entry.n;
    const realized = entry.won / entry.n;
    const agreeRealized = entry.agree.n ? entry.agree.won / entry.agree.n : null;
    const agreeCost = entry.agree.n ? entry.agree.cost / entry.agree.n : null;
    const se = Math.sqrt(realized * (1 - realized) / entry.n);
    console.log(`${`${(100 * band).toFixed(0)}-${(100 * band + 10).toFixed(0)}c`.padEnd(10)} ${String(entry.n).padStart(5)} `
      + `${(100 * cost).toFixed(1).padStart(7)} ${(100 * entry.model / entry.n).toFixed(1).padStart(7)} `
      + `${`${(100 * realized).toFixed(1)}±${(196 * se).toFixed(1)}`.padStart(11)} ${pct(realized / cost - 1).padStart(9)} | `
      + `${String(entry.agree.n).padStart(4)} ${agreeRealized === null ? '  —  ' : `${(100 * agreeRealized).toFixed(1)}%`.padStart(6)} `
      + `${agreeRealized === null ? '  —  ' : pct(agreeRealized / agreeCost - 1).padStart(7)}`);
  }
}

console.log('\n=== 4. capacity: how many decisions the live rule admits per window it is active in ===');
{
  const perWindow = new Map();
  for (const key of liveEntries.keys()) {
    const window = key.slice(0, key.lastIndexOf('|'));
    perWindow.set(window, (perWindow.get(window) ?? 0) + 1);
  }
  const active = [...new Set([...liveEntries.keys()].map((k) => k.split('|').slice(0, 2).join('|')))];
  const byClose = new Map();
  for (const key of liveEntries.keys()) {
    const closesAt = key.split('|')[1];
    byClose.set(closesAt, (byClose.get(closesAt) ?? 0) + 1);
  }
  const counts = [...byClose.values()].sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)];
  console.log(`live rule admits ${liveEntries.size} decisions across ${active.length} contract-windows and ${byClose.size} settlement times`);
  console.log(`simultaneous admitted decisions per settlement time: median ${median}, mean ${(liveEntries.size / byClose.size).toFixed(1)}, max ${counts.at(-1)}`);
  console.log('The desk holds at most DEFAULT_MAX_OPEN_POSITIONS (lib/portfolio-policy.ts) at once, so above that');
  console.log('count a looser gate changes which decision is taken, not how many.');
}

if (process.env.INSPECT) {
  const inc = armResults.get('edge floor −5pp').increment;
  const group = (name, key) => {
    const m = new Map();
    for (const r of inc) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    console.log(`\n-- floor −5pp increment by ${name} --`);
    console.log(HEADER);
    for (const [k, v] of [...m].sort()) report(`  ${k}`, v);
  };
  group('day', (r) => r.day);
  group('side', (r) => r.side);
  group('symbol', (r) => r.symbol ?? '?');
  group('cost band', (r) => `${Math.floor(r.cost * 10) * 10}c`);
}

console.log('\n=== 5. the committed sentinel that already measures this: persistence-two-consecutive-v1 ===');
console.log('SPEC §706. Unlike every arm above, these intents were written at decision time and followed to');
console.log('settlement, so they are the only cohort here that could ever authorize a promotion (AGENTS §5.5).');
{
  const file = path.join(DATA, 'persistence-candidate.json');
  if (!existsSync(file)) {
    console.log('No persistence-candidate.json in data/.');
  } else {
    const store = JSON.parse(await readFile(file, 'utf8'));
    const intents = (store.intents ?? []).filter((intent) => intent.productionEligibleAtCandidate === false && intent.outcome);
    // Return per $1 committed at the recorded ask, from the sentinel's own settled profit field.
    const unit = (intent) => intent.askProfitPerContract / (intent.askPrice + intent.estimatedAskFeeRate);
    const line = (label, list) => {
      if (!list.length) return console.log(`${label.padEnd(40)} none`);
      const stat = clustered(list.map((intent) => ({ window: `${intent.symbol}|${intent.closesAt}`, value: unit(intent) })), (r) => r.value);
      console.log(`${label.padEnd(40)} n=${pad(list.length, 4)} windows=${pad(stat.windows, 4)} `
        + `${pad(pct(stat.mean), 7)} ±${pad((196 * stat.standardError).toFixed(1), 5)} t=${stat.t.toFixed(2)}`);
    };
    line('all incremental intents, all eras', intents);
    line('  production never became eligible', intents.filter((intent) => !intent.productionEligibleAt));
    line('  production caught up later', intents.filter((intent) => intent.productionEligibleAt));
    for (const version of [...new Set(intents.map((intent) => intent.productionPolicyVersion))]) {
      line(`  under ${version.slice(-3)}`, intents.filter((intent) => intent.productionPolicyVersion === version));
    }
    const byDay = new Map();
    for (const intent of intents) {
      const day = byDay.get(intent.closesAt.slice(0, 10)) ?? { profit: 0, cost: 0 };
      day.profit += intent.askProfitPerContract; day.cost += intent.askPrice + intent.estimatedAskFeeRate;
      byDay.set(intent.closesAt.slice(0, 10), day);
    }
    console.log(`by settlement day: ${[...byDay].sort().map(([day, v]) => `${day} ${pct(v.profit / v.cost)}`).join('  ')}`);
    const delays = intents.map((intent) => intent.productionDelayMs).filter(Number.isFinite).sort((a, b) => a - b);
    console.log(`production catch-up delay: median ${(delays[Math.floor(delays.length / 2)] / 1000).toFixed(0)}s, `
      + `p90 ${(delays[Math.floor(delays.length * 0.9)] / 1000).toFixed(0)}s`);
    const touched = (store.intents ?? []).filter((intent) => intent.makerTouchStatus).length;
    console.log(`prospective maker-touch benchmark recorded on ${touched} of ${(store.intents ?? []).length} intents — `
      + 'the fill question these returns do not answer.');
  }
}

console.log(`\n=== 6. multiple comparisons ===`);
console.log(`${ARMS.length - 1} relaxations were scored, each on two aggregations and three exit treatments.`);
console.log('One arm at t above 2 is expected from noise alone at this width; a group of related arms moving');
console.log('together is the evidence, per AGENTS §5.3.');
