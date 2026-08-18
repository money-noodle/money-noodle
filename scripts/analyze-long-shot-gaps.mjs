/**
 * Sweeps long-shot buy->sell *gaps* over recorded contract paths: entry bands x exit marks.
 *
 *   npm run analyze:long-shot-gaps
 *
 * WHAT IT MEASURES
 *   For every (contract, side) that became a long-shot candidate, the counterfactual round trip under a
 *   grid of entry bands and exit marks:
 *     - touch%  — the fraction that would have closed "sold at mark", i.e. whose owned-side bid reached
 *                 the exit strictly after the entry sample. This is the statistic under review.
 *     - b/e%    — the touch rate that configuration needs to break even if a miss paid zero.
 *     - ratio   — touch / break-even. Above 1.00 pays under that pessimistic accounting.
 *     - return  — return per $1 staked with misses graded at their real settlement, which is the honest
 *                 view: with no fallback exit a miss is not a total loss, it simply settles.
 *
 *   Entry is a **band**, not a cumulative mark, which is the difference from `analyze:long-shot-marks`.
 *   "Ask <= 40c" is dominated by 10c entries, so a cumulative 40->60 row does not describe buying at 40.
 *   Break-even is ~entry/exit, so the bar moves with the gap: 40->60 needs ~70%, 10->90 needs ~11%.
 *   "Wins more often than not" is only the right bar for gaps under 2x; `ratio` is what compares them.
 *
 * THE CORRECTION THAT DECIDES THE ANSWER
 *   Two, and they point opposite ways.
 *   1. Contracts sharing a settlement window share one coin flip, so returns are averaged within a
 *      `closesAt` first and the standard error is over windows, not rows (AGENTS §5.1). The exit
 *      comparison is additionally run **paired** on identical triggers, which removes window noise.
 *   2. Touch rates are floors: 15-second sampling cannot see a spike between samples. **No correction is
 *      applied.** The winner-coverage correction this file once used is withdrawn — see the block above
 *      `SAMPLING BLINDNESS` — because these contracts settle on a close-price comparison and 10.0% of
 *      winners are still bid below 90c fifteen seconds before close, so a winner need not have passed
 *      through the mark at all. Every `ratio` here is an uncorrected floor.
 *   The grid is 130+ cells. One cell above 1.00 is not evidence (§5.3); the flatness is the finding.
 *
 * BIASES
 *   - Settlement is authoritative, joined by symbol+closesAt to the resolved `outcome` in the forecast
 *     history. Sealed shards are read directly because this is a per-window join and the rollups carry
 *     `correct` counts rather than the settled side. Read-only; nothing here writes to `data/`.
 *   - Entry assumes a fill at the observed ask. Production submits a taker IOC capped at the mark, so a
 *     real entry can fail to fill; that reduces n rather than changing the rate.
 *   - Exit fee is the taker schedule, matching `runLongShotExits` -> `placeKalshiSell`.
 *   - Fee and fill sizing are reproduced from `venueFeeCents` / `estimatePaperFill`, so a change to
 *     either invalidates this file rather than silently drifting from production.
 *   - Only a small minority of windows carry the 1s dense sampling added 2026-08-16, and only from the
 *     moment a contract became a candidate. The header prints the count. Because no correction is applied,
 *     that small sample now bounds only what can be *said* about the floor, not the numbers themselves.
 */
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');
/** The production opening ticket. Return per $1 staked is scale-invariant apart from fee rounding. */
const TICKET_CENTS = 20;
/** `minimumSecondsRemaining`. */
const WINDOW_SECONDS = 600;
const CYCLE_SECONDS = 900;
/** `maximumOpenPerSettlementWindow`. */
const MAX_OPEN_PER_WINDOW = 3;

