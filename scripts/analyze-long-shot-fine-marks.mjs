/**
 * How much did fifteen-second sampling hide? Touch rates at 2s against the same windows subsampled to 15s.
 *
 *   npm run analyze:long-shot-fine-marks
 *
 * **What it measures.** Every touch rate in this repo before 2026-08-18 was computed on a path sampled
 * every fifteen seconds, and a touch is a maximum — so those rates are floors, understated by however many
 * spikes fell between samples. The settlement rates they were compared against are exact. That asymmetry
 * biases every comparison *against* an exit mark, which is the opposite of what
 * reports/long-shot-roundtrip-2026-08-18.md originally claimed.
 *
 * **The correction that decides the answer.** The comparison is **within the same windows**: the 2-second
 * path is the truth, and the same path decimated to every fifteenth second is the counterfactual older
 * instrument. No cohort, day, or regime differs between the arms, so the difference is sampling alone.
 *
 * It also sweeps marks on the fine data to ask the buy-low-sell-high question directly: over a window,
 * how far does a cheap side actually travel, and how often is there a tradeable up-move at all?
 *
 * **Biases, worst first.**
 *   - Even 2 seconds is a floor. A one-tick touch inside two seconds is still invisible.
 *   - Fine sampling exists from 2026-08-18 only, so this is one day and cannot speak to regime.
 *   - Entries are the first sample in the band with enough clock, bought at the recorded ask, no fill model.
 *   - Exits are priced optimistically at exactly the mark.
 *   - Read-only. Places no order and writes nothing.
 */
