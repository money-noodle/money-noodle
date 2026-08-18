/**
 * Screens candidate entry filters for the long-shot policy: does any entry-time signal separate winners?
 *
 *   npm run analyze:long-shot-filters
 *
 * WHAT IT MEASURES
 *   For each proposed filter, the cohort it keeps and what that cohort would have returned: candidates
 *   kept, touch rate at the production exit mark, break-even, `ratio` (touch / break-even), `lift` (the
 *   filter's ratio over the unfiltered cohort's), and clustered return per $1 staked with misses graded at
 *   their real settlement.
 *
 * NO LOOKAHEAD
 *   Every feature is computed from information available STRICTLY BEFORE the entry sample — prior path
 *   points, and the most recent forecast issued at or before the entry instant, never after. Nothing reads
 *   the entry sample's successor, the peak, or the settlement. The one exception is marked `*`: a
 *   still-falling test needs the next sample, which makes it a delayed-entry rule that changes the fill
 *   rather than a filter applied at the tick.
 *
 * THE CORRECTION THAT DECIDES THE ANSWER
 *   Three, and they are the whole point of this file:
 *   1. **Power.** Filters are estimated on the widest cohort (entry <= 30c) because 49 production-band
 *      candidates cannot estimate thirty filters, then re-checked at <= 10c. A filter that works only in
 *      the band it was chosen on is a fit, not a finding.
 *   2. **Multiple comparisons.** Thirty filters against one outcome will produce a best cell whatever the
 *      data says (AGENTS §5.3). The readable signal is whether a *group* of related filters moves
 *      together, which is why the volatility and movement filters are run as a group rather than singly.
 *   3. **Clustering.** Returns are averaged within a settlement window before being averaged across
 *      windows, and standard errors are over windows, because contracts sharing a close share one coin
 *      flip (§5.1).
 *   An asset breakdown is tested against the **cohort mean**, not against zero. Against zero every asset
 *   looks significant, because the whole cohort loses money.
 *
 * BIASES
 *   - Settlement is authoritative, joined by symbol+closesAt to the resolved `outcome` in the forecast
 *     history. Sealed shards are read directly: this is a per-window join, which the rollups cannot
 *     answer. Read-only; nothing here writes to `data/`.
 *   - Touch rates are floors at 15-second sampling. This file compares cohorts measured the same way, so
 *     the floor largely cancels in `lift` — but not in the absolute `ratio`, which is understated
 *     throughout. See `npm run analyze:long-shot-gaps` for the measured coverage correction.
 *   - Fee and fill sizing are reproduced from `venueFeeCents` / `estimatePaperFill`.
 *   - `cycleRegime` is an object on a forecast entry; the label is `.regime`. Reading it as a string
 *     silently yields zero rows in every regime bucket, which is what the first pass of this file did.
 */
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');
const TICKET_CENTS = 20;
/** `minimumSecondsRemaining`. */
const WINDOW_SECONDS = 600;
const CYCLE_SECONDS = 900;
/** `maximumOpenPerSettlementWindow`. */
const MAX_OPEN_PER_WINDOW = 3;
/** The production exit mark, held fixed: this file varies the entry filter, not the gap. */
const EXIT = 90;
/** Below this a kept cohort's rate is not worth printing. Not a significance bar. */
const MINIMUM_KEPT = 15;

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
    } catch { /* a damaged line is skipped rather than failing the whole read */ }
  }
  const byId = new Map();
  for (const record of records) {
    const key = `${record.contractId}:${record.closesAt}`;
    const existing = byId.get(key);
    if (!existing || record.points.length > existing.points.length) byId.set(key, record);
  }
  return [...byId.values()];
}

