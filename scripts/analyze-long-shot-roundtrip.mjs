/**
 * Does the long-shot round trip exist? Touch rate at the exit mark against the settle-in-the-money rate.
 *
 *   npm run analyze:long-shot-roundtrip
 *
 * **What it measures.** Buying a cheap side and selling it at a mark is only worth more than holding it if
 * the price reaches that mark on paths that would *not* have settled in the money. This measures that
 * directly: for one entry band, the fraction of entries whose owned-side bid ever reaches the mark, the
 * fraction that settle in the money, and the gap between them.
 *
 * **The correction that decides the answer.** Every previous long-shot screen scored candidates on whether
 * they *win* (reports/long-shot-filter-screen-2026-08-17.md screened thirty entry filters that way, and
 * found nothing usable). That is the wrong target for a round trip. A mark exit adds value only through
 * paths that spike and then retrace — `spike and lose` below. Where that count is near zero the exit is
 * selling winners at a discount and the entry filter cannot be the problem, because no entry rule can make
 * an exit that subtracts value on every trade add value instead.
 *
 * `break-even` is the touch rate the configuration needs: mean all-in entry cost divided by the mark.
 * `gap` is touch minus settle, in points; negative means the mark reaches fewer contracts than simply
 * holding would have won.
 *
 * **Biases, worst first.**
 *   - **Touch rates are floors, and this biases *against* the mark exit.** A path sampled every fifteen
 *     seconds cannot see a spike between samples, so every touch rate here is understated while the
 *     settlement rate it is compared against is exact. From 2026-08-18 the sampler runs every two seconds;
 *     `analyze:long-shot-fine-marks` measures the size of the undercount within the same windows. Any
 *     conclusion drawn against the mark from fifteen-second data is drawn on data that penalizes it.
 *   - Entries are the first sample in the band with enough clock, one per contract and side, bought at the
 *     recorded ask. No fill model: the long-shot path rests a maker order like everything else.
 *   - Settlement is authoritative, joined per window from the resolved forecast history. Windows without a
 *     resolved outcome are dropped, which drops the most recent windows first.
 *   - Exits are priced optimistically at exactly the mark, and a bid gapping through fills worse.
 *   - Read-only. Places no order and writes nothing.
 */
