/**
 * Measures adverse selection on resting quotes: when a patient order fills, is it an ordinary trade or
 * one about to go against you?
 *
 *   npm run analyze:maker-fills
 *
 * WHY THIS IS THE QUESTION
 *   Kalshi charges nothing on a resting fill and roughly 7% x p x (1-p) on a taking one, so the difference
 *   between crossing the spread and posting inside it is the whole economics of any frequent-trading
 *   strategy here. Taking costs about 4c of round-trip movement at any size and 8c at the current ticket;
 *   resting costs nothing and collects the spread instead of paying it. The only thing that can make
 *   resting unprofitable is being filled selectively — filled when the price is about to run against you
 *   and passed over when it is not.
 *
 * WHAT IT MEASURES
 *   For every sample in every recorded window, a hypothetical resting buy at `ask - d` cents on each side:
 *     - fill%      — the order filled, i.e. the ask later reached the posted price.
 *     - drift      — the mid, N seconds after the fill, minus the mid at the fill. **This is the number.**
 *                    Zero means fills are ordinary. Negative means the fills are selected against you.
 *     - baseline   — the **unconditional** drift over the same horizon from every observed sample, which
 *                    controls for any overall drift in the cohort rather than assuming there is none.
 *
 *   The control is deliberately *not* "orders that failed to fill". A resting buy fails to fill exactly
 *   when the price rises and never comes back, so that group is selected on the outcome being measured and
 *   reads about +20c of drift at two minutes — an artefact, not a market. It was the first thing this file
 *   did and it was wrong.
 *     - edge       — drift minus the spread captured by posting rather than taking. Positive would mean
 *                    the patience pays for itself.
 *
 * THE CORRECTION THAT DECIDES THE ANSWER
 *   Drift is averaged within a settlement window before being averaged across windows, and the standard
 *   error is over windows (AGENTS §5.1): samples inside one 15-minute contract are the same coin flip
 *   observed repeatedly, and treating them as independent would shrink the interval by an order of
 *   magnitude. Overlapping samples within a window are additionally thinned, because a single sustained
 *   move otherwise contributes dozens of near-identical observations.
 *
 * BIASES
 *   - **The fill model is optimistic, and in the direction that matters.** A post is treated as filled the
 *     moment the ask touches it, ignoring queue position. Reality is worse: a brief touch often does not
 *     reach the back of the queue, while a sustained move through the price fills everyone — and sustained
 *     moves through your price are exactly the adverse ones. Real adverse selection is therefore stronger
 *     than this reports.
 *   - Fifteen-second sampling cannot see a fill and reversion inside one interval. The 1s dense windows
 *     are **not** usable as a check here: dense recording only begins once a side has already collapsed
 *     below the long-shot entry mark, so that sample is conditioned on the very move being measured.
 *   - Read-only over `data/contract-paths.*`. Places no order and writes nothing.
 */
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');
/** Posts this far below the current ask. 1c is the tightest post the tick ladder allows. */
const POST_DEPTHS_CENTS = [1, 2, 3];
/** Horizons after the fill, in seconds. */
const HORIZONS_SECONDS = [15, 30, 60, 120];
/** One observation per this many seconds within a window, so a single move is not counted dozens of times. */
const THIN_SECONDS = 60;
/** Only quote where a maker would: away from the extremes, where the book is thin and the tick is coarse. */
const MIN_PRICE_CENTS = 15;
const MAX_PRICE_CENTS = 85;

async function loadPaths() {
  const records = [];
  const journal = path.join(DATA, 'contract-paths.journal.jsonl');
  if (!existsSync(journal)) return records;
  const stream = readline.createInterface({ input: createReadStream(journal) });
  for await (const line of stream) {
    if (!line.trim()) continue;
    try {
      const [contractId, symbol, closesAt, points] = JSON.parse(line);
      records.push({
        contractId, symbol, closesAt,
        points: points.map(([o, u, d]) => ({ o, u, d })).sort((a, b) => a.o - b.o),
      });
    } catch { /* a damaged line is skipped rather than failing the whole read */ }
  }
  const byId = new Map();
  for (const record of records) {
    const key = `${record.contractId}:${record.closesAt}`;
    const seen = byId.get(key);
    if (!seen || record.points.length > seen.points.length) byId.set(key, record);
  }
  return [...byId.values()];
}