const BANDS = [[0, 5], [5, 10], [10, 15], [15, 20], [20, 25], [25, 30], [30, 35], [35, 40], [40, 45], [45, 49]];
const EXITS = [15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
/** Enough entries in a band for a rate to mean anything at all. Not a significance bar. */
const MINIMUM_BAND = 10;

async function loadPaths() {
  const records = [];
  const active = path.join(DATA, 'contract-paths.json');
  if (existsSync(active)) {
    const parsed = JSON.parse(await readFile(active, 'utf8'));
    for (const record of parsed.active ?? []) {
      records.push({ contractId: record.contractId, symbol: record.symbol, closesAt: record.closesAt, points: record.points });
    }
  }
  const journal = path.join(DATA, 'contract-paths.journal.jsonl');
  if (existsSync(journal)) {
    const stream = readline.createInterface({ input: createReadStream(journal) });
    for await (const line of stream) {
      if (!line.trim()) continue;
      try {
        const [contractId, symbol, closesAt, points] = JSON.parse(line);
        records.push({ contractId, symbol, closesAt, points: points.map(([o, u, d]) => ({ o, u, d })) });
      } catch { /* a damaged line is skipped rather than failing the whole read */ }
    }
  }
  // The journal can hold a window more than once; the longest path per contract wins.
  const byId = new Map();
  for (const record of records) {
    const key = `${record.contractId}:${record.closesAt}`;
    const existing = byId.get(key);
    if (!existing || record.points.length > existing.points.length) byId.set(key, record);
  }
  return [...byId.values()].map((record) => ({ ...record, points: [...record.points].sort((a, b) => a.o - b.o) }));
}

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
      const parsed = JSON.parse(await readFile(path.join(shards, file), 'utf8'));
      absorb(Array.isArray(parsed) ? parsed : parsed.entries ?? []);
    }
  }
  const open = path.join(DATA, 'forecast-history.json');
  if (existsSync(open)) {
    const parsed = JSON.parse(await readFile(open, 'utf8'));
    absorb(Array.isArray(parsed) ? parsed : parsed.entries ?? []);
  }
  return outcomes;
}

/** `venueFeeCents('kalshi', priceCents, quantity, 'taker')`, whole cents, rounded up, 1c floor. */
const feeCents = (priceCents, quantity) =>
  Math.max(1, Math.ceil(100 * quantity * 0.07 * (priceCents / 100) * (1 - priceCents / 100) - 1e-9));

/** `estimatePaperFill(stakeLimitCents, ask, 'kalshi')`: 0.01 steps, largest fitting the all-in cap. */
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
const OUTCOMES = await loadOutcomes();

/**
 * First qualifying entry whose ask falls inside `(lowCents, highCents]`, one per contract and side, with
 * production's position limits applied: one open per asset and settlement window, at most three open per
 * settlement window, earliest entry winning.
 */
function band(lowCents, highCents) {
  const all = [];
  for (const record of records) {
    const outcome = OUTCOMES.get(`${record.symbol}|${record.closesAt}`) ?? null;
    for (const side of ['UP', 'DOWN']) {
      const ask = (point) => (side === 'UP' ? point.u : point.d);
      // bid(side) = 100 - ask(other side) on Kalshi's shared book (`sideBidCents`).
      const bid = (point) => (side === 'UP' ? 100 - point.d : 100 - point.u);
      const index = record.points.findIndex((point) =>
        ask(point) > lowCents && ask(point) <= highCents && CYCLE_SECONDS - point.o >= WINDOW_SECONDS);
      if (index < 0) continue;
      let peak = null;
      for (const point of record.points.slice(index + 1)) {
        const value = bid(point);
        if (peak === null || value > peak) peak = value;
      }
      if (peak === null) continue;
      all.push({
        symbol: record.symbol, closesAt: record.closesAt, entryAskCents: ask(record.points[index]),
        peakBidCents: peak, entryOffset: record.points[index].o,
        won: outcome === null ? null : outcome === side,
      });
    }
  }
  all.sort((left, right) => left.entryOffset - right.entryOffset);
  const perAsset = new Set();
  const perWindow = new Map();
  const capped = [];
  for (const candidate of all) {
    const key = `${candidate.symbol}:${candidate.closesAt}`;
    if (perAsset.has(key)) continue;
    const open = perWindow.get(candidate.closesAt) ?? 0;
    if (open >= MAX_OPEN_PER_WINDOW) continue;
    perAsset.add(key);
    perWindow.set(candidate.closesAt, open + 1);
    capped.push(candidate);
  }
  return capped;
}