/** Per window: the settled outcome, and every forecast with its issue time, for point-in-time lookup. */
async function loadForecasts() {
  const byWindow = new Map();
  const absorb = (entries) => {
    for (const entry of entries) {
      if (!entry?.symbol || !entry.closesAt) continue;
      const key = `${entry.symbol}|${entry.closesAt}`;
      const bucket = byWindow.get(key) ?? { outcome: null, samples: [] };
      if (entry.outcome) bucket.outcome = entry.outcome;
      const atMs = Date.parse(entry.issuedAt);
      if (Number.isFinite(atMs)) {
        bucket.samples.push({
          atMs,
          volatilityRatio: entry.volatilityRatio ?? null,
          regime: entry.cycleRegime?.regime ?? null,
          trendEfficiency: entry.cycleRegime?.trendEfficiency ?? null,
          signFlipRate: entry.cycleRegime?.signFlipRate ?? null,
          localVolatility15mPercent: entry.cycleRegime?.localVolatility15mPercent ?? null,
          probabilityUp: entry.blendedProbabilityUp ?? entry.probabilityUp ?? null,
        });
      }
      byWindow.set(key, bucket);
    }
  };
  const shards = path.join(DATA, 'forecast-history-shards');
  if (existsSync(shards)) {
    for (const file of (await readdir(shards)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))) {
      const parsed = JSON.parse(await readFile(path.join(shards, file), 'utf8'));
      absorb(Array.isArray(parsed) ? parsed : parsed.entries ?? []);
    }
  }
  const open = path.join(DATA, 'forecast-history.json');
  if (existsSync(open)) {
    const parsed = JSON.parse(await readFile(open, 'utf8'));
    absorb(Array.isArray(parsed) ? parsed : parsed.entries ?? []);
  }
  for (const bucket of byWindow.values()) bucket.samples.sort((left, right) => left.atMs - right.atMs);
  return byWindow;
}

const feeCents = (priceCents, quantity) =>
  Math.max(1, Math.ceil(100 * quantity * 0.07 * (priceCents / 100) * (1 - priceCents / 100) - 1e-9));

function fill(stakeLimitCents, askCents) {
  if (!(askCents > 0) || askCents > 99) return null;
  const maximumUnits = Math.floor((stakeLimitCents / askCents + 1e-9) / 0.01);
  for (let units = maximumUnits; units > 0; units -= 1) {
    const quantity = Number((units * 0.01).toFixed(2));
    const stake = Math.ceil(quantity * askCents - 1e-9) + feeCents(askCents, quantity);
    if (stake <= stakeLimitCents) return { quantity, stake };
  }
  return null;
}

const records = await loadPaths();
const FORECASTS = await loadForecasts();

/** The latest forecast issued at or before an instant. Never after, so no feature can see its own future. */
function forecastAt(symbol, closesAt, atMs) {
  const bucket = FORECASTS.get(`${symbol}|${closesAt}`);
  if (!bucket) return null;
  let found = null;
  for (const sample of bucket.samples) {
    if (sample.atMs > atMs) break;
    found = sample;
  }
  return found;
}

