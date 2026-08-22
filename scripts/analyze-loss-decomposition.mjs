/**
 * Where the edge policy's money goes: one conditional chain from the gate's return to the realized one.
 *
 *   npm run analyze:loss-decomposition
 *
 * WHY A CHAIN
 *   The standalone estimates do not compose. Window selection reads ~16pp, fill selection ~25pp, the maker
 *   discount ~16pp — each measured against a different baseline, so an order that sits in a bad window
 *   *and* is a bad fill is counted in both. Conditioning each step on the previous makes every delta the
 *   marginal cost of that decision alone, and the steps then sum to the observed gap by construction.
 *
 *   The chain, each stage a strict subset or a repricing of the one above it:
 *
 *     1 every admitted row, bought at the ask, held to settlement   <- what the gate is worth
 *     2   ... restricted to windows the desk was active for          delta = WINDOW SELECTION
 *     3   ... restricted to the contracts it actually ordered        delta = ORDERED-COHORT SELECTION
 *     4   ... restricted to the orders that filled                   delta = FILL SELECTION
 *     5   ... repriced at the maker fill instead of the ask          delta = PRICE (the discount earned)
 *     6   ... with the exits it actually took                        delta = EXIT RULE
 *                                                                    = realized
 *
 * WHAT MAKES IT READABLE
 *   Each stage prints its **conditional** delta beside the **standalone** figure the same comparison gives
 *   when measured against the full cohort. The difference between the two is the double-counting, and it
 *   is the whole reason this file exists.
 *
 *   Every stage also prints the number of settlement windows it rests on. A point estimate hides that the
 *   within-window fill comparison has only ~21 usable windows on live, which is why that split is currently
 *   unresolved there.
 *
 * METHOD
 *   Return is per dollar committed, held to settlement, net of the entry fee: `(1 - ask - fee)/(ask + fee)`
 *   on a win and −1 otherwise — the same expression `analyze:entry-realization` uses, so the two agree at
 *   stage 1. Sizing is not modelled, so integer-rounding artefacts cannot enter. Every stage is clustered
 *   on the settlement window, error over windows (AGENTS §5.1).
 *
 * BIASES
 *   - Stage 6 is the only stage containing exits; 1-5 are held to settlement. The exit delta therefore
 *     carries every difference between holding and the desk's actual exit behaviour, including switches.
 *   - Stage 3 is a cohort narrowing, not a decision-time ranking comparison. The 2026-08-19 state replay
 *     found chosen minus production-preferred at -0.9pp +/-2.7pp (95%) over 232 v17-v19 windows; call
 *     this ordered-cohort selection and do not infer a ranking defect from it.
 *   - Stages 1-3 are admitted rows from the forecast history; 4-6 are orders. A row and an order are
 *     matched on (symbol, window, side), so a decision the desk made outside an admitted row is invisible.
 *   - **Admitted rows are deduplicated to one per (symbol, window, side)**, keeping the first qualifying
 *     calculation. The forecast history records a row per calculation — several hundred a window — while an
 *     order is one decision, so without this the early stages would be weighted by how long a contract
 *     stayed qualified rather than by opportunity, and would not be comparable to the order stages.
 *   - Read-only. Places no order, writes nothing, and promotes nothing (AGENTS §5.5).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readForecastHistory } from './lib/forecast-history.mjs';
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const SHARDS = path.join(DATA, 'forecast-history-shards');

const COHORTS = [
  { label: 'v17', suffix: '-v17' },
  { label: 'v18 (fresh2pp)', suffix: 'fresh2pp-v18' },
  // v19 disarmed the edge-spike gate. It is the policy the desk is running, so it is the one that has to
  // be decomposed; carrying only the retired eras is how a current loss goes unmeasured.
  { label: 'v19 (spike gate disarmed)', suffix: '-v19' },
];

const feeRate = (venue, price) => (venue === 'kalshi' ? 0.07 * price * (1 - price) : 0.01 * price);
/** The gate as `admissibleEntry` + `qualifiesAsBuyEdge` express it in lib/prediction-policy.ts. */
const admits = (r) => r.ask >= 0.05 && r.ask <= 0.97 && r.probability >= 0.55
  && r.netEdge >= 0.05 && r.netEdge < 0.35 && r.confidence >= 0.5;