/** Averaged within a settlement window, then across windows; the standard error is over windows. */
function clustered(rows) {
  const windows = new Map();
  for (const row of rows) windows.set(row.closesAt, [...(windows.get(row.closesAt) ?? []), row.value]);
  const perWindow = [...windows.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
  if (!perWindow.length) return { mean: null, standardError: null, windows: 0 };
  const mean = perWindow.reduce((sum, value) => sum + value, 0) / perWindow.length;
  return {
    mean,
    standardError: perWindow.length > 1
      ? Math.sqrt(perWindow.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (perWindow.length - 1) / perWindow.length)
      : null,
    windows: perWindow.length,
  };
}

const roundTripReturn = (candidate, sized, exitMarkCents) => {
  const proceeds = sized.quantity * exitMarkCents - feeCents(exitMarkCents, sized.quantity);
  if (candidate.peakBidCents >= exitMarkCents) return (proceeds - sized.stake) / sized.stake;
  return ((candidate.won ? sized.quantity * 100 : 0) - sized.stake) / sized.stake;
};
const holdReturn = (candidate, sized) => ((candidate.won ? sized.quantity * 100 : 0) - sized.stake) / sized.stake;

function cell(cohort, exitMarkCents) {
  let touched = 0, used = 0, breakEvenSum = 0;
  const returns = [];
  for (const candidate of cohort) {
    const sized = fill(TICKET_CENTS, candidate.entryAskCents);
    if (!sized) continue;
    const proceeds = sized.quantity * exitMarkCents - feeCents(exitMarkCents, sized.quantity);
    if (proceeds <= 0) continue;
    used += 1;
    breakEvenSum += sized.stake / proceeds;
    if (candidate.peakBidCents >= exitMarkCents) touched += 1;
    if (candidate.peakBidCents >= exitMarkCents || candidate.won !== null) {
      returns.push({ closesAt: candidate.closesAt, value: roundTripReturn(candidate, sized, exitMarkCents) });
    }
  }
  if (!used) return null;
  const touchRate = touched / used;
  const breakEven = breakEvenSum / used;
  return { n: used, touched, touchRate, breakEven, ratio: touchRate / breakEven, ...clustered(returns) };
}

const cohorts = new Map(BANDS.map(([low, high]) => [`${low}-${high}`, band(low, high)]));
const dense = records.filter((record) => record.points.some((point, index) => index > 0 && point.o - record.points[index - 1].o < 15));
const joined = records.filter((record) => OUTCOMES.has(`${record.symbol}|${record.closesAt}`)).length;
const closes = records.map((record) => record.closesAt).sort();
console.log(`windows ${records.length}, ${joined} joined to an authoritative settlement, ${dense.length} with 1s dense sampling`);
console.log(`span ${closes[0]} .. ${closes[closes.length - 1]}\n`);

/**
 * WITHDRAWN: the winner-coverage correction, and why.
 *
 * An earlier version of this file corrected every touch rate by the fraction of contracts that settled in
 * the money and were *observed* reaching each mark, on the premise that each of them passed through every
 * mark below 100c on its way there, so the shortfall had to be the sampler's blindness. That premise is
 * false, and §14a's 68.4%/1.36x figure rests on the same one.
 *
 * These contracts settle on a price comparison at the close. The move to 100c happens AT settlement, not
 * through the book: measured over 1,033 resolved windows with a sample inside the last 30 seconds, the
 * winning side's final bid was **below 90c in 10.0% of cases**, and below 10c in 0.8%. A contract can
 * trade at 25c with fifteen seconds left and still settle in the money. So "observed reaching 90c" is not
 * a coverage measure; it conflates sampling blindness with a discontinuity that no sampling rate can see.
 *
 * `DECIMATION` below is the replacement: the same dense paths decimated to a 15-second grid, which is a
 * like-for-like read with no premise about what winners must have done. It is printed rather than applied,
 * because it is unstable (see the note in its output) and n is small. **No correction is applied to any
 * ratio in this file.** The `ratio` columns are uncorrected and are floors.
 */
{
  const decimate = (record) => {
    const seen = new Set(); const points = [];
    for (const point of record.points) {
      const bucket = Math.floor(point.o / 15);
      if (seen.has(bucket)) continue;
      seen.add(bucket); points.push(point);
    }
    return { ...record, points };
  };
  const touchRate = (list, maxAskCents, markCents) => {
    let n = 0, touched = 0;
    for (const record of list) {
      for (const side of ['UP', 'DOWN']) {
        const ask = (point) => (side === 'UP' ? point.u : point.d);
        const bid = (point) => (side === 'UP' ? 100 - point.d : 100 - point.u);
        const index = record.points.findIndex((point) =>
          ask(point) > 0 && ask(point) <= maxAskCents && CYCLE_SECONDS - point.o >= WINDOW_SECONDS);
        if (index < 0) continue;
        const after = record.points.slice(index + 1);
        if (!after.length) continue;
        n += 1;
        if (Math.max(...after.map(bid)) >= markCents) touched += 1;
      }
    }
    return { n, touched };
  };
  console.log(`=== SAMPLING BLINDNESS, dense (1s) vs the same paths decimated to 15s (n=${dense.length} windows) ===`);
  console.log('The winner-coverage correction is withdrawn; see the comment above. This is the replacement,');
  console.log('reported but NOT applied: at <=10c entry the decimation also changes which candidates qualify,');
  console.log('so those rows are unstable and should not be read as a correction factor.');
  console.log('entry  mark   n   dense%  coarse%   implied');
  for (const maxAskCents of [10, 20, 30]) {
    for (const markCents of [30, 50, 70, 90, 95]) {
      const denseRate = touchRate(dense, maxAskCents, markCents);
      const coarseRate = touchRate(dense.map(decimate), maxAskCents, markCents);
      if (denseRate.n < 10 || !coarseRate.n) continue;
      const implied = coarseRate.touched > 0
        ? `${((denseRate.touched / denseRate.n) / (coarseRate.touched / coarseRate.n)).toFixed(2)}x` : 'n/a';
      console.log(`${String(maxAskCents).padStart(4)}c ${String(markCents).padStart(4)}c${String(denseRate.n).padStart(5)}`
        + `${(100 * denseRate.touched / denseRate.n).toFixed(1).padStart(9)}${(100 * coarseRate.touched / coarseRate.n).toFixed(1).padStart(9)}`
        + `${implied.padStart(10)}${maxAskCents === 10 ? '   <- unstable' : ''}`);
    }
  }
}

function matrix(title, note, valueFor) {
  console.log(`\n=== ${title} ===`);
  console.log(note);
  process.stdout.write('entry band    n  ');
  for (const exit of EXITS) process.stdout.write(String(exit).padStart(5));
  process.stdout.write('\n');
  for (const [low, high] of BANDS) {
    const cohort = cohorts.get(`${low}-${high}`);
    process.stdout.write(`${`${low + 1}-${high}c`.padEnd(9)}${String(cohort.length).padStart(5)}  `);
    for (const exit of EXITS) {
      // An exit at or below the band's own top is not a round trip.
      if (exit <= high || cohort.length < MINIMUM_BAND) { process.stdout.write('    —'); continue; }
      const result = cell(cohort, exit);
      process.stdout.write(result ? valueFor(result, exit).padStart(5) : '    —');
    }
    process.stdout.write('\n');
  }
}

matrix('TOUCH RATE BY GAP', 'Percent of entries in the band whose bid later reached the exit mark.',
  (result) => (100 * result.touchRate).toFixed(0));
matrix('RATIO BY GAP', 'touch / break-even. Above 1.00 pays if a miss were a total loss.',
  (result) => result.ratio.toFixed(2));

console.log('\n=== BEST GAP PER BAND, by clustered return per $1 staked ===');
console.log('`hold` is the same triggers never sold — approach (ii). An exit has to beat that, not beat zero.');
console.log('band        n   exit    gap   touch%    b/e%   ratio   return/$1      SE  windows    hold/$1');
for (const [low, high] of BANDS) {
  const cohort = cohorts.get(`${low}-${high}`);
  if (cohort.length < MINIMUM_BAND) { console.log(`${`${low + 1}-${high}c`.padEnd(9)}${String(cohort.length).padStart(5)}   (below the ${MINIMUM_BAND}-entry floor)`); continue; }
  let best = null;
  for (const exit of EXITS) {
    if (exit <= high) continue;
    const result = cell(cohort, exit);
    if (result?.mean !== null && result !== null && (!best || result.mean > best.result.mean)) best = { exit, result };
  }
  if (!best) continue;
  const holdRows = [];
  let askSum = 0, askCount = 0;
  for (const candidate of cohort) {
    const sized = fill(TICKET_CENTS, candidate.entryAskCents);
    if (!sized) continue;
    askSum += candidate.entryAskCents; askCount += 1;
    if (candidate.won !== null) holdRows.push({ closesAt: candidate.closesAt, value: holdReturn(candidate, sized) });
  }
  const hold = clustered(holdRows);
  const { result, exit } = best;
  const signed = (value) => value === null ? '      —' : `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(3)}`;
  console.log(
    `${`${low + 1}-${high}c`.padEnd(9)}${String(result.n).padStart(5)}  ${`${exit}c`.padStart(5)}  `
    + `${`${(exit / (askSum / askCount)).toFixed(1)}x`.padStart(5)}  ${(100 * result.touchRate).toFixed(1).padStart(6)}  `
    + `${(100 * result.breakEven).toFixed(1).padStart(6)}  ${result.ratio.toFixed(2).padStart(6)}   ${signed(result.mean).padStart(8)}  `
    + `${(result.standardError ?? 0).toFixed(3).padStart(6)}  ${String(result.windows).padStart(7)}   ${signed(hold.mean).padStart(8)}`,
  );
}

/**
 * The exit question, paired on identical triggers.
 *
 * Every alternative is scored on the same entries as the production exit, so the window-level noise that
 * dominates the unpaired standard errors cancels. This is the comparison AGENTS §5.4 asks for: a
 * candidate must beat the live rule, not beat doing nothing.
 */
const PRODUCTION_ENTRY_TOP = 10;
const PRODUCTION_EXIT = 90;
console.log(`\n=== EXIT ALTERNATIVES, PAIRED against the live ${PRODUCTION_EXIT}c mark ===`);
{
  // Built as one cumulative cohort rather than by concatenating bands: the per-window cap has to be
  // applied once over the whole live entry rule, or two separately-capped bands can exceed it together.
  const cohort = band(0, PRODUCTION_ENTRY_TOP)
    .filter((candidate) => candidate.won !== null)
    .map((candidate) => ({ ...candidate, sized: fill(TICKET_CENTS, candidate.entryAskCents) }))
    .filter((candidate) => candidate.sized);
  const windows = new Set(cohort.map((candidate) => candidate.closesAt)).size;
  console.log(`${cohort.length} triggers at or below ${PRODUCTION_ENTRY_TOP}c across ${windows} settlement windows.\n`);
  console.log('alternative      mean diff      SE       t');
  const report = (label, valueFor) => {
    const diff = clustered(cohort.map((candidate) => ({
      closesAt: candidate.closesAt,
      value: valueFor(candidate) - roundTripReturn(candidate, candidate.sized, PRODUCTION_EXIT),
    })));
    const t = diff.standardError ? diff.mean / diff.standardError : null;
    console.log(`${label.padEnd(15)}${`${diff.mean >= 0 ? '+' : '-'}${Math.abs(diff.mean).toFixed(3)}`.padStart(10)}`
      + `${(diff.standardError ?? 0).toFixed(3).padStart(8)}${(t === null ? '—' : t.toFixed(2)).padStart(8)}`);
  };
  for (const exit of EXITS.filter((value) => value !== PRODUCTION_EXIT && value > PRODUCTION_ENTRY_TOP)) {
    report(`sell at ${exit}c`, (candidate) => roundTripReturn(candidate, candidate.sized, exit));
  }
  report('never sell', (candidate) => holdReturn(candidate, candidate.sized));
}

/**
 * What the exit mark does to the winners, counted rather than inferred.
 *
 * Every contract that settles in the money passes through every mark below 100c, so a lower exit does not
 * only shrink the payoff on a touch — it sells the eventual winners first, converting a settlement at 100c
 * into a round trip at the mark. This is the mechanism behind the paired differences above.
 */
console.log(`\n=== WHAT THE EXIT MARK DOES TO THE WINNERS (entry <= ${PRODUCTION_ENTRY_TOP}c, production caps) ===`);
{
  const cohort = band(0, PRODUCTION_ENTRY_TOP).filter((candidate) => fill(TICKET_CENTS, candidate.entryAskCents));
  const winners = cohort.filter((candidate) => candidate.won === true);
  const losers = cohort.filter((candidate) => candidate.won === false);
  console.log(`${cohort.length} entries: ${winners.length} settled in the money, ${losers.length} did not.\n`);
  console.log('exit   sold at mark   as % of cohort   winners sold   losers rescued');
  for (const exit of EXITS) {
    if (exit <= PRODUCTION_ENTRY_TOP) continue;
    const soldWinners = winners.filter((candidate) => candidate.peakBidCents >= exit).length;
    const soldLosers = losers.filter((candidate) => candidate.peakBidCents >= exit).length;
    console.log(
      `${`${exit}c`.padStart(5)}${String(soldWinners + soldLosers).padStart(15)}`
      + `${`${(100 * (soldWinners + soldLosers) / cohort.length).toFixed(1)}%`.padStart(17)}`
      + `${`${soldWinners}/${winners.length}`.padStart(15)}${`${soldLosers}/${losers.length}`.padStart(17)}`,
    );
  }
}
