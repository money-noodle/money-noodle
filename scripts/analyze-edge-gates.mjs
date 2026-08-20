/**
 * Sweeps the edge policy's entry gates against realized settlement, from recorded forecasts.
 *
 *   npm run analyze:edge-gates
 *
 * Every qualifying forecast records the ask it would have paid, the side it chose, and — once resolved —
 * which side won. That is enough to score the gate itself: for each candidate threshold, what did the
 * cohort it admits actually return? `return` here is per dollar committed, net of the entry fee, held to
 * settlement.
 *
 * Two things about this measurement are easy to get wrong, and both were got wrong before being fixed here.
 *
 * **1. The unit of independence is the settlement window, not the forecast row.** The desk issues a
 * forecast every few seconds, so one fifteen-minute BTC window contributes dozens of rows that share a
 * single coin flip. Treating them as independent trials shrinks every confidence interval by roughly the
 * square root of that multiplicity and manufactures significance out of nothing: scored per row, six of
 * seven assets came out "significant" and BNB looked like a confirmed loser. Scored per window they are
 * indistinguishable. Every interval below is clustered — see `score`.
 *
 * **2. It is a fill-optimistic counterfactual and is not a P&L forecast.** It assumes every admitted
 * candidate is bought at the recorded ask. The desk enters as a maker, and 420 of 821 live entries never
 * filled — the ones that do fill are selected by the market moving toward the price, which is adverse.
 * What survives that bias is the ranking between cohorts and the sign, not the level.
 */
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');
const SHARDS = path.join(DATA, 'forecast-history-shards');

/** Kalshi charges `0.07 * p * (1 - p)` per contract on entry; Polymarket `0.01 * p`. Settlement is free. */
const feeRate = (venue, price) => (venue === 'kalshi' ? 0.07 * price * (1 - price) : 0.01 * price);

/** Only the fields the sweep needs, so a 43 MB shard does not stay resident as parsed objects. */
function project(row) {
  if (row.status !== 'resolved' || !row.outcome) return null;
  const ask = row.entryAsk;
  if (!(ask > 0) || ask >= 1) return null;
  const side = row.entrySide ?? 'UP';
  const venue = row.entryVenue ?? 'kalshi';
  const probability = side === 'UP' ? row.probabilityUp : 1 - row.probabilityUp;
  const fee = row.entryFeeRate ?? feeRate(venue, ask);
  return {
    won: row.outcome === side,
    ask, side, venue, probability, fee,
    netEdge: probability - ask - fee,
    confidence: row.confidence ?? 0,
    secondsRemaining: row.secondsRemaining ?? null,
    symbol: row.symbol,
    issuedAt: row.issuedAt,
    // The settlement window this row bets on. All rows sharing it share one outcome.
    window: row.cycleId ?? `${row.symbol}|${row.closesAt}`,
    day: row.issuedAt.slice(0, 10),
  };
}

async function load() {
  const rows = [];
  const take = (list) => { for (const row of list) { const p = project(row); if (p) rows.push(p); } };

  if (existsSync(SHARDS)) {
    const index = JSON.parse(await readFile(path.join(SHARDS, 'index.json'), 'utf8'));
    for (const shard of index.shards) {
      take(JSON.parse(await readFile(path.join(SHARDS, shard.file), 'utf8')));
    }
    const open = path.join(SHARDS, 'open.json');
    if (existsSync(open)) take(JSON.parse(await readFile(open, 'utf8')));
  } else {
    take(JSON.parse(await readFile(path.join(DATA, 'forecast-history.json'), 'utf8')));
  }

  const journal = path.join(DATA, 'forecast-history.journal.jsonl');
  if (existsSync(journal)) {
    const seen = new Set();
    const stream = readline.createInterface({ input: createReadStream(journal) });
    for await (const line of stream) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const record = row.forecast ?? row;
        if (!record?.id || seen.has(record.id)) continue;
        seen.add(record.id);
        const p = project(record);
        if (p) rows.push(p);
      } catch { /* a damaged line is skipped rather than failing the whole read */ }
    }
  }
  return rows;
}

/** Return per dollar committed, net of entry fee, held to settlement. */
const unitReturn = (row) => (row.won ? 1 : 0) / (row.ask + row.fee) - 1;

/**
 * Mean return with an interval clustered on the settlement window.
 *
 * The cluster is the correction that matters. Rows within a window share one outcome, so the effective
 * sample size is the number of windows, and the interval is computed from the spread of window means
 * rather than of individual rows.
 */
function score(rows, clusterKey = 'window') {
  if (!rows.length) return null;
  const clusters = new Map();
  for (const row of rows) {
    const key = row[clusterKey];
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(unitReturn(row));
  }
  const means = [...clusters.values()].map((list) => list.reduce((a, b) => a + b, 0) / list.length);
  const mean = means.reduce((a, b) => a + b, 0) / means.length;
  const variance = means.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, means.length - 1);
  const stderr = Math.sqrt(variance / means.length);
  return {
    n: rows.length,
    clusters: means.length,
    winRate: rows.filter((r) => r.won).length / rows.length,
    meanReturn: mean,
    lo: mean - 1.96 * stderr,
    hi: mean + 1.96 * stderr,
    meanAsk: rows.reduce((a, r) => a + r.ask, 0) / rows.length,
  };
}