import { readForecastHistory } from './lib/forecast-history.mjs';
import { createReadStream, existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const SHARDS = path.join(DATA, 'forecast-history-shards');
const CYCLE_SECONDS = 900;
/** Kalshi taker rate in cents per contract, with the 1c floor the production sizing model applies. */
const feeCents = (priceCents) => Math.max(0.01, 0.07 * (priceCents / 100) * (1 - priceCents / 100) * 100);

async function loadPaths() {
  const paths = new Map();
  const journal = path.join(DATA, 'contract-paths.journal.jsonl');
  if (!existsSync(journal)) return paths;
  const stream = readline.createInterface({ input: createReadStream(journal) });
  for await (const line of stream) {
    if (!line.trim()) continue;
    try {
      const [, symbol, closesAt, points] = JSON.parse(line);
      const parsed = points.map(([t, up, down]) => ({ t, upAsk: up, downAsk: down })).sort((a, b) => a.t - b.t);
      const key = `${symbol}|${closesAt}`;
      const prior = paths.get(key);
      if (!prior || parsed.length > prior.length) paths.set(key, parsed);
    } catch { /* a damaged line is skipped rather than failing the whole read */ }
  }
  return paths;
}

async function loadOutcomes() {
  const outcomes = new Map();
  // Shards + open shard + journal patches. `open.json` is rewritten only on compaction, so reading it
  // alone drops every window settled since the last one — hours of them on a running collector.
  for (const row of await readForecastHistory(DATA)) {
    if (row.status === 'resolved' && row.outcome) outcomes.set(`${row.symbol}|${row.closesAt}`, row.outcome);
  }
  return outcomes;
}

const PATHS = await loadPaths();
const OUTCOMES = await loadOutcomes();

/** One entry per contract and side: the first sample inside the band with at least `minSeconds` left. */
function entriesFor(lowCents, highCents, minSeconds) {
  const rows = [];
  for (const [key, points] of PATHS) {
    const outcome = OUTCOMES.get(key);
    if (!outcome) continue;
    for (const side of ['UP', 'DOWN']) {
      const ask = (point) => (side === 'UP' ? point.upAsk : point.downAsk);
      const bid = (point) => 100 - (side === 'UP' ? point.downAsk : point.upAsk);
      const index = points.findIndex((point) => CYCLE_SECONDS - point.t >= minSeconds
        && ask(point) > lowCents && ask(point) <= highCents);
      if (index < 0) continue;
      const after = points.slice(index + 1);
      if (!after.length) continue;
      rows.push({
        key, side, day: key.split('|')[1].slice(0, 10),
        askCents: ask(points[index]),
        peakBidCents: Math.max(...after.map(bid)),
        won: outcome === side,
      });
    }
  }
  return rows;
}

const MARKS = [30, 50, 70, 90];
const BANDS = [
  ['0-10c', 0, 10, 600], ['0-10c', 0, 10, 300],
  ['10-15c', 10, 15, 300], ['15-20c', 15, 20, 300], ['20-30c', 20, 30, 300], ['0-30c', 0, 30, 300],
];

console.log(`recorded paths ${PATHS.size}, resolved windows ${OUTCOMES.size}\n`);
console.log('=== the round trip: does the mark reach contracts that holding would have missed? ===');
console.log(`${'band'.padEnd(8)} ${'left'.padStart(5)} ${'n'.padStart(6)} ${'settle'.padStart(7)}  `
  + MARKS.map((mark) => `${`touch${mark}`.padStart(7)} ${'gap'.padStart(7)} ${'b/e'.padStart(6)}`).join(' | ')
  + ' | spike+lose at 90c');
for (const [label, low, high, minSeconds] of BANDS) {
  const rows = entriesFor(low, high, minSeconds);
  if (rows.length < 10) { console.log(`${label.padEnd(8)} ${String(minSeconds).padStart(5)} ${String(rows.length).padStart(6)}  too few`); continue; }
  const meanCost = rows.reduce((sum, row) => sum + row.askCents + feeCents(row.askCents), 0) / rows.length;
  const settle = 100 * rows.filter((row) => row.won).length / rows.length;
  const cells = MARKS.map((mark) => {
    const touch = 100 * rows.filter((row) => row.peakBidCents >= mark).length / rows.length;
    const gap = touch - settle;
    return `${touch.toFixed(1).padStart(6)}% ${((gap >= 0 ? '+' : '') + gap.toFixed(1)).padStart(6)} ${(100 * meanCost / mark).toFixed(1).padStart(5)}%`;
  });
  const spikeLose = rows.filter((row) => row.peakBidCents >= 90 && !row.won).length;
  console.log(`${label.padEnd(8)} ${String(minSeconds).padStart(5)} ${String(rows.length).padStart(6)} ${settle.toFixed(1).padStart(6)}%  `
    + cells.join(' | ') + ` | ${String(spikeLose).padStart(4)} of ${rows.length}`);
}

console.log('\n=== what holding alone returns, by band ===');
console.log('No exit at all: buy at the ask, settle. This is the arm every mark above is competing with.');
console.log(`${'band'.padEnd(8)} ${'left'.padStart(5)} ${'n'.padStart(6)} ${'cost'.padStart(6)} ${'settle'.padStart(7)} ${'return/$1'.padStart(10)}`);
for (const [label, low, high, minSeconds] of BANDS) {
  const rows = entriesFor(low, high, minSeconds);
  if (rows.length < 10) continue;
  const meanCost = rows.reduce((sum, row) => sum + row.askCents + feeCents(row.askCents), 0) / rows.length;
  const settle = rows.filter((row) => row.won).length / rows.length;
  // Clustered on the settlement window: one contract-side per window here, so the cluster is the row.
  const perRow = rows.map((row) => (row.won ? 100 : 0) / (row.askCents + feeCents(row.askCents)) - 1);
  const mean = perRow.reduce((a, b) => a + b, 0) / perRow.length;
  const se = Math.sqrt(perRow.reduce((s, v) => s + (v - mean) ** 2, 0) / (perRow.length - 1) / perRow.length);
  console.log(`${label.padEnd(8)} ${String(minSeconds).padStart(5)} ${String(rows.length).padStart(6)} ${meanCost.toFixed(1).padStart(5)}c `
    + `${(100 * settle).toFixed(1).padStart(6)}% ${`${mean >= 0 ? '+' : ''}${(100 * mean).toFixed(1)}% ±${(196 * se).toFixed(1)}`.padStart(16)}`);
}

console.log('\n=== the realized ledger, for comparison ===');
{
  const ledger = await readExecutionLedger(DATA);
  const orders = (Array.isArray(ledger) ? ledger : Object.values(ledger).find(Array.isArray)) ?? [];
  const entries = orders.filter((order) => order.strategyId === 'long-shot-round-trip' && !order.id.includes(':exit:'));
  for (const mode of ['paper', 'live']) {
    const group = entries.filter((order) => order.executionMode === mode);
    if (!group.length) continue;
    const cost = group.reduce((sum, order) => sum + (order.actualStakeCents ?? order.stakeCents ?? 0), 0);
    const pnl = group.reduce((sum, order) => sum + (Number(order.pnlCents) || 0), 0);
    const count = (status) => group.filter((order) => order.status === status).length;
    console.log(`${mode.padEnd(6)} n=${String(group.length).padStart(3)} cost=${cost.toFixed(0)}c pnl=${pnl.toFixed(0)}c `
      + `(${(100 * pnl / cost).toFixed(1)}%)  won=${count('won')} lost=${count('lost')} sold=${count('sold')}`);
  }
  console.log('Three of the `sold` rows are strict-value exits from before `observeAndExecuteStandaloneExits`');
  console.log('was scoped to EDGE_BINARY_BUY, not round trips. STATUS.md records them; do not read them as');
  console.log('the mark working.');
}