function cohort(maxAskCents) {
  const all = [];
  for (const record of records) {
    const outcome = FORECASTS.get(`${record.symbol}|${record.closesAt}`)?.outcome ?? null;
    const openMs = Date.parse(record.closesAt) - CYCLE_SECONDS * 1000;
    for (const side of ['UP', 'DOWN']) {
      const ask = (point) => (side === 'UP' ? point.u : point.d);
      const bid = (point) => (side === 'UP' ? 100 - point.d : 100 - point.u);
      const index = record.points.findIndex((point) =>
        ask(point) > 0 && ask(point) <= maxAskCents && CYCLE_SECONDS - point.o >= WINDOW_SECONDS);
      if (index < 0) continue;
      const entry = record.points[index];
      const before = record.points.slice(0, index);
      let peak = null;
      for (const point of record.points.slice(index + 1)) {
        const value = bid(point);
        if (peak === null || value > peak) peak = value;
      }
      if (peak === null) continue;
      const priorAsks = before.map(ask);
      const previous = priorAsks.length ? priorAsks[priorAsks.length - 1] : null;
      const priorHigh = priorAsks.length ? Math.max(...priorAsks) : null;
      const forecast = forecastAt(record.symbol, record.closesAt, openMs + entry.o * 1000);
      const next = record.points[index + 1];
      all.push({
        symbol: record.symbol, closesAt: record.closesAt, side,
        entryAskCents: ask(entry), peakBidCents: peak, entryOffset: entry.o,
        won: outcome === null ? null : outcome === side,
        spreadCents: entry.u + entry.d - 100,
        secondsRemaining: CYCLE_SECONDS - entry.o,
        fallFromPrior: previous === null ? null : previous - ask(entry),
        fallFromHigh: priorHigh === null ? null : priorHigh - ask(entry),
        samplesBefore: before.length,
        volatilityRatio: forecast?.volatilityRatio ?? null,
        regime: forecast?.regime ?? null,
        trendEfficiency: forecast?.trendEfficiency ?? null,
        signFlipRate: forecast?.signFlipRate ?? null,
        localVolatility15mPercent: forecast?.localVolatility15mPercent ?? null,
        // The model's own view of this side at entry. The long-shot rule ignores it by design (§2); this
        // asks only whether it would have been useful as a veto.
        modelSideProbability: forecast?.probabilityUp == null ? null
          : (side === 'UP' ? forecast.probabilityUp : 1 - forecast.probabilityUp),
        stillFalling: next ? ask(next) < ask(entry) - 0.05 : null,
      });
    }
  }
  all.sort((left, right) => left.entryOffset - right.entryOffset);
  const perAsset = new Set(); const perWindow = new Map(); const capped = [];
  for (const candidate of all) {
    const key = `${candidate.symbol}:${candidate.closesAt}`;
    if (perAsset.has(key)) continue;
    const open = perWindow.get(candidate.closesAt) ?? 0;
    if (open >= MAX_OPEN_PER_WINDOW) continue;
    perAsset.add(key); perWindow.set(candidate.closesAt, open + 1); capped.push(candidate);
  }
  return capped;
}

function clustered(rows) {
  const windows = new Map();
  for (const row of rows) windows.set(row.closesAt, [...(windows.get(row.closesAt) ?? []), row.value]);
  const perWindow = [...windows.values()].map((values) => values.reduce((a, b) => a + b, 0) / values.length);
  if (!perWindow.length) return { mean: null, standardError: null, windows: 0 };
  const mean = perWindow.reduce((a, b) => a + b, 0) / perWindow.length;
  return {
    mean,
    standardError: perWindow.length > 1
      ? Math.sqrt(perWindow.reduce((s, v) => s + (v - mean) ** 2, 0) / (perWindow.length - 1) / perWindow.length) : null,
    windows: perWindow.length,
  };
}

function evaluate(rows) {
  let touched = 0, used = 0, breakEvenSum = 0;
  const returns = [];
  for (const candidate of rows) {
    const sized = fill(TICKET_CENTS, candidate.entryAskCents);
    if (!sized) continue;
    used += 1;
    const proceeds = sized.quantity * EXIT - feeCents(EXIT, sized.quantity);
    breakEvenSum += sized.stake / proceeds;
    const touch = candidate.peakBidCents >= EXIT;
    if (touch) touched += 1;
    if (touch) returns.push({ closesAt: candidate.closesAt, value: (proceeds - sized.stake) / sized.stake });
    else if (candidate.won !== null) returns.push({ closesAt: candidate.closesAt, value: ((candidate.won ? sized.quantity * 100 : 0) - sized.stake) / sized.stake });
  }
  if (!used) return null;
  const touchRate = touched / used;
  const breakEven = breakEvenSum / used;
  return { n: used, touchRate, breakEven, ratio: touchRate / breakEven, ...clustered(returns) };
}

/**
 * Grouped deliberately. A single filter clearing a bar among thirty is noise; a *group* of filters that
 * express the same idea moving together is the thing worth reading (§5.3).
 */