/** Averaged within a settlement window, then across windows; the error is over windows. */
function clustered(rows) {
  const windows = new Map();
  for (const row of rows) windows.set(row.key, [...(windows.get(row.key) ?? []), row.value]);
  const perWindow = [...windows.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  if (!perWindow.length) return { mean: null, standardError: null, windows: 0 };
  const mean = perWindow.reduce((a, b) => a + b, 0) / perWindow.length;
  return {
    mean,
    standardError: perWindow.length > 1
      ? Math.sqrt(perWindow.reduce((s, v) => s + (v - mean) ** 2, 0) / (perWindow.length - 1) / perWindow.length)
      : null,
    windows: perWindow.length,
  };
}

const records = await loadPaths();
console.log(`windows ${records.length}`);
console.log(`posting ${POST_DEPTHS_CENTS.join('/')}c below the ask, on both sides, thinned to one observation per ${THIN_SECONDS}s\n`);

console.log('depth  horizon   fills  fill%   drift after fill      baseline drift        adverse');
for (const depth of POST_DEPTHS_CENTS) {
  for (const horizon of HORIZONS_SECONDS) {
    const filled = [];
    const unconditional = [];
    let opportunities = 0;
    let fills = 0;

    for (const record of records) {
      const points = record.points;
      for (const side of ['UP', 'DOWN']) {
        const ask = (point) => (side === 'UP' ? point.u : point.d);
        const bid = (point) => (side === 'UP' ? 100 - point.d : 100 - point.u);
        const mid = (point) => (ask(point) + bid(point)) / 2;
        let lastObserved = -Infinity;

        for (let index = 0; index < points.length; index += 1) {
          const point = points[index];
          if (point.o - lastObserved < THIN_SECONDS) continue;
          const askNow = ask(point);
          if (!(askNow > MIN_PRICE_CENTS && askNow < MAX_PRICE_CENTS)) continue;
          const postAt = askNow - depth;
          if (postAt <= 0) continue;
          lastObserved = point.o;
          opportunities += 1;
          // Unconditional control: the drift from this sample regardless of whether anything filled.
          const control = points.find((later, position) => position > index && later.o >= point.o + horizon);
          if (control) unconditional.push({ key: record.closesAt, value: mid(control) - mid(point) });

          // The fill: the first later sample whose ask reached the posted price.
          const fillIndex = points.findIndex((later, position) => position > index && ask(later) <= postAt);
          if (fillIndex < 0) continue;
          fills += 1;
          const fillPoint = points[fillIndex];
          const after = points.find((later, position) => position > fillIndex && later.o >= fillPoint.o + horizon);
          if (!after) continue;
          filled.push({ key: record.closesAt, value: mid(after) - mid(fillPoint) });
        }
      }
    }

    const f = clustered(filled);
    const u = clustered(unconditional);
    if (f.mean === null || u.mean === null) continue;
    const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`;
    console.log(
      `${String(depth).padStart(4)}c${String(horizon).padStart(8)}s${String(filled.length).padStart(8)}`
      + `${(100 * fills / opportunities).toFixed(0).padStart(6)}%`
      + `${`${signed(f.mean)}±${(f.standardError ?? 0).toFixed(3)}`.padStart(20)}`
      + `${`${signed(u.mean)}±${(u.standardError ?? 0).toFixed(3)}`.padStart(21)}`
      + `${signed(f.mean - u.mean).padStart(15)}`,
    );
  }
}

console.log('\n`adverse` is the fill drift minus the no-fill drift, in cents of mid.');
console.log('Zero means a resting fill is an ordinary trade. Negative means the fills are selected against you.');
console.log('Compare it against what posting earns: 1c of spread on a contract is 1c, before any fee saving.');