import { readForecastHistory } from './lib/forecast-history.mjs';
import { createReadStream, existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');
const SHARDS = path.join(DATA, 'forecast-history-shards');
const CYCLE_SECONDS = 900;
const FINE_GAP_SECONDS = 4;
const feeCents = (priceCents) => Math.max(0.01, 0.07 * (priceCents / 100) * (1 - priceCents / 100) * 100);

async function loadPaths() {
  const paths = new Map();
  const stream = readline.createInterface({ input: createReadStream(path.join(DATA, 'contract-paths.journal.jsonl')) });
  for await (const line of stream) {
    if (!line.trim()) continue;
    try {
      const [, symbol, closesAt, points] = JSON.parse(line);
      const parsed = points.map(([t, up, down]) => ({ t, upAsk: up, downAsk: down })).sort((a, b) => a.t - b.t);
      const key = `${symbol}|${closesAt}`;
      const prior = paths.get(key);
      if (!prior || parsed.length > prior.length) paths.set(key, parsed);
    } catch { /* damaged line */ }
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

/** Median gap identifies the sampler that produced a window; only fine windows can be decimated. */
const medianGap = (points) => {
  const gaps = [];
  for (let index = 1; index < points.length; index += 1) gaps.push(points[index].t - points[index - 1].t);
  gaps.sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;
};

/** Keep one sample per fifteen-second bucket, which is what the old sampler recorded. */
const decimate = (points) => {
  const kept = [];
  let bucket = -1;
  for (const point of points) {
    const current = Math.floor(point.t / 15);
    if (current !== bucket) { kept.push(point); bucket = current; }
  }
  return kept;
};

const fine = [...PATHS.entries()].filter(([key, points]) => OUTCOMES.has(key) && medianGap(points) <= FINE_GAP_SECONDS);
console.log(`fine (<=${FINE_GAP_SECONDS}s) windows with a settled outcome: ${fine.length}`);
console.log(`mean samples per fine window: ${(fine.reduce((sum, [, p]) => sum + p.length, 0) / Math.max(1, fine.length)).toFixed(0)}\n`);

function entries(points, key, outcome, lowCents, highCents, minSeconds) {
  const rows = [];
  for (const side of ['UP', 'DOWN']) {
    const ask = (point) => (side === 'UP' ? point.upAsk : point.downAsk);
    const bid = (point) => 100 - (side === 'UP' ? point.downAsk : point.upAsk);
    const index = points.findIndex((point) => CYCLE_SECONDS - point.t >= minSeconds && ask(point) > lowCents && ask(point) <= highCents);
    if (index < 0) continue;
    const after = points.slice(index + 1);
    if (!after.length) continue;
    rows.push({ key, side, askCents: ask(points[index]), peakBidCents: Math.max(...after.map(bid)), won: outcome === side });
  }
  return rows;
}

const BANDS = [['0-10c', 0, 10, 600], ['0-10c', 0, 10, 300], ['10-20c', 10, 20, 300], ['20-30c', 20, 30, 300]];
const MARKS = [30, 50, 70, 90];

console.log('=== 1. what fifteen-second sampling hid, measured inside the same windows ===');
console.log(`${'band'.padEnd(8)} ${'left'.padStart(5)} ${'n'.padStart(5)} ${'settle'.padStart(7)}  `
  + MARKS.map((mark) => `${`${mark}c: 15s`.padStart(10)} ${'2s'.padStart(6)} ${'lift'.padStart(6)}`).join(' |'));
for (const [label, low, high, minSeconds] of BANDS) {
  const fineRows = [], coarseRows = [];
  for (const [key, points] of fine) {
    const outcome = OUTCOMES.get(key);
    fineRows.push(...entries(points, key, outcome, low, high, minSeconds));
    coarseRows.push(...entries(decimate(points), key, outcome, low, high, minSeconds));
  }
  if (fineRows.length < 10) { console.log(`${label.padEnd(8)} ${String(minSeconds).padStart(5)} ${String(fineRows.length).padStart(5)}  too few`); continue; }
  const settle = 100 * fineRows.filter((row) => row.won).length / fineRows.length;
  const cells = MARKS.map((mark) => {
    const f = 100 * fineRows.filter((row) => row.peakBidCents >= mark).length / fineRows.length;
    const c = 100 * coarseRows.filter((row) => row.peakBidCents >= mark).length / Math.max(1, coarseRows.length);
    return `${c.toFixed(1).padStart(9)}% ${f.toFixed(1).padStart(5)}% ${((f - c) >= 0 ? '+' : '') + (f - c).toFixed(1).padStart(5)}`;
  });
  console.log(`${label.padEnd(8)} ${String(minSeconds).padStart(5)} ${String(fineRows.length).padStart(5)} ${settle.toFixed(1).padStart(6)}%  ` + cells.join(' |'));
}

console.log('\n=== 2. how far a cheap side actually travels, on 2-second data ===');
console.log('Peak owned-side bid after entry, as a multiple of the all-in entry cost. This is the');
console.log('buy-low-sell-high question with no mark assumed: what was reachable at all?');
console.log(`${'band'.padEnd(8)} ${'left'.padStart(5)} ${'n'.padStart(5)} ` + [1.25, 1.5, 2, 3, 5, 10].map((m) => `${`>=${m}x`.padStart(7)}`).join(' ') + '   median peak');
for (const [label, low, high, minSeconds] of BANDS) {
  const rows = [];
  for (const [key, points] of fine) rows.push(...entries(points, key, OUTCOMES.get(key), low, high, minSeconds));
  if (rows.length < 10) continue;
  const multiples = rows.map((row) => row.peakBidCents / (row.askCents + feeCents(row.askCents)));
  const share = (m) => `${(100 * multiples.filter((value) => value >= m).length / multiples.length).toFixed(0)}%`.padStart(7);
  const sorted = [...multiples].sort((a, b) => a - b);
  console.log(`${label.padEnd(8)} ${String(minSeconds).padStart(5)} ${String(rows.length).padStart(5)} `
    + [1.25, 1.5, 2, 3, 5, 10].map(share).join(' ') + `   ${sorted[Math.floor(sorted.length / 2)].toFixed(2)}x`);
}

console.log('\n=== 3. every mark on fine data, against break-even and against holding ===');
console.log(`${'band'.padEnd(8)} ${'left'.padStart(5)} ${'n'.padStart(5)} ${'mark'.padStart(5)} ${'touch'.padStart(7)} ${'b/e'.padStart(7)} ${'ratio'.padStart(6)} ${'sell-at-mark'.padStart(18)} ${'hold'.padStart(16)}`);
for (const [label, low, high, minSeconds] of BANDS) {
  const rows = [];
  for (const [key, points] of fine) rows.push(...entries(points, key, OUTCOMES.get(key), low, high, minSeconds));
  if (rows.length < 10) continue;
  const cost = (row) => row.askCents + feeCents(row.askCents);
  const meanCost = rows.reduce((sum, row) => sum + cost(row), 0) / rows.length;
  const stat = (values) => {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const se = values.length > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1) / values.length) : 0;
    return `${mean >= 0 ? '+' : ''}${(100 * mean).toFixed(1)}% ±${(196 * se).toFixed(1)}`;
  };
  const hold = stat(rows.map((row) => (row.won ? 100 : 0) / cost(row) - 1));
  for (const mark of [20, 25, 30, 40, 50, 70, 90]) {
    const touch = 100 * rows.filter((row) => row.peakBidCents >= mark).length / rows.length;
    const breakEven = 100 * meanCost / mark;
    const sell = stat(rows.map((row) => (row.peakBidCents >= mark ? mark : (row.won ? 100 : 0)) / cost(row) - 1));
    console.log(`${label.padEnd(8)} ${String(minSeconds).padStart(5)} ${String(rows.length).padStart(5)} ${String(mark).padStart(4)}c `
      + `${touch.toFixed(1).padStart(6)}% ${breakEven.toFixed(1).padStart(6)}% ${(touch / breakEven).toFixed(2).padStart(6)} ${sell.padStart(18)} ${hold.padStart(16)}`);
  }
}

// ------------------------------------------------------------------ 4. cohort scoreboard
/**
 * Standing answer to "has any cohort turned positive yet?", so that running this daily is enough.
 *
 * Sampler eras are reported apart and never pooled: a 15-second window understates every touch rate and a
 * 2-second window barely does, so blending them mixes an instrument change into a result. `ratio` is the
 * touch rate over its break-even; above 1.00 the mark pays for itself. `hold` is the same cohort with no
 * exit at all, which is the arm any mark has to beat.
 */
console.log('\n=== 4. cohort scoreboard — run daily; watch for ratio crossing 1.00 with a tightening interval ===');
const coarse = [...PATHS.entries()].filter(([key, points]) => OUTCOMES.has(key) && medianGap(points) > FINE_GAP_SECONDS);
const eras = [['15s sampler', coarse], ['2s sampler', fine]];
console.log(`${'era'.padEnd(12)} ${'band'.padEnd(8)} ${'left'.padStart(5)} ${'n'.padStart(5)} ${'mark'.padStart(5)} ${'touch'.padStart(7)} ${'ratio'.padStart(6)} ${'sell-at-mark'.padStart(18)} ${'hold'.padStart(17)}`);
for (const [eraLabel, windows] of eras) {
  for (const [label, low, high, minSeconds] of BANDS) {
    const rows = [];
    for (const [key, points] of windows) rows.push(...entries(points, key, OUTCOMES.get(key), low, high, minSeconds));
    if (rows.length < 25) continue;
    const cost = (row) => row.askCents + feeCents(row.askCents);
    const meanCost = rows.reduce((sum, row) => sum + cost(row), 0) / rows.length;
    const stat = (values) => {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const se = values.length > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1) / values.length) : 0;
      return `${mean >= 0 ? '+' : ''}${(100 * mean).toFixed(1)}% ±${(196 * se).toFixed(1)}`;
    };
    const hold = stat(rows.map((row) => (row.won ? 100 : 0) / cost(row) - 1));
    // Only the best mark per cohort is listed: this is a watch list, and the full sweep is section 3.
    let best = null;
    for (const mark of [30, 50, 70, 90, 95]) {
      const touch = 100 * rows.filter((row) => row.peakBidCents >= mark).length / rows.length;
      const ratio = touch / (100 * meanCost / mark);
      if (!best || ratio > best.ratio) best = { mark, touch, ratio };
    }
    const sell = stat(rows.map((row) => (row.peakBidCents >= best.mark ? best.mark : (row.won ? 100 : 0)) / cost(row) - 1));
    console.log(`${eraLabel.padEnd(12)} ${label.padEnd(8)} ${String(minSeconds).padStart(5)} ${String(rows.length).padStart(5)} ${String(best.mark).padStart(4)}c `
      + `${best.touch.toFixed(1).padStart(6)}% ${best.ratio.toFixed(2).padStart(6)} ${sell.padStart(18)} ${hold.padStart(17)}`);
  }
}
console.log('\nA cohort is worth a second look when ratio > 1.00 AND its interval excludes zero AND it beats');
console.log('hold. Nothing here is promotable from this script: promotion needs a committed sentinel (AGENTS §5.5).');