const GROUPS = [
  ['baseline', [['(unfiltered)', () => true]]],
  ['book quality', [
    ['spread <= 2c', (c) => c.spreadCents <= 2 + 1e-9],
    ['spread <= 4c', (c) => c.spreadCents <= 4 + 1e-9],
    ['spread > 4c', (c) => c.spreadCents > 4 + 1e-9],
  ]],
  ['clock', [
    ['>=12 min left', (c) => c.secondsRemaining >= 720],
    ['<12 min left', (c) => c.secondsRemaining < 720],
  ]],
  ['how it got cheap', [
    ['fell <2c from prior', (c) => c.fallFromPrior !== null && c.fallFromPrior < 2],
    ['fell >=2c from prior', (c) => c.fallFromPrior !== null && c.fallFromPrior >= 2],
    ['fell <10c from high', (c) => c.fallFromHigh !== null && c.fallFromHigh < 10],
    ['fell >=10c from high', (c) => c.fallFromHigh !== null && c.fallFromHigh >= 10],
    ['fell >=20c from high', (c) => c.fallFromHigh !== null && c.fallFromHigh >= 20],
    ['not still falling*', (c) => c.stillFalling === false],
  ]],
  ['how much the market moved', [
    ['vol ratio >= 1', (c) => c.volatilityRatio !== null && c.volatilityRatio >= 1],
    ['vol ratio < 1', (c) => c.volatilityRatio !== null && c.volatilityRatio < 1],
    ['local vol >= 0.1%', (c) => c.localVolatility15mPercent !== null && c.localVolatility15mPercent >= 0.1],
    ['local vol < 0.1%', (c) => c.localVolatility15mPercent !== null && c.localVolatility15mPercent < 0.1],
    ['trend eff < 0.2', (c) => c.trendEfficiency !== null && c.trendEfficiency < 0.2],
    ['trend eff >= 0.2', (c) => c.trendEfficiency !== null && c.trendEfficiency >= 0.2],
    ['sign flip >= 0.5', (c) => c.signFlipRate !== null && c.signFlipRate >= 0.5],
  ]],
  ['regime', [
    ['regime trending', (c) => c.regime === 'trending'],
    ['regime mean-rev', (c) => c.regime === 'mean-reverting'],
    ['regime mixed', (c) => c.regime === 'mixed'],
  ]],
  ['the forecast model as a veto', [
    ['model >= ask', (c) => c.modelSideProbability !== null && c.modelSideProbability * 100 >= c.entryAskCents],
    ['model < ask', (c) => c.modelSideProbability !== null && c.modelSideProbability * 100 < c.entryAskCents],
    ['model >= 1.5x ask', (c) => c.modelSideProbability !== null && c.modelSideProbability * 100 >= 1.5 * c.entryAskCents],
  ]],
  ['side', [
    ['UP side only', (c) => c.side === 'UP'],
    ['DOWN side only', (c) => c.side === 'DOWN'],
  ]],
];

const signed = (value) => value === null ? '      —' : `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(3)}`;

function report(title, rows) {
  const base = evaluate(rows);
  console.log(`\n=== ${title} (n=${base.n}, ratio ${base.ratio.toFixed(2)}, return ${signed(base.mean)}) ===`);
  console.log('filter                   kept   keep%   touch%    b/e%   ratio    lift   return/$1      SE  windows');
  for (const [group, filters] of GROUPS) {
    if (group !== 'baseline') console.log(`-- ${group}`);
    for (const [label, predicate] of filters) {
      const kept = rows.filter(predicate);
      const result = evaluate(kept);
      if (!result || result.n < MINIMUM_KEPT) {
        console.log(`${label.padEnd(22)}${String(kept.length).padStart(7)}   (below the ${MINIMUM_KEPT}-candidate floor)`);
        continue;
      }
      console.log(
        `${label.padEnd(22)}${String(result.n).padStart(7)}${`${(100 * result.n / base.n).toFixed(0)}%`.padStart(8)}`
        + `${(100 * result.touchRate).toFixed(1).padStart(9)}${(100 * result.breakEven).toFixed(1).padStart(8)}`
        + `${result.ratio.toFixed(2).padStart(8)}${(result.ratio / base.ratio).toFixed(2).padStart(8)}`
        + `${signed(result.mean).padStart(12)}${(result.standardError ?? 0).toFixed(3).padStart(8)}${String(result.windows).padStart(9)}`,
      );
    }
  }
}

