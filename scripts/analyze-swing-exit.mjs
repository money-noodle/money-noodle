/**
 * Tests the "buy low, sell into the swing" premise three ways, on recorded contract paths.
 *
 *   npm run analyze:swing-exit
 *
 * WHAT IT MEASURES
 *   1. TRAJECTORY AS A SIGNAL — forward 60-second move in the mid, bucketed by quintile of each candidate
 *      trajectory feature (slope over several horizons, acceleration, distance from 50c, range, and
 *      slope/range trend efficiency). A real signal shows a monotone trend across the row.
 *   2. TRADING THAT SIGNAL — the same signal executed: buy the side the reversion favours at the ask, sell
 *      at the bid after a fixed hold, real fees on both legs. `gross move` is reported beside the net
 *      return because the gap between them is the whole lesson.
 *   3. SWING WITH A STOP — buy, then walk the path and exit at whichever comes first, a `+target` on the
 *      owned-side bid or a `-stop`. Path order is respected, which a peak/trough summary cannot do.
 *
 * THE CORRECTION THAT DECIDES THE ANSWER
 *   **A signal measured in mid prices is not tradeable.** Nobody transacts at the mid: you pay the ask and
 *   receive the bid. Measurement 1 finds clean monotone mean reversion — and measurement 2, the same
 *   signal with the spread paid, produces a *negative* gross move. That is bid-ask bounce, and it is why
 *   this file always reports the traded version beside the observed one rather than either alone.
 *
 *   Returns are averaged within a settlement window before being averaged across windows, with the error
 *   over windows (AGENTS §5.1). Contracts sharing a close are one coin flip observed repeatedly.
 *
 * BIASES
 *   - **Observations overlap** in measurement 1: the stride is shorter than the forward horizon, so
 *     neighbouring rows share outcome. Window clustering absorbs some of this and not all; the quintile
 *     errors are optimistic and the monotonicity of a whole row is better evidence than any single cell.
 *   - **Exits are priced optimistically.** A target or stop is assumed to fill exactly at its price; a
 *     bid gapping through fills worse, and fifteen-second sampling cannot see a touch between samples.
 *     Both flatter the exit rules.
 *   - One entry per contract and side, the first qualifying sample. This is not a test of trading
 *     repeatedly within a cycle.
 *   - Settlement is authoritative, joined per window to the resolved forecast history.
 *   - Read-only. Places no order and writes nothing.
 */
import { readFile, readdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');
const TICKET_CENTS = 500;
const ENTRY_LOW_CENTS = 20;
const ENTRY_HIGH_CENTS = 80;
const MINIMUM_SECONDS_REMAINING = 600;
const CYCLE_SECONDS = 900;

async function loadPaths() {
  const records = [];
  const journal = path.join(DATA, 'contract-paths.journal.jsonl');
  if (!existsSync(journal)) return records;
  const stream = readline.createInterface({ input: createReadStream(journal) });
  for await (const line of stream) {
    if (!line.trim()) continue;
    try {
      const [contractId, symbol, closesAt, points] = JSON.parse(line);
      records.push({ contractId, symbol, closesAt, points: points.map(([o, u, d]) => ({ o, u, d })).sort((a, b) => a.o - b.o) });
    } catch { /* damaged line skipped */ }
  }
  const byId = new Map();
  for (const record of records) {
    const key = `${record.contractId}:${record.closesAt}`;
    const seen = byId.get(key);
    if (!seen || record.points.length > seen.points.length) byId.set(key, record);
  }
  return [...byId.values()];
}

/** Per-window join, which the rollups cannot answer: they carry `correct` counts, not the settled side. */
async function loadOutcomes() {
  const outcomes = new Map();
  const absorb = (entries) => {
    for (const entry of entries) {
      if (entry?.outcome && entry.symbol && entry.closesAt) outcomes.set(`${entry.symbol}|${entry.closesAt}`, entry.outcome);
    }
  };
  const shards = path.join(DATA, 'forecast-history-shards');
  if (existsSync(shards)) {
    for (const file of (await readdir(shards)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))) {
      absorb(JSON.parse(await readFile(path.join(shards, file), 'utf8')));
    }
  }
  const open = path.join(DATA, 'forecast-history.json');
  if (existsSync(open)) absorb(JSON.parse(await readFile(open, 'utf8')));
  return outcomes;
}