/** Per dollar committed, held to settlement, net of the entry fee. */
const perDollar = (won, price, fee) => (won ? (1 - price - fee) / (price + fee) : -1);

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
    rows.push({
      closesAt: row.closesAt, symbol: row.symbol, side, ask, fee, probability,
      confidence: row.confidence, netEdge: probability - ask - fee, won: row.outcome === side,
    });
  }
}
// Shards + open shard + journal patches. Reading shards alone reported zero rows for v19 while the desk
// was trading it, because `open.json` was hours stale and resolution arrives as a journal patch.
take(await readForecastHistory(DATA));

const allOrders = (await readExecutionLedger(DATA)).orders
  .filter((o) => !o.id.includes(':exit:') && o.strategyId !== 'long-shot-round-trip');

const wasFilled = (o) => ['won', 'lost', 'sold', 'open'].includes(o.status);

function cluster(list) {
  if (!list.length) return { mean: null, standardError: null, windows: 0, n: 0 };
  const byWindow = new Map();
  for (const item of list) byWindow.set(item.key, [...(byWindow.get(item.key) ?? []), item.value]);
  const per = [...byWindow.values()].map((a) => a.reduce((s, x) => s + x, 0) / a.length);
  const mean = per.reduce((s, x) => s + x, 0) / per.length;
  return {
    mean,
    standardError: per.length > 1
      ? Math.sqrt(per.reduce((s, x) => s + (x - mean) ** 2, 0) / (per.length - 1) / per.length) : null,
    windows: per.length,
    n: list.length,
  };
}

const pct = (v, d = 1) => v === null ? '     —' : `${v >= 0 ? '+' : '−'}${Math.abs(100 * v).toFixed(d)}%`;