const wide = cohort(30);
const production = cohort(10);
console.log(`Exit held at ${EXIT}c throughout; this file varies the entry filter only.`);
console.log('* needs the next sample, so it delays entry and changes the fill rather than filtering at the tick.');
report('WIDE COHORT, entry <= 30c — where the filters are estimated', wide);
report('PRODUCTION BAND, entry <= 10c — where they have to survive', production);

/**
 * Assets, tested against the cohort mean rather than against zero. Against zero every asset looks
 * significant because the whole cohort loses money; the question is whether any asset differs from the
 * others, which is what an exclusion (§13) would have to rest on.
 */
console.log('\n=== ASSET BREAKDOWN, wide cohort ===');
{
  const base = evaluate(wide);
  console.log(`cohort mean return ${signed(base.mean)}. "z vs cohort" is (asset - cohort) / asset SE.`);
  console.log('symbol      n   touch%   ratio   return/$1      SE  z vs cohort');
  for (const symbol of [...new Set(wide.map((c) => c.symbol))].sort()) {
    const result = evaluate(wide.filter((c) => c.symbol === symbol));
    if (!result || result.n < MINIMUM_KEPT) continue;
    const z = result.standardError ? (result.mean - base.mean) / result.standardError : null;
    console.log(`${symbol.padEnd(8)}${String(result.n).padStart(5)}${(100 * result.touchRate).toFixed(1).padStart(9)}`
      + `${result.ratio.toFixed(2).padStart(8)}${signed(result.mean).padStart(12)}${(result.standardError ?? 0).toFixed(3).padStart(8)}`
      + `${(z === null ? '—' : z.toFixed(2)).padStart(13)}`);
  }
}

/**
 * Confound check on the strongest single filter.
 *
 * "Fell less than 10c from the window high" can mean "was always cheap" or merely "entered early, with
 * too few prior samples to have fallen from anything". Splitting on prior-sample count separates them.
 */
console.log('\n=== CONFOUND CHECK: "fell <10c from high" ===');
{
  const rows = wide.filter((candidate) => candidate.fallFromHigh !== null);
  const quiet = rows.filter((candidate) => candidate.fallFromHigh < 10);
  const rest = rows.filter((candidate) => candidate.fallFromHigh >= 10);
  const mean = (list, read) => list.length ? list.reduce((sum, item) => sum + read(item), 0) / list.length : NaN;
  const describe = (label, list) => console.log(`${label.padEnd(12)} n=${String(list.length).padStart(4)}  `
    + `mean prior samples ${mean(list, (c) => c.samplesBefore).toFixed(1)}  `
    + `mean entry ask ${mean(list, (c) => c.entryAskCents).toFixed(1)}c  `
    + `mean entry offset ${mean(list, (c) => c.entryOffset).toFixed(0)}s`);
  describe('kept', quiet);
  describe('rest', rest);
  const deepQuiet = quiet.filter((candidate) => candidate.samplesBefore > 2);
  console.log(`\nOf the kept cohort, ${deepQuiet.length} have more than two prior samples — the subset where`);
  console.log('"did not fall" is a real observation rather than an artifact of having nothing to fall from:');
  const result = evaluate(deepQuiet);
  if (result) {
    console.log(`  n=${result.n}, touch ${(100 * result.touchRate).toFixed(1)}%, ratio ${result.ratio.toFixed(2)}, `
      + `return ${signed(result.mean)} +/- ${(result.standardError ?? 0).toFixed(3)} over ${result.windows} windows, `
      + `mean entry ask ${mean(deepQuiet, (c) => c.entryAskCents).toFixed(1)}c`);
  }
  const lowVol = new Set(rows.filter((c) => c.localVolatility15mPercent !== null && c.localVolatility15mPercent < 0.1)
    .map((c) => `${c.symbol}|${c.closesAt}|${c.side}`));
  console.log(`\nOverlap of "fell <10c" with "local vol < 0.1%": ${quiet.filter((c) => lowVol.has(`${c.symbol}|${c.closesAt}|${c.side}`)).length} of ${quiet.length}.`);
  console.log('The movement filters are not independent tests; they are three readings of one idea.');
}
