/**
 * Tests whether the edge policy's returns cluster by time of day, in the timezone of the people trading.
 *
 *   npm run analyze:trading-clock
 *
 * The hypothesis is that Kalshi's retail flow is shaped by the US working day — people betting before
 * work, at lunch, and after dinner — and that the book is priced worse when that flow dominates and
 * better when it does not. If true it should show up as a return difference between named blocks of the
 * day, and it should be stronger on weekends and weekdays differently.
 *
 * Two things make this an easy question to answer wrongly.
 *
 * **Multiple comparisons.** There are 24 hours, and scanning all of them guarantees two or three clear
 * two-standard-error results under a null of no effect. So the blocks below are fixed in advance from the
 * hypothesis — they are not chosen by looking at which hours paid. The hour-by-hour scan is printed
 * afterwards and is descriptive only: it exists to show whether a block result is carried by the whole
 * block or by one lucky hour inside it, never to nominate an hour to trade.
 *
 * **Thin cells.** The history is nine days. An hour-of-day cell holds roughly nine daily observations,
 * and an hour-by-weekday cell holds four or five. Any hour-level reading is under-powered by
 * construction and is reported with its window count so that is visible.
 *
 * Returns are held-to-settlement counterfactuals on the gate-qualifying population and are
 * fill-optimistic — see analyze-edge-gates.mjs. The realized ledger is scored separately at the end,
 * where the sample is far smaller but the money is real.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const SHARDS = path.join(DATA, 'forecast-history-shards');
/** Kalshi is a US venue and its retail flow keeps US Eastern office hours. */
const TZ = 'America/New_York';

const clockParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour: '2-digit', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
});
function clock(iso) {
  const parts = Object.fromEntries(clockParts.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return {
    hour: Number(parts.hour),
    weekday: parts.weekday,
    weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun',
    day: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * Blocks of the US working day, fixed before looking at any return.
 *
 * The boundaries are behavioural rather than exchange hours: crypto settles around the clock, so the
 * only thing that changes at 09:00 Eastern is who is awake and holding a phone.
 */
const BLOCKS = [
  ['overnight 00-06', (h) => h >= 0 && h < 6],
  ['pre-work 06-09', (h) => h >= 6 && h < 9],
  ['work morning 09-12', (h) => h >= 9 && h < 12],
  ['work afternoon 12-17', (h) => h >= 12 && h < 17],
  ['after work 17-21', (h) => h >= 17 && h < 21],
  ['late evening 21-24', (h) => h >= 21 && h < 24],
];

const feeRate = (venue, price) => (venue === 'kalshi' ? 0.07 * price * (1 - price) : 0.01 * price);

async function loadForecasts() {
  const rows = [];
  const take = (list) => {
    for (const row of list) {
      if (row.status !== 'resolved' || !row.outcome || !(row.entryAsk > 0) || row.entryAsk >= 1) continue;
      const side = row.entrySide ?? 'UP';
      const probability = side === 'UP' ? row.probabilityUp : 1 - row.probabilityUp;
      const fee = row.entryFeeRate ?? feeRate(row.entryVenue ?? 'kalshi', row.entryAsk);
      const netEdge = probability - row.entryAsk - fee;
      // The gate the desk actually trades. Scoring the ungated population would mix a clock effect with
      // the gate's own composition changing through the day.
      if (!(netEdge >= 0.05 && netEdge < 0.35 && (row.confidence ?? 0) >= 0.5 && probability >= 0.55)) continue;
      rows.push({
        won: row.outcome === side, ask: row.entryAsk, fee,
        window: `${row.symbol}|${row.closesAt}`, ...clock(row.issuedAt),
      });
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
  return rows;
}

const unitReturn = (row) => (row.won ? 1 : 0) / (row.ask + row.fee) - 1;

/** Mean with an interval clustered on the settlement window — rows in a window share one outcome. */
function score(rows, value = unitReturn) {
  if (!rows.length) return null;
  const clusters = new Map();
  for (const row of rows) {
    if (!clusters.has(row.window)) clusters.set(row.window, []);
    clusters.get(row.window).push(value(row));
  }
  const means = [...clusters.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  const mean = means.reduce((a, b) => a + b, 0) / means.length;
  const variance = means.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, means.length - 1);
  const stderr = Math.sqrt(variance / means.length);
  return {
    n: rows.length, clusters: means.length, mean, stderr,
    lo: mean - 1.96 * stderr, hi: mean + 1.96 * stderr,
    win: rows.filter((r) => r.won).length / rows.length,
  };
}

const S = (v) => `${v >= 0 ? '+' : ''}${(100 * v).toFixed(1)}%`;

function row(label, rows, minWindows = 30) {
  const s = score(rows);
  if (!s || s.clusters < minWindows) {
    console.log(`  ${label.padEnd(22)}${String(rows.length).padStart(6)}${String(s?.clusters ?? 0).padStart(8)}w   (too few windows)`);
    return null;
  }
  const flag = s.lo > 0 ? ' *' : s.hi < 0 ? ' LOSING' : '';
  console.log(`  ${label.padEnd(22)}${String(s.n).padStart(6)}${String(s.clusters).padStart(8)}w  ${(100 * s.win).toFixed(1).padStart(5)}%  `
    + `${S(s.mean).padStart(7)}  [${S(s.lo).padStart(7)},${S(s.hi).padStart(7)}]${flag}`);
  return s;
}

const forecasts = await loadForecasts();
const days = [...new Set(forecasts.map((r) => r.day))].sort();
console.log(`gate-qualifying resolved rows: ${forecasts.length} over ${days.length} days (${days[0]} to ${days.at(-1)}), `
  + `${new Set(forecasts.map((r) => r.window)).size} settlement windows, clock = ${TZ}`);

console.log('\nPRE-SPECIFIED BLOCKS OF THE US WORKING DAY');
console.log('  block                   rows  windows    win%   return         95% interval');
const blockScores = BLOCKS.map(([label, test]) => [label, row(label, forecasts.filter((r) => test(r.hour)))]);

const usable = blockScores.filter(([, s]) => s);
if (usable.length > 1) {
  const best = usable.reduce((a, b) => (b[1].mean > a[1].mean ? b : a));
  const worst = usable.reduce((a, b) => (b[1].mean < a[1].mean ? b : a));
  const diff = best[1].mean - worst[1].mean;
  const se = Math.sqrt(best[1].stderr ** 2 + worst[1].stderr ** 2);
  console.log(`\n  widest gap: ${best[0]} minus ${worst[0]} = ${S(diff)} +/- ${(100 * se).toFixed(1)}`);
  console.log(`  that is ${(diff / se).toFixed(1)} standard errors`
    + `${Math.abs(diff / se) > 2 ? ' — but it is the largest of ' + usable.length + ' blocks, so treat 2 SE as the wrong bar here' : ' — not a difference'}`);
}

console.log('\nWEEKDAY VERSUS WEEKEND');
console.log('  block                   rows  windows    win%   return         95% interval');
row('weekday', forecasts.filter((r) => !r.weekend));
row('weekend', forecasts.filter((r) => r.weekend));

console.log('\nWORKING HOURS VERSUS THE REST, WEEKDAYS ONLY');
console.log('  block                   rows  windows    win%   return         95% interval');
const weekdays = forecasts.filter((r) => !r.weekend);
row('09-17 weekday', weekdays.filter((r) => r.hour >= 9 && r.hour < 17));
row('outside 09-17', weekdays.filter((r) => r.hour < 9 || r.hour >= 17));

console.log('\nHOUR BY HOUR — DESCRIPTIVE ONLY, NOT A SHORTLIST');
console.log('  Every hour here is one of 24 looks at noise; the interval shown is uncorrected.');
console.log('  hour ET                 rows  windows    win%   return         95% interval');
for (let hour = 0; hour < 24; hour += 1) {
  row(`${String(hour).padStart(2, '0')}:00`, forecasts.filter((r) => r.hour === hour), 20);
}

/**
 * Cochran's Q: is the spread between cells larger than their own error bars can explain?
 *
 * This is the test the question actually asks. Comparing each hour against zero asks "did this hour
 * make money", and on a population whose overall mean is already +15% most hours will, so counting the
 * ones that clear two standard errors measures the overall edge and the number of looks taken, not
 * clustering. Q instead compares every cell against the *grand mean* and asks whether the differences
 * exceed sampling noise. Under no clock effect Q follows chi-square with (cells - 1) degrees of freedom.
 */
function heterogeneity(cells) {
  const usable = cells.filter(([, s]) => s && s.stderr > 0);
  if (usable.length < 2) return null;
  const weight = (s) => 1 / s.stderr ** 2;
  const grand = usable.reduce((a, [, s]) => a + weight(s) * s.mean, 0) / usable.reduce((a, [, s]) => a + weight(s), 0);
  const q = usable.reduce((a, [, s]) => a + weight(s) * (s.mean - grand) ** 2, 0);
  const df = usable.length - 1;
  // Wilson-Hilferty: a chi-square with df degrees of freedom is close to normal after a cube root.
  const z = (Math.cbrt(q / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return { q, df, z, grand, cells: usable.length };
}

function reportHeterogeneity(label, cells) {
  const h = heterogeneity(cells);
  if (!h) { console.log(`  ${label}: not enough cells`); return; }
  console.log(`  ${label}: Q = ${h.q.toFixed(1)} on ${h.df} df (${h.cells} cells, weighted mean ${S(h.grand)}), z = ${h.z.toFixed(2)}`);
  console.log(`    ${h.z > 2
    ? 'the cells differ by more than their error bars allow — a real clock effect'
    : 'the spread is what independent cells with these error bars produce anyway — no clock effect'}`);
}

console.log('\nIS THERE ANY CLOCK EFFECT AT ALL? (Cochran heterogeneity, the correct test)');
reportHeterogeneity('blocks   ', blockScores);
reportHeterogeneity('24 hours ', Array.from({ length: 24 }, (_, hour) =>
  [String(hour), score(forecasts.filter((r) => r.hour === hour))]).filter(([, s]) => s && s.clusters >= 20));

console.log('\nDOES THE BEST BLOCK HOLD UP DAY BY DAY?');
if (usable.length > 1) {
  const best = usable.reduce((a, b) => (b[1].mean > a[1].mean ? b : a));
  const test = BLOCKS.find(([label]) => label === best[0])[1];
  const inBlock = forecasts.filter((r) => test(r.hour));
  let positive = 0, counted = 0;
  const cells = days.map((day) => {
    const subset = inBlock.filter((r) => r.day === day);
    const s = score(subset);
    if (!s || s.clusters < 10) return `${day.slice(5)} ·`;
    counted += 1;
    if (s.mean > 0) positive += 1;
    return `${day.slice(5)} ${S(s.mean)}`;
  });
  console.log(`  ${best[0]}: ${cells.join('   ')}`);
  console.log(`  positive on ${positive} of ${counted} days with a usable sample`);
}

// --- the real ledger, where the sample is small and the money is not hypothetical -------------------
const ledger = await readExecutionLedger(DATA);
const orders = (Array.isArray(ledger) ? ledger : Object.values(ledger).find(Array.isArray))
  .filter((o) => o.strategyId !== 'long-shot-round-trip' && !o.id.includes(':exit:')
    && ['won', 'lost', 'sold'].includes(o.status));

console.log('\n\nREALIZED LEDGER BY BLOCK (small sample, real money)');
console.log('  Live and paper are NOT independent confirmations of each other: they trade the same signals');
console.log('  on the same windows at the same times, so agreeing in sign is expected, not corroborating.');
for (const mode of ['live', 'paper']) {
  console.log(`\n  ${mode.toUpperCase()}   block                 orders  windows   staked      P&L    return`);
  const cells = [];
  for (const [label, test] of BLOCKS) {
    const group = orders.filter((o) => o.executionMode === mode && test(clock(o.createdAt).hour));
    if (!group.length) { console.log(`         ${label.padEnd(22)} (none)`); continue; }
    const staked = group.reduce((a, o) => a + (Number(o.actualStakeCents) || Number(o.stakeCents) || 0), 0);
    const pnl = group.reduce((a, o) => a + (Number(o.actualPnlCents) || 0), 0);
    const scored = score(
      group.map((o) => ({
        window: `${o.symbol}|${o.closesAt}`, won: o.status === 'won',
        r: (Number(o.actualPnlCents) || 0) / (Number(o.actualStakeCents) || Number(o.stakeCents) || 1),
      })),
      (r) => r.r,
    );
    cells.push([label, scored]);
    console.log(`         ${label.padEnd(22)}${String(group.length).padStart(6)}${String(scored?.clusters ?? 0).padStart(8)}w${staked.toFixed(0).padStart(9)}c${pnl.toFixed(0).padStart(9)}c   ${staked ? S(pnl / staked).padStart(7) : '—'}`);
  }
  reportHeterogeneity(`  ${mode} blocks`, cells);
}

console.log('\n  Caveat the ledger cannot answer past: order timing is confounded with policy era. The desk was');
console.log('  paused and resumed and repolicied through this history, so which hours carry which policy');
console.log('  version is not random. A ledger block difference is not evidence of a clock effect on its own.');