for (const cohort of COHORTS) {
  const orders = allOrders.filter((o) => (o.entryDecision?.policyVersion ?? '').endsWith(cohort.suffix));
  if (orders.length < 20) continue;
  console.log(`\n================ ${cohort.label} ================`);

  for (const mode of ['live', 'paper']) {
    const mine = orders.filter((o) => o.executionMode === mode);
    if (mine.length < 20) continue;

    const orderedKeys = new Set(mine.map((o) => `${o.symbol}|${o.closesAt}|${o.side}`));
    const activeWindows = new Set(mine.map((o) => o.closesAt));
    const filledKeys = new Set(mine.filter(wasFilled).map((o) => `${o.symbol}|${o.closesAt}|${o.side}`));

    // Cohort window derived from the orders themselves rather than hardcoded, so a version's period is
    // never asserted separately from the ledger that defines it.
    const closes = mine.map((o) => Date.parse(o.closesAt));
    const from = Math.min(...closes);
    const to = Math.max(...closes);
    const deduped = new Map();
    for (const r of rows) {
      if (!admits(r) || Date.parse(r.closesAt) < from || Date.parse(r.closesAt) > to) continue;
      const key = `${r.symbol}|${r.closesAt}|${r.side}`;
      if (!deduped.has(key)) deduped.set(key, r);
    }
    const admitted = [...deduped.values()];
    const asRow = (r) => ({ key: r.closesAt, value: perDollar(r.won, r.ask, r.fee) });

    // Stages 1-4: the same pricing throughout, narrowing the population one decision at a time.
    const s1 = cluster(admitted.map(asRow));
    const s2 = cluster(admitted.filter((r) => activeWindows.has(r.closesAt)).map(asRow));
    const s3 = cluster(admitted.filter((r) => orderedKeys.has(`${r.symbol}|${r.closesAt}|${r.side}`)).map(asRow));
    const s4 = cluster(admitted.filter((r) => filledKeys.has(`${r.symbol}|${r.closesAt}|${r.side}`)).map(asRow));

    // Stage 5: the same filled population, repriced at what the maker actually paid. A maker pays no fee.
    const filledOrders = mine.filter(wasFilled).filter((o) => outcomes.has(`${o.symbol}|${o.closesAt}`));
    const s5 = cluster(filledOrders.map((o) => {
      const won = outcomes.get(`${o.symbol}|${o.closesAt}`) === o.side;
      const fee = o.liquidityRole === 'maker' ? 0 : feeRate(o.venue ?? 'kalshi', o.askPrice);
      return { key: o.closesAt, value: perDollar(won, o.askPrice, fee) };
    }));

    // Stage 6: what actually happened, exits included.
    const s6 = cluster(filledOrders
      .filter((o) => (o.actualStakeCents ?? o.stakeCents) > 0)
      .map((o) => ({ key: o.closesAt, value: (o.actualPnlCents ?? o.pnlCents ?? 0) / (o.actualStakeCents ?? o.stakeCents) })));

    // Standalone equivalents: the same comparison measured against the whole cohort rather than conditioned.
    const passedOver = cluster(admitted.filter((r) => activeWindows.has(r.closesAt)
      && !orderedKeys.has(`${r.symbol}|${r.closesAt}|${r.side}`)).map(asRow));
    const unfilledStandalone = cluster(admitted.filter((r) => orderedKeys.has(`${r.symbol}|${r.closesAt}|${r.side}`)
      && !filledKeys.has(`${r.symbol}|${r.closesAt}|${r.side}`)).map(asRow));

    console.log(`\n--- ${mode} ---`);
    console.log('stage                                      return/$1   windows      rows   conditional Δ');
    const line = (label, stat, previous) => {
      const delta = (stat.mean !== null && previous !== null && previous.mean !== null) ? stat.mean - previous.mean : null;
      console.log(`${label.padEnd(42)}${pct(stat.mean).padStart(8)}${String(stat.windows).padStart(10)}${String(stat.n).padStart(10)}`
        + `${(delta === null ? '' : pct(delta)).padStart(16)}`);
    };
    line('1 every admitted row, at ask, held', s1, null);
    line('2   in windows the desk was active for', s2, s1);
    line('3   contracts it actually ordered', s3, s2);
    line('4   the ones that filled', s4, s3);
    line('5   repriced at the maker fill', s5, s4);
    line('6   with the exits it took  = REALIZED', s6, s5);

    if (s1.mean !== null && s6.mean !== null) {
      console.log(`\n  gate to realized: ${pct(s1.mean)} → ${pct(s6.mean)}  =  ${pct(s6.mean - s1.mean)}`);
    }
    console.log('\n  conditional vs standalone (the gap between them is the double-counting):');
    if (s2.mean !== null && s3.mean !== null && passedOver.mean !== null) {
      console.log(`    ordered-cohort sel.  conditional ${pct(s3.mean - s2.mean)}`
        + `   standalone (ordered − passed over) ${pct(s3.mean - passedOver.mean)}`
        + `   [passed over: ${passedOver.windows} windows]`);
    }
    if (s3.mean !== null && s4.mean !== null && unfilledStandalone.mean !== null) {
      console.log(`    fill selection       conditional ${pct(s4.mean - s3.mean)}`
        + `   standalone (filled − unfilled)     ${pct(s4.mean - unfilledStandalone.mean)}`
        + `   [unfilled: ${unfilledStandalone.windows} windows]`);
    }
  }
}

console.log('\nStage 6 is the only stage containing exits; 1-5 are held to settlement, so the exit delta');
console.log('carries every difference between holding and what the desk actually did, switches included.');
console.log('Nothing here promotes anything: a live-money change needs a manifest entry and a decision.');