const feeCents = (priceCents, quantity) =>
  Math.max(1, Math.ceil(100 * quantity * 0.07 * (priceCents / 100) * (1 - priceCents / 100) - 1e-9));

function fill(stakeLimitCents, askCents) {
  if (!(askCents > 0) || askCents > 99) return null;
  const maximumUnits = Math.floor((stakeLimitCents / askCents + 1e-9) / 0.01);
  for (let units = maximumUnits; units > 0; units -= 1) {
    const quantity = Number((units * 0.01).toFixed(2));
    const stake = Math.ceil(quantity * askCents - 1e-9) + feeCents(askCents, quantity);
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
      ? Math.sqrt(perWindow.reduce((s, v) => s + (v - mean) ** 2, 0) / (perWindow.length - 1) / perWindow.length) : 0,
    windows: perWindow.length,
  };
}

const records = await loadPaths();
const OUTCOMES = await loadOutcomes();
const mid = (point) => (point.u + (100 - point.d)) / 2;
const signed = (value, digits = 3) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`;
console.log(`windows ${records.length}\n`);

// ------------------------------------------------------------- 1. trajectory as a signal
console.log('=== 1. TRAJECTORY AS A SIGNAL ===');
console.log('Forward 60s move of the MID, by quintile of each feature. Monotone across a row = a signal.');
console.log('feature                          n   Q1(low)         Q2              Q3              Q4              Q5(high)');
const FEATURES = [
  ['slope over 60s', (m, i) => m[i] - m[i - 4], 5],
  ['slope over 120s', (m, i) => m[i] - m[i - 8], 9],
  ['acceleration', (m, i) => (m[i] - m[i - 4]) - (m[i - 4] - m[i - 8]), 9],
  ['|distance| from 50c', (m, i) => Math.abs(m[i] - 50), 2],
  ['range over 120s', (m, i) => Math.max(...m.slice(i - 8, i + 1)) - Math.min(...m.slice(i - 8, i + 1)), 9],
  ['slope / range (efficiency)', (m, i) => {
    const range = Math.max(...m.slice(i - 8, i + 1)) - Math.min(...m.slice(i - 8, i + 1));
    return range > 0 ? (m[i] - m[i - 8]) / range : null;
  }, 9],
];
for (const [name, feature, lookback] of FEATURES) {
  const rows = [];
  for (const record of records) {
    const m = record.points.map(mid);
    for (let index = lookback; index < m.length; index += 1) {
      const forward = record.points.findIndex((p, j) => j > index && p.o >= record.points[index].o + 60);
      if (forward < 0) continue;
      const value = feature(m, index);
      if (value === null || !Number.isFinite(value)) continue;
      rows.push({ key: record.closesAt, feature: value, forward: m[forward] - m[index] });
      index += 3;
    }
  }
  if (rows.length < 500) continue;
  rows.sort((a, b) => a.feature - b.feature);
  const cells = [];
  for (let bucket = 0; bucket < 5; bucket += 1) {
    const slice = rows.slice(Math.floor(bucket * rows.length / 5), Math.floor((bucket + 1) * rows.length / 5));
    const stats = clustered(slice.map((r) => ({ key: r.key, value: r.forward })));
    cells.push(`${signed(stats.mean)}±${stats.standardError.toFixed(3)}`);
  }
  console.log(name.padEnd(28) + String(rows.length).padStart(7) + '  ' + cells.map((c) => c.padEnd(14)).join('  '));
}

// ------------------------------------------------------------- 2. trading that signal
console.log('\n=== 2. THE SAME SIGNAL, TRADED ===');
console.log('Reversion bet: buy the opposite side at the ask, sell at the bid after the hold. Real fees.');
console.log('`gross move` is the raw ask-to-bid travel. Negative gross means the mid signal was the spread.');
console.log('threshold  hold   trades  windows   gross move    net return/$1');
for (const threshold of [0.5, 0.7, 0.9]) {
  for (const holdSeconds of [60, 300]) {
    const rows = [];
    let grossSum = 0;
    for (const record of records) {
      const m = record.points.map(mid);
      for (let index = 9; index < record.points.length; index += 1) {
        const window = m.slice(index - 8, index + 1);
        const range = Math.max(...window) - Math.min(...window);
        if (!(range > 0)) continue;
        const efficiency = (m[index] - m[index - 8]) / range;
        if (Math.abs(efficiency) < threshold) continue;
        // Efficient rise in the UP mid means bet on the pullback, which is buying DOWN.
        const side = efficiency > 0 ? 'DOWN' : 'UP';
        const askCents = side === 'UP' ? record.points[index].u : record.points[index].d;
        const sized = fill(TICKET_CENTS, askCents);
        if (!sized) continue;
        const exit = record.points.find((p, j) => j > index && p.o >= record.points[index].o + holdSeconds);
        if (!exit) continue;
        const bidCents = side === 'UP' ? 100 - exit.d : 100 - exit.u;
        const proceeds = sized.quantity * bidCents - feeCents(bidCents, sized.quantity);
        grossSum += bidCents - askCents;
        rows.push({ key: record.closesAt, value: (proceeds - sized.stakeCents) / sized.stakeCents });
        index += Math.ceil(holdSeconds / 15);
      }
    }
    if (rows.length < 200) continue;
    const stats = clustered(rows);
    console.log(String(threshold).padStart(8) + String(holdSeconds).padStart(6) + 's'
      + String(rows.length).padStart(8) + String(stats.windows).padStart(9)
      + `${signed(grossSum / rows.length, 2)}c`.padStart(13)
      + `${signed(stats.mean, 4)} ±${stats.standardError.toFixed(4)}`.padStart(21));
  }
}

// ------------------------------------------------------------- 3. swing with a stop
console.log('\n=== 3. THE SWING, WITH AND WITHOUT A STOP ===');
console.log(`Buy the first ask in ${ENTRY_LOW_CENTS}-${ENTRY_HIGH_CENTS}c with ${MINIMUM_SECONDS_REMAINING}s left; exit at whichever comes FIRST.`);
console.log('The stop fires far more than the target at symmetric distances: you are marked against the bid,');
console.log('so the stop starts about a spread closer than the target does.');
console.log('target  stop   trades  win%  hit target  stopped  settled      return/$1');
for (const target of [3, 5, 8]) {
  for (const stop of [3, 5, 8, null]) {
    const rows = [];
    let hitTarget = 0, stopped = 0, settled = 0;
    for (const record of records) {
      const settledSide = OUTCOMES.get(`${record.symbol}|${record.closesAt}`);
      if (!settledSide) continue;
      for (const side of ['UP', 'DOWN']) {
        const ask = (p) => (side === 'UP' ? p.u : p.d);
        const bid = (p) => (side === 'UP' ? 100 - p.d : 100 - p.u);
        const index = record.points.findIndex((p) =>
          ask(p) > ENTRY_LOW_CENTS && ask(p) <= ENTRY_HIGH_CENTS && CYCLE_SECONDS - p.o >= MINIMUM_SECONDS_REMAINING);
        if (index < 0) continue;
        const askCents = ask(record.points[index]);
        const sized = fill(TICKET_CENTS, askCents);
        if (!sized) continue;
        const targetCents = Math.min(99, Math.round(askCents) + target);
        const stopCents = stop === null ? null : Math.max(1, Math.round(askCents) - stop);
        let exit = null;
        for (const point of record.points.slice(index + 1)) {
          const bidCents = bid(point);
          if (bidCents >= targetCents) { exit = targetCents; hitTarget += 1; break; }
          if (stopCents !== null && bidCents <= stopCents) { exit = stopCents; stopped += 1; break; }
        }
        let value;
        if (exit !== null) {
          value = ((sized.quantity * exit - feeCents(exit, sized.quantity)) - sized.stakeCents) / sized.stakeCents;
        } else {
          settled += 1;
          value = ((settledSide === side ? sized.quantity * 100 : 0) - sized.stakeCents) / sized.stakeCents;
        }
        rows.push({ key: record.closesAt, value, won: settledSide === side });
      }
    }
    if (rows.length < 200) continue;
    const stats = clustered(rows);
    const total = hitTarget + stopped + settled;
    console.log(`+${target}c`.padStart(6) + (stop === null ? '  none' : `  −${stop}c`).padEnd(7)
      + String(rows.length).padStart(7)
      + `${(100 * rows.filter((r) => r.won).length / rows.length).toFixed(0)}%`.padStart(6)
      + `${(100 * hitTarget / total).toFixed(0)}%`.padStart(11) + `${(100 * stopped / total).toFixed(0)}%`.padStart(9)
      + `${(100 * settled / total).toFixed(0)}%`.padStart(9)
      + `${signed(stats.mean, 4)} ±${stats.standardError.toFixed(4)}`.padStart(21));
  }
}