// ------------------------------------------------------------------ 5. parameter sweep for a v2 cohort
/**
 * The three settings `longShotPolicyVersion` derives a cohort from: entry mark, exit mark, and minimum
 * seconds remaining. Everything else (caps, sizing) changes which candidates are taken and at what stake,
 * not whether a candidate reaches its mark.
 *
 * **This is a grid search and choosing its best cell is a fit, not a finding** (AGENTS §5.3, §5.5). It is
 * run to pick a configuration worth collecting against, never to claim one works. The saving grace of this
 * policy's design is that the version string is derived from these settings, so any change starts a fresh
 * prospective cohort automatically and the choice is judged by evidence it has not seen.
 */
console.log('\n=== 5. parameter sweep for a v2 cohort — a fit, not a finding; picks what to collect against ===');
const sweep = (windows, eraLabel) => {
  const results = [];
  for (const entryMark of [5, 8, 10, 12, 15]) {
    for (const minSeconds of [300, 600]) {
      const rows = [];
      for (const [key, points] of windows) rows.push(...entries(points, key, OUTCOMES.get(key), 0, entryMark, minSeconds));
      if (rows.length < 20) continue;
      const cost = (row) => row.askCents + feeCents(row.askCents);
      const meanCost = rows.reduce((sum, row) => sum + cost(row), 0) / rows.length;
      const stat = (values) => {
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const se = values.length > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1) / values.length) : 0;
        return { mean, se };
      };
      const hold = stat(rows.map((row) => (row.won ? 100 : 0) / cost(row) - 1));
      for (const exitMark of [70, 80, 90, 95, 97]) {
        const touch = 100 * rows.filter((row) => row.peakBidCents >= exitMark).length / rows.length;
        const sell = stat(rows.map((row) => (row.peakBidCents >= exitMark ? exitMark : (row.won ? 100 : 0)) / cost(row) - 1));
        results.push({ entryMark, exitMark, minSeconds, n: rows.length, touch, ratio: touch / (100 * meanCost / exitMark), sell, hold });
      }
    }
  }
  results.sort((a, b) => b.sell.mean - a.sell.mean);
  console.log(`\n-- ${eraLabel}, top 10 by sell-at-mark return --`);
  console.log(`${'buy'.padStart(4)} ${'sell'.padStart(5)} ${'win'.padStart(5)} ${'n'.padStart(5)} ${'touch'.padStart(7)} ${'ratio'.padStart(6)} ${'sell-at-mark'.padStart(18)} ${'hold'.padStart(18)}`);
  for (const row of results.slice(0, 10)) {
    console.log(`${String(row.entryMark).padStart(3)}c ${String(row.exitMark).padStart(4)}c ${String(row.minSeconds).padStart(4)}s ${String(row.n).padStart(5)} `
      + `${row.touch.toFixed(1).padStart(6)}% ${row.ratio.toFixed(2).padStart(6)} `
      + `${`${row.sell.mean >= 0 ? '+' : ''}${(100 * row.sell.mean).toFixed(1)}% ±${(196 * row.sell.se).toFixed(1)}`.padStart(18)} `
      + `${`${row.hold.mean >= 0 ? '+' : ''}${(100 * row.hold.mean).toFixed(1)}% ±${(196 * row.hold.se).toFixed(1)}`.padStart(18)}`);
  }
  const production = results.find((row) => row.entryMark === 10 && row.exitMark === 90 && row.minSeconds === 600);
  if (production) {
    console.log(`production today (10c/90c/600s): rank ${results.indexOf(production) + 1} of ${results.length}, `
      + `sell ${production.sell.mean >= 0 ? '+' : ''}${(100 * production.sell.mean).toFixed(1)}%, ratio ${production.ratio.toFixed(2)}`);
  }
};
sweep(fine, '2s sampler (2026-08-18)');
sweep(coarse, '15s sampler (2026-08-15 to 08-17)');