const pct = (v) => `${(100 * v).toFixed(1)}%`;
const signed = (v) => `${v >= 0 ? '+' : ''}${(100 * v).toFixed(1)}%`;

function table(title, buckets) {
  console.log(`\n${title}`);
  console.log('  bucket                 rows  windows   win%    ask    return        95% interval');
  for (const [label, rows] of buckets) {
    const s = score(rows);
    if (!s || s.clusters < 30) {
      console.log(`  ${label.padEnd(20)} ${String(s?.n ?? 0).padStart(6)} ${String(s?.clusters ?? 0).padStart(8)}   (too few windows)`);
      continue;
    }
    const verdict = s.lo > 0 ? '  profitable' : s.hi < 0 ? '  LOSING' : '  —';
    console.log(
      `  ${label.padEnd(20)} ${String(s.n).padStart(6)} ${String(s.clusters).padStart(8)}  ${pct(s.winRate).padStart(6)}  `
      + `${s.meanAsk.toFixed(2)}  ${signed(s.meanReturn).padStart(7)}   [${signed(s.lo).padStart(7)}, ${signed(s.hi).padStart(7)}]${verdict}`,
    );
  }
}

const rows = await load();
const qualifying = rows.filter((r) => r.netEdge >= 0.05 && r.netEdge < 0.35
  && r.confidence >= 0.5 && r.probability >= 0.55 && r.ask >= 0.05 && r.ask <= 0.97);

console.log(`resolved entries with a recorded ask: ${rows.length}`);
console.log(`admitted by the retired v17 gates:  ${qualifying.length} rows in ${new Set(qualifying.map((r) => r.window)).size} settlement windows`);
const overall = score(qualifying);
if (overall) {
  console.log(`\nretired v17 policy cohort: ${pct(overall.winRate)} win, ${signed(overall.meanReturn)} mean return `
    + `[${signed(overall.lo)}, ${signed(overall.hi)}] clustered on ${overall.clusters} windows`);
  const naive = (() => {
    const returns = qualifying.map(unitReturn);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const v = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
    const se = Math.sqrt(v / returns.length);
    return `[${signed(mean - 1.96 * se)}, ${signed(mean + 1.96 * se)}]`;
  })();
  console.log(`  (unclustered, and wrong, the same cohort reads ${naive} — the width difference is the correction)`);
}

const band = (rows, key, edges) => edges.slice(0, -1).map((lo, i) => {
  const hi = edges[i + 1];
  return [`${key} ${lo.toFixed(2)}-${hi.toFixed(2)}`, rows.filter((r) => r[key] >= lo && r[key] < hi)];
});

table('net edge (within all other retired v17 gates)', band(qualifying, 'netEdge', [0.05, 0.10, 0.15, 0.20, 0.25, 0.35]));
table('entry price (within all other retired v17 gates)', band(qualifying, 'ask', [0.05, 0.20, 0.40, 0.60, 0.80, 0.98]));
table('model side probability', band(qualifying, 'probability', [0.55, 0.60, 0.65, 0.75, 0.85, 1.01]));
table('estimate quality (confidence)', band(qualifying, 'confidence', [0.5, 0.6, 0.7, 0.8, 1.01]));

const withTime = qualifying.filter((r) => r.secondsRemaining !== null);
table('seconds remaining at issuance', band(withTime, 'secondsRemaining', [0, 120, 300, 600, 900, 100000]));

table('side', [['UP', qualifying.filter((r) => r.side === 'UP')], ['DOWN', qualifying.filter((r) => r.side === 'DOWN')]]);

const symbols = [...new Set(qualifying.map((r) => r.symbol))].sort();
table('asset', symbols.map((s) => [s, qualifying.filter((r) => r.symbol === s)]));

// --- stability -------------------------------------------------------------------------------------
// A spread across seven assets is the shape a multiple-comparisons artefact takes. Day-level sign is a
// blunt check that needs no distributional assumption: a real effect should not be a coin flip by day.
console.log('\n\nper-asset return by day (· = fewer than 30 rows)');
const days = [...new Set(qualifying.map((r) => r.day))].sort();
console.log('  asset  ' + days.map((d) => d.slice(5).padStart(9)).join('') + '   |   pooled   +days');
for (const symbol of symbols) {
  const cells = days.map((day) => {
    const subset = qualifying.filter((r) => r.symbol === symbol && r.day === day);
    return (subset.length < 30 ? '·' : signed(score(subset).meanReturn)).padStart(9);
  });
  const scored = days.map((day) => qualifying.filter((r) => r.symbol === symbol && r.day === day))
    .filter((s) => s.length >= 30).map((s) => score(s));
  const positive = scored.filter((s) => s.meanReturn > 0).length;
  const total = score(qualifying.filter((r) => r.symbol === symbol));
  console.log(`  ${symbol.padEnd(6)} ${cells.join('')}   | ${signed(total.meanReturn).padStart(8)}    ${positive}/${scored.length}`);
}
